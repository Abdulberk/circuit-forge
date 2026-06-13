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
import { downloadFile, uploadJsonResult } from '../storage/s3-client';
import { downsampleResult } from '@circuit-forge/eda-core';
import { Prisma } from '@prisma/client';
import { recordSim } from '../observability/telemetry';
import { propagation, context as otelContext, trace, SpanStatusCode } from '@opentelemetry/api';

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

    logger.info({ jobId, orgId }, 'Processing simulation job');

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

                // Run the simulation
                const result = await runSimulation({
                    jobId,
                    netlist,
                    probeNames,
                    analysisType,
                    modelFiles: modelFiles.length > 0 ? modelFiles : undefined,
                });

                // Handle result
                if (result.success && result.result) {
                    await handleSuccess(jobId, result);
                } else {
                    await handleFailure(jobId, result);
                }
                span.setAttribute('sim.outcome', result.success ? 'succeeded' : 'failed');
                span.setStatus({ code: SpanStatusCode.OK });
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.error({ jobId, error: errorMessage }, 'Job processing error');
                span.recordException(error instanceof Error ? error : new Error(errorMessage));
                span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });

                // Reached by a throw OUTSIDE the ngspice result path — S3 model download, the RUNNING/DB
                // update, or a result upload on an otherwise-successful sim. These are INFRASTRUCTURE
                // failures, not circuit faults, so tag failureClass='infra' (status stays FAILED — no
                // operational enum value); the API maps it to an 'inconclusive' verify verdict rather than
                // telling the user their design failed. The OTel metric counts it as a failed run.
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

                throw error;
            } finally {
                span.end();
            }
        },
    );
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
            metrics: {
                runtimeMs,
                outputSizeBytes,
                pointsCount: originalPointsCount, // the TRUE simulated resolution, not the stored cap
                // Present when the Convergence Doctor's remedy ladder rescued an initial non-convergence
                // (recovered:true + the remedy that worked). The API surfaces it on the verify evidence.
                ...(result.convergence ? { convergence: result.convergence as unknown as Prisma.InputJsonValue } : {}),
            },
        },
    });
}

/**
 * Handle failed simulation
 */
async function handleFailure(jobId: string, result: SimulationJobResult): Promise<void> {
    const { stdout, stderr, runtimeMs, error, infra } = result;

    // INFRA failures (ngspice couldn't be launched, fs/setup) are NOT a circuit fault. The SimJobStatus
    // enum has no operational value, so we persist FAILED but tag metrics.failureClass='infra'; the API
    // reads that and reports the verify verdict as 'inconclusive', never a design 'fail'. A genuine
    // ngspice wall-clock timeout stays TIMED_OUT; any other genuine ngspice failure is FAILED + 'sim'.
    const status = !infra && error?.includes('timed out') ? 'TIMED_OUT' : 'FAILED';

    recordSim({ status: status === 'TIMED_OUT' ? 'timed_out' : 'failed', durationMs: runtimeMs });

    await prisma.simulationJob.update({
        where: { id: jobId },
        data: {
            status,
            stdout: stdout.substring(0, 10000),
            stderr: (stderr + '\n' + (error || '')).substring(0, 10000),
            finishedAt: new Date(),
            metrics: {
                runtimeMs,
                error,
                failureClass: infra ? 'infra' : 'sim',
                // A convergence-class failure where the remedy ladder was walked but NONE recovered the run
                // (recovered:false + every remedy tried) — surfaced so the user/AI sees it was a genuine,
                // remedy-resistant non-convergence, not an un-diagnosed crash.
                ...(result.convergence ? { convergence: result.convergence as unknown as Prisma.InputJsonValue } : {}),
            },
        },
    });
}