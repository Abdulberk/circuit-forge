/**
 * Simulation Job Processor
 * BullMQ processor for handling simulation jobs
 */
import { Job, Worker } from 'bullmq';
import Redis from 'ioredis';
import { prisma } from '../prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import { runSimulation, type SimulationJobResult } from './runner';
import { runMonteCarloBatch } from './montecarlo-runner';
import { runCornerBatch } from './corner-runner';
import { runTempCornerBatch } from './temp-corner-runner';
import { runSupplyCornerBatch } from './supply-corner-runner';
import { classifyJobOutcome, isFinalAttempt, deriveFailureStatus, buildFailureMetrics, buildSuccessMetrics } from './outcome';
import { downloadFile, uploadJsonResult } from '../storage/s3-client';
import { downsampleResult } from '@circuit-forge/eda-core';
import type { CircuitJson, AnalysisConfig, AcceptanceCriterion, CornerSpec, TempCornerSpec, SupplyCornerSpec } from '@circuit-forge/eda-core';
import { Prisma } from '@prisma/client';
import { recordSim } from '../observability/telemetry';
import { propagation, context as otelContext, trace, SpanStatusCode } from '@opentelemetry/api';

/**
 * Thrown to push an INFRA failure back to BullMQ for retry (or final failure). By the time it's thrown,
 * the terminal-DB decision is already made — persisted on the final attempt, deliberately skipped while
 * retries remain — so the catch block must only PROPAGATE it, never write the row a second time.
 */
class RetryableInfraError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RetryableInfraError';
    }
}

/**
 * Job payload from the queue
 */
export interface SimulationJobPayload {
    jobId: string;
    orgId: string;
    netlist: string;
    probeNames: string[];
    analysisType: string;
    analysisConfig: Record<string, unknown>;
    modelAssets?: string[]; // S3 keys
    /** W3C trace context injected by the API at enqueue — links this job's span to the request that
     *  created it, so a verify-design / simulate trace spans API → queue → worker end-to-end. */
    otel?: Record<string, string>;
    /** Batch robustness job (skips the normal single-sim path): 'monte-carlo' = N random tolerance draws →
     *  yield (handleMonteCarlo); 'corner' = the 2^k deterministic ±tol corners → worst-case (handleCorner);
     *  'temp-corner' = ambient cold/room/hot re-evaluation + metric drift (handleTempCorner);
     *  'supply-corner' = each power rail's source perturbed ±tol → spec + rail drift (handleSupplyCorner). All are
     *  informational robustness signals — never a design failure. */
    mode?: 'monte-carlo' | 'corner' | 'temp-corner' | 'supply-corner';
    montecarlo?: {
        circuit: CircuitJson;
        analysis: AnalysisConfig;
        criteria: AcceptanceCriterion[];
        n?: number;
        seed?: number;
    };
    corner?: {
        circuit: CircuitJson;
        analysis: AnalysisConfig;
        criteria: AcceptanceCriterion[];
        spec: CornerSpec;
    };
    tempCorner?: {
        circuit: CircuitJson;
        analysis: AnalysisConfig;
        criteria: AcceptanceCriterion[];
        spec: TempCornerSpec;
    };
    supplyCorner?: {
        circuit: CircuitJson;
        analysis: AnalysisConfig;
        criteria: AcceptanceCriterion[];
        spec: SupplyCornerSpec;
    };
}

/**
 * Create the simulation worker
 */
export function createSimulationWorker(): Worker {
    const connection = new Redis(config.REDIS_URL, {
        maxRetriesPerRequest: null,
    });

    const worker = new Worker<SimulationJobPayload>(
        config.QUEUE_NAME,
        async (job: Job<SimulationJobPayload>) => {
            return processJob(job);
        },
        {
            connection,
            concurrency: config.CONCURRENCY,
        },
    );

    worker.on('completed', (job) => {
        logger.info({ jobId: job.data.jobId }, 'Job completed');
    });

    worker.on('failed', (job, err) => {
        logger.error({ jobId: job?.data.jobId, error: err.message }, 'Job failed');
    });

    worker.on('error', (err) => {
        logger.error({ error: err.message }, 'Worker error');
    });

    logger.info({ queue: config.QUEUE_NAME, concurrency: config.CONCURRENCY }, 'Simulation worker started');

    return worker;
}

/**
 * Process a single simulation job
 */
async function processJob(job: Job<SimulationJobPayload>): Promise<void> {
    const { jobId, orgId, netlist, probeNames, analysisType, modelAssets } = job.data;

    // Is this the LAST attempt BullMQ will run? Drives WHEN it's safe to write a terminal FAILED row:
    // while retries remain we leave the row RUNNING so a poll mid-retry keeps waiting (never a premature
    // 'inconclusive'). `attempts` is undefined for a job enqueued before retries were configured →
    // treated as final → behaves exactly like the legacy no-retry path.
    const finalAttempt = isFinalAttempt(job.attemptsMade, job.opts.attempts);

    logger.info(
        { jobId, orgId, attempt: job.attemptsMade + 1, attempts: job.opts.attempts ?? 1 },
        'Processing simulation job',
    );

    // Link this worker span to the API request that enqueued the job (context propagated via
    // job.data.otel) so Tempo shows ONE trace: HTTP → enqueue → worker process, with the Prisma queries
    // and the ngspice run window as children. Falls back to a fresh root span when no context was passed.
    const parentCtx = propagation.extract(otelContext.active(), job.data.otel ?? {});
    const tracer = trace.getTracer('circuit-forge-worker');

    await tracer.startActiveSpan(
        'sim.process',
        { attributes: { 'sim.job_id': jobId, 'sim.org_id': orgId, 'sim.analysis_type': analysisType } },
        parentCtx,
        async (span) => {
            try {
                // Update job status to RUNNING
                await prisma.simulationJob.update({
                    where: { id: jobId },
                    data: {
                        status: 'RUNNING',
                        startedAt: new Date(),
                    },
                });

                // Download model files if needed
                const modelFiles: Array<{ name: string; content: Buffer }> = [];
                if (modelAssets && modelAssets.length > 0) {
                    for (const s3Key of modelAssets) {
                        const content = await downloadFile(s3Key);
                        const name = s3Key.split('/').pop() || 'model.lib';
                        modelFiles.push({ name, content });
                        logger.debug({ s3Key, name }, 'Model file downloaded');
                    }
                }

                // Monte-Carlo YIELD job: run N perturbed variants locally + aggregate, instead of one sim.
                // Informational only — persisted SUCCEEDED with metrics.monteCarlo (or FAILED+infra → the API
                // reports "yield unavailable"); never retried, never a design failure.
                if (job.data.mode === 'monte-carlo' && job.data.montecarlo) {
                    await handleMonteCarlo(job, modelFiles.length > 0 ? modelFiles : undefined);
                    span.setAttribute('sim.outcome', 'montecarlo');
                    span.setStatus({ code: SpanStatusCode.OK });
                    return;
                }

                // Worst-case CORNER job: evaluate the criteria at the 2^k deterministic ±tol corners, instead of
                // one sim. Same posture as Monte-Carlo — persisted SUCCEEDED with metrics.worstCase (or FAILED+
                // infra → inconclusive); never retried, never a design failure.
                if (job.data.mode === 'corner' && job.data.corner) {
                    await handleCorner(job, modelFiles.length > 0 ? modelFiles : undefined);
                    span.setAttribute('sim.outcome', 'worstcase');
                    span.setStatus({ code: SpanStatusCode.OK });
                    return;
                }

                // Ambient TEMPERATURE-CORNER job: re-evaluate the criteria + capture per-node metric drift across
                // the profile's cold/room/hot set. Same posture as the other robustness batches — persisted
                // SUCCEEDED with metrics.tempCorner (or FAILED+infra → inconclusive); informational, never gates.
                if (job.data.mode === 'temp-corner' && job.data.tempCorner) {
                    await handleTempCorner(job, modelFiles.length > 0 ? modelFiles : undefined);
                    span.setAttribute('sim.outcome', 'tempcorner');
                    span.setStatus({ code: SpanStatusCode.OK });
                    return;
                }

                // SUPPLY-VOLTAGE corner job: perturb each trusted power rail's driving source ±tolerance and report
                // spec pass/fail + per-node drift. Same posture — persisted SUCCEEDED with metrics.supplyCorner (or
                // FAILED+infra → inconclusive); informational, never gates.
                if (job.data.mode === 'supply-corner' && job.data.supplyCorner) {
                    await handleSupplyCorner(job, modelFiles.length > 0 ? modelFiles : undefined);
                    span.setAttribute('sim.outcome', 'supplycorner');
                    span.setStatus({ code: SpanStatusCode.OK });
                    return;
                }

                // Run the simulation
                const result = await runSimulation({
                    jobId,
                    netlist,
                    probeNames,
                    analysisType,
                    modelFiles: modelFiles.length > 0 ? modelFiles : undefined,
                });

                // Decide what the result means for the queue (pure logic in outcome.ts).
                const action = classifyJobOutcome(result, finalAttempt);
                switch (action.type) {
                    case 'success':
                        await handleSuccess(jobId, result);
                        span.setAttribute('sim.outcome', 'succeeded');
                        span.setStatus({ code: SpanStatusCode.OK });
                        break;
                    case 'fault':
                        // Genuine, deterministic sim fault (ngspice ran and rejected the deck, or timed
                        // out): persist terminal FAILED/TIMED_OUT and finish normally. Never retried —
                        // re-running a deterministically-bad circuit just wastes a slot.
                        await handleFailure(jobId, result);
                        span.setAttribute('sim.outcome', 'failed');
                        span.setStatus({ code: SpanStatusCode.OK });
                        break;
                    case 'terminal-infra':
                        // Infra failure, retries exhausted: persist the rich FAILED+infra row, THEN throw
                        // so BullMQ finalizes the job as failed. RetryableInfraError tells the catch block
                        // the DB write is already done — don't persist twice. The API maps FAILED+infra →
                        // 'inconclusive', never a design failure.
                        await handleFailure(jobId, result);
                        span.setAttribute('sim.outcome', 'failed');
                        throw new RetryableInfraError(result.error ?? 'simulation infrastructure failure');
                    case 'retry':
                        // Infra failure with retries remaining: DON'T write a terminal status (the row
                        // stays RUNNING so a poll mid-retry keeps waiting); throw so BullMQ schedules the
                        // retry. No recordSim — a pending retry is not a failed run yet.
                        span.setAttribute('sim.outcome', 'retry');
                        logger.warn(
                            { jobId, attempt: job.attemptsMade + 1, error: result.error },
                            'Infra failure — will retry',
                        );
                        throw new RetryableInfraError(
                            result.error ?? 'simulation infrastructure failure (will retry)',
                        );
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                span.recordException(error instanceof Error ? error : new Error(errorMessage));
                span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });

                // The controlled infra path above (terminal-infra / retry) already decided the terminal-DB
                // write — persisted on the final attempt, deliberately skipped while retries remain. Just
                // propagate so BullMQ retries or finalizes; never double-write the row.
                if (error instanceof RetryableInfraError) {
                    logger.error({ jobId, error: errorMessage }, 'Job processing infra failure');
                    throw error;
                }

                // Otherwise an UNEXPECTED throw escaped the runner result path — S3 model download, the
                // RUNNING/DB update, or a result upload on an otherwise-successful sim. These are
                // INFRASTRUCTURE failures, not circuit faults, so tag failureClass='infra' (status stays
                // FAILED — no operational enum value); the API maps it to an 'inconclusive' verify verdict
                // rather than telling the user their design failed. Persist the terminal FAILED row ONLY
                // on the final attempt (so a poll during a retry window sees RUNNING, never a premature
                // 'inconclusive'); on earlier attempts leave the row as-is and let BullMQ retry.
                logger.error({ jobId, error: errorMessage }, 'Job processing error');
                if (finalAttempt) {
                    recordSim({ status: 'failed' });
                    await prisma.simulationJob.update({
                        where: { id: jobId },
                        data: {
                            status: 'FAILED',
                            stderr: errorMessage,
                            finishedAt: new Date(),
                            metrics: {
                                error: errorMessage,
                                failureClass: 'infra',
                            },
                        },
                    });
                }

                throw error;
            } finally {
                span.end();
            }
        },
    );
}

/**
 * Handle a Monte-Carlo YIELD job: run the batch locally (N perturbed variants) and persist the aggregate
 * yield + Wilson CI in metrics.monteCarlo. Informational — runMonteCarloBatch never throws on a sim fault
 * (a dead ngspice just yields all-errored → evaluated 0 → the API reports "yield unavailable"); the catch is
 * a defensive net that persists FAILED+infra so the API treats it as inconclusive, never a design failure.
 * Not retried (MC is best-effort, not part of the verified verdict).
 */
async function handleMonteCarlo(
    job: Job<SimulationJobPayload>,
    modelFiles?: Array<{ name: string; content: Buffer }>,
): Promise<void> {
    const { jobId } = job.data;
    const mc = job.data.montecarlo!;
    try {
        const summary = await runMonteCarloBatch(
            { jobId, circuit: mc.circuit, analysis: mc.analysis, criteria: mc.criteria, n: mc.n, seed: mc.seed, modelFiles },
            // Checkpoint progress so a mid-batch death surfaces how far it got (best-effort; ignore errors).
            (ran) => void job.updateProgress({ ran }).catch(() => undefined),
        );
        recordSim({ status: 'succeeded', durationMs: summary.runtimeMs });
        await prisma.simulationJob.update({
            where: { id: jobId },
            data: {
                status: 'SUCCEEDED',
                finishedAt: new Date(),
                metrics: {
                    runtimeMs: summary.runtimeMs,
                    monteCarlo: {
                        yield: summary.yield,
                        ci95: summary.ci95,
                        total: summary.total,
                        evaluated: summary.evaluated,
                        passed: summary.passed,
                        failed: summary.failed,
                        errored: summary.errored,
                        ran: summary.ran,
                        stoppedEarly: summary.stoppedEarly,
                        budgetHit: summary.budgetHit,
                    },
                } as unknown as Prisma.InputJsonValue,
            },
        });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ jobId, error: msg }, 'Monte-Carlo batch failed');
        recordSim({ status: 'failed' });
        await prisma.simulationJob.update({
            where: { id: jobId },
            data: {
                status: 'FAILED',
                finishedAt: new Date(),
                metrics: { error: msg, failureClass: 'infra' } as unknown as Prisma.InputJsonValue,
            },
        });
    }
}

/**
 * Worst-case corner job: evaluate the acceptance criteria at the 2^k deterministic ±tolerance corners and
 * persist the result in metrics.worstCase. Same contract as handleMonteCarlo — informational, never retried,
 * never a design failure; runCornerBatch never throws on a sim fault (a dead corner is counted `errored`), so
 * the catch is a defensive net that persists FAILED+infra → the API treats it as inconclusive.
 */
async function handleCorner(
    job: Job<SimulationJobPayload>,
    modelFiles?: Array<{ name: string; content: Buffer }>,
): Promise<void> {
    const { jobId } = job.data;
    const wc = job.data.corner!;
    try {
        const result = await runCornerBatch({ jobId, circuit: wc.circuit, analysis: wc.analysis, criteria: wc.criteria, corner: wc.spec, modelFiles });
        recordSim({ status: 'succeeded', durationMs: result.runtimeMs });
        await prisma.simulationJob.update({
            where: { id: jobId },
            data: {
                status: 'SUCCEEDED',
                finishedAt: new Date(),
                metrics: {
                    runtimeMs: result.runtimeMs,
                    worstCase: {
                        componentsCornered: result.componentsCornered,
                        omitted: result.omitted,
                        evaluated: result.evaluated,
                        passed: result.passed,
                        failed: result.failed,
                        errored: result.errored,
                        passAllCorners: result.passAllCorners,
                        worstCorners: result.worstCorners,
                    },
                } as unknown as Prisma.InputJsonValue,
            },
        });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ jobId, error: msg }, 'Worst-case corner batch failed');
        recordSim({ status: 'failed' });
        await prisma.simulationJob.update({
            where: { id: jobId },
            data: {
                status: 'FAILED',
                finishedAt: new Date(),
                metrics: { error: msg, failureClass: 'infra' } as unknown as Prisma.InputJsonValue,
            },
        });
    }
}

/**
 * Ambient temperature-corner job: re-evaluate the criteria and capture per-node metric drift across the profile's
 * cold/room/hot set, persisting the result in metrics.tempCorner. Same contract as handleCorner — informational,
 * never retried, never a design failure; runTempCornerBatch never throws on a sim fault (a dead temperature is
 * counted `errored`), so the catch is a defensive net that persists FAILED+infra → the API treats it inconclusive.
 */
async function handleTempCorner(
    job: Job<SimulationJobPayload>,
    modelFiles?: Array<{ name: string; content: Buffer }>,
): Promise<void> {
    const { jobId } = job.data;
    const tc = job.data.tempCorner!;
    try {
        const result = await runTempCornerBatch({ jobId, circuit: tc.circuit, analysis: tc.analysis, criteria: tc.criteria, spec: tc.spec, modelFiles });
        recordSim({ status: 'succeeded', durationMs: result.runtimeMs });
        await prisma.simulationJob.update({
            where: { id: jobId },
            data: {
                status: 'SUCCEEDED',
                finishedAt: new Date(),
                metrics: {
                    runtimeMs: result.runtimeMs,
                    tempCorner: {
                        applicable: result.applicable,
                        notApplicableReason: result.notApplicableReason,
                        temperaturesC: result.temperaturesC,
                        rangeLabel: result.rangeLabel,
                        evaluated: result.evaluated,
                        passed: result.passed,
                        failed: result.failed,
                        errored: result.errored,
                        hasLimits: result.hasLimits,
                        passAllTemps: result.passAllTemps,
                        drift: result.drift,
                    },
                } as unknown as Prisma.InputJsonValue,
            },
        });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ jobId, error: msg }, 'Temperature-corner batch failed');
        recordSim({ status: 'failed' });
        await prisma.simulationJob.update({
            where: { id: jobId },
            data: {
                status: 'FAILED',
                finishedAt: new Date(),
                metrics: { error: msg, failureClass: 'infra' } as unknown as Prisma.InputJsonValue,
            },
        });
    }
}

/**
 * Supply-voltage corner job: perturb each trusted power rail's driving source ±tolerance, evaluate the criteria,
 * and capture per-node drift, persisting the result in metrics.supplyCorner. Same contract as handleTempCorner —
 * informational, never retried, never a design failure; runSupplyCornerBatch never throws on a sim fault (a dead
 * corner is `errored`), so the catch is a defensive net that persists FAILED+infra → the API treats it inconclusive.
 */
async function handleSupplyCorner(
    job: Job<SimulationJobPayload>,
    modelFiles?: Array<{ name: string; content: Buffer }>,
): Promise<void> {
    const { jobId } = job.data;
    const sc = job.data.supplyCorner!;
    try {
        const result = await runSupplyCornerBatch({ jobId, circuit: sc.circuit, analysis: sc.analysis, criteria: sc.criteria, spec: sc.spec, modelFiles });
        recordSim({ status: 'succeeded', durationMs: result.runtimeMs });
        await prisma.simulationJob.update({
            where: { id: jobId },
            data: {
                status: 'SUCCEEDED',
                finishedAt: new Date(),
                metrics: {
                    runtimeMs: result.runtimeMs,
                    supplyCorner: {
                        applicable: result.applicable,
                        rails: result.rails,
                        omitted: result.omitted,
                        tolerance: result.tolerance,
                        rangeLabel: result.rangeLabel,
                        evaluated: result.evaluated,
                        passed: result.passed,
                        failed: result.failed,
                        errored: result.errored,
                        hasLimits: result.hasLimits,
                        passAllCorners: result.passAllCorners,
                        drift: result.drift,
                    },
                } as unknown as Prisma.InputJsonValue,
            },
        });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ jobId, error: msg }, 'Supply-voltage corner batch failed');
        recordSim({ status: 'failed' });
        await prisma.simulationJob.update({
            where: { id: jobId },
            data: {
                status: 'FAILED',
                finishedAt: new Date(),
                metrics: { error: msg, failureClass: 'infra' } as unknown as Prisma.InputJsonValue,
            },
        });
    }
}

/**
 * Handle successful simulation
 */
async function handleSuccess(jobId: string, result: SimulationJobResult): Promise<void> {
    const { result: simResult, stdout, stderr, runtimeMs, outputSizeBytes } = result;

    // Bound the STORED result. A long/stiff transient can emit ~1M rows per probe; persisting that
    // raw would bloat the DB row (or S3 object), the API's hydrate, and every response. min-max
    // bucketing down to WORKER_MAX_POINTS keeps peaks/glitches and visible features while capping
    // memory end-to-end. The ORIGINAL point count is preserved in metrics below (downsampleResult
    // also records meta.downsampledFrom). The full internal resolution is intentionally not retained —
    // nobody renders a million points, and the inline AI-verify path is unaffected (it summarizes).
    const originalPointsCount = simResult?.meta.pointsCount;
    const bounded = simResult ? downsampleResult(simResult, config.WORKER_MAX_POINTS) : simResult;

    // pointsCount is the TRUE pre-downsample resolution — the memory-pressure signal worth alerting on.
    recordSim({ status: 'succeeded', durationMs: runtimeMs, points: originalPointsCount });

    // Decide whether to store result in DB or S3 (single stringify; no redundant clone).
    const resultJson = bounded ? JSON.stringify(bounded) : 'null';
    const resultSize = Buffer.byteLength(resultJson);

    let resultS3Key: string | undefined;
    let storedResult = bounded;

    // If still large after bounding, store in S3.
    if (bounded && resultSize > 1024 * 1024) { // > 1MB
        resultS3Key = await uploadJsonResult(jobId, bounded);
        storedResult = undefined;
        logger.info({ jobId, s3Key: resultS3Key, size: resultSize }, 'Large result stored in S3');
    }

    await prisma.simulationJob.update({
        where: { id: jobId },
        data: {
            status: 'SUCCEEDED',
            stdout: stdout.substring(0, 10000), // Limit stored stdout
            stderr: stderr.substring(0, 10000),
            // storedResult is already a plain JSON-safe object — pass it straight to Prisma (no clone).
            resultJson: storedResult ? (storedResult as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
            resultS3Key,
            finishedAt: new Date(),
            // storedResultBytes = the bytes ACTUALLY persisted (downsampled+serialized / S3 object size), NOT the
            // raw ngspice size — the storage quota counts this so it doesn't reject legitimate uploads early (see
            // UsageService). convergence rides along when the remedy ladder rescued the run. Shape owned by outcome.ts.
            metrics: buildSuccessMetrics({
                runtimeMs,
                outputSizeBytes,
                storedResultBytes: resultSize,
                pointsCount: originalPointsCount,
                convergence: result.convergence,
            }) as unknown as Prisma.InputJsonValue,
        },
    });
}

/**
 * Handle failed simulation
 */
async function handleFailure(jobId: string, result: SimulationJobResult): Promise<void> {
    const { stdout, stderr, runtimeMs, error } = result;

    // INFRA failures (ngspice couldn't be launched, fs/setup) are NOT a circuit fault. The SimJobStatus
    // enum has no operational value, so we persist FAILED but tag metrics.failureClass='infra'; the API
    // reads that and reports the verify verdict as 'inconclusive', never a design 'fail'. A genuine ngspice
    // wall-clock timeout stays TIMED_OUT — decided from the runner's TYPED timedOut flag, not a fragile
    // error-string match (see deriveFailureStatus). Metrics shape/failureClass owned by buildFailureMetrics.
    const status = deriveFailureStatus(result);

    recordSim({ status: status === 'TIMED_OUT' ? 'timed_out' : 'failed', durationMs: runtimeMs });

    await prisma.simulationJob.update({
        where: { id: jobId },
        data: {
            status,
            stdout: stdout.substring(0, 10000),
            stderr: (stderr + '\n' + (error || '')).substring(0, 10000),
            finishedAt: new Date(),
            metrics: buildFailureMetrics(result) as unknown as Prisma.InputJsonValue,
        },
    });
}