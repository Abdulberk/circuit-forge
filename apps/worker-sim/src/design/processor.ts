/**
 * Design Job Processor — the durable home of the AI design loop.
 *
 * The agentic loop (generate → simulate → AI-fix → re-simulate → informational Monte-Carlo yield) used to run
 * DETACHED inside the API process (DesignJobService.runDetached): a `void`ed promise that an API deploy /
 * crash would silently abandon, leaving the DesignJob stuck RUNNING forever. Here it runs on a durable BullMQ
 * 'design' queue: a crash mid-loop means BullMQ re-reports the job (we run attempts:1, so a crash surfaces as
 * a terminal FAILED the user can retry — NOT silent loss), and an API deploy no longer touches in-flight work.
 *
 * It injects the worker's own dependencies into the SAME llm-core runDesignLoop the API runs: llmConfig from
 * the worker env, a LOCAL-ngspice simulation surface (makeLocalSim — never re-enqueues onto 'simulations', so
 * no self-deadlock), the no-op catalog grounding, a Prisma-backed cooperative-abort check, and a progress sink.
 * The loop's framework-free outcome/errors are written straight onto the DesignJob row, which is what the
 * client polls (BullMQ is just the transport — the row is the source of truth). This handler NEVER throws: it
 * always lands a terminal row (SUCCEEDED / CANCELED / FAILED), mirroring runDetached's never-throw contract.
 */
import { Job, Worker } from 'bullmq';
import Redis from 'ioredis';
import { Prisma } from '@prisma/client';
import { DesignAbortedError, CircuitGenerationError } from '@circuitforge/llm-core';
import { runMultiCandidateDesign } from './multi-candidate';
import { propagation, context as otelContext, trace, SpanStatusCode } from '@opentelemetry/api';
import { prisma } from '../prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import { noopGround } from './grounding';
import { makeLocalSim } from './local-sim';

/** Queue payload the API enqueues for an async design job (DesignJob.id + the loop inputs). */
export interface DesignJobPayload {
    jobId: string; // DesignJob.id (the persisted, client-polled row)
    userId: string;
    prompt: string;
    constraints?: string;
    maxRounds: number;
    /** W3C trace context injected by the API at enqueue, so the worker span links to the request. */
    otel?: Record<string, string>;
}

/** Build the llm-core LLM config from the worker env (mirrors apps/api DesignService). */
function buildLlmConfig() {
    return {
        apiKey: config.LLM_API_KEY as string, // presence guaranteed by the caller (processor only starts with a key)
        protocol: config.LLM_PROTOCOL as 'anthropic' | 'openai' | undefined,
        baseUrl: config.LLM_BASE_URL,
        model: config.LLM_MODEL,
        userAgent: config.LLM_USER_AGENT,
        timeoutMs: config.LLM_TIMEOUT_MS,
        tokenBudget: config.LLM_TOKEN_BUDGET,
        // Count every BILLED provider request (incl. the transient retry). The worker uses noopGround
        // (tool-LESS), so this is the CONTROL case: exactly one request per generate/fix (attempt=1,
        // tools=false) — the baseline to compare the grounded api:* paths against. Tagged 'worker'.
        onLlmRequest: (info: { iter: number; attempt: number; toolsOffered: boolean }) =>
            logger.info({ path: 'worker', iter: info.iter, attempt: info.attempt, toolsOffered: info.toolsOffered }, 'llm.request'),
    };
}

/** Whether a cooperative cancel was requested for this job — the loop's mid-round abort checkpoint. */
async function isAbortRequested(jobId: string): Promise<boolean> {
    const j = await prisma.designJob.findUnique({ where: { id: jobId }, select: { abortRequested: true } });
    return !!j?.abortRequested;
}

/**
 * Create the design worker. SEPARATE queue + concurrency pool from the sim worker (a design job runs its
 * sims locally, so it never competes for sim slots — but it must also never share a pool with sims that it
 * would otherwise need to wait on). Started only when an LLM key is configured (see main.ts).
 */
export function createDesignWorker(): Worker<DesignJobPayload> {
    const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

    const worker = new Worker<DesignJobPayload>(
        config.DESIGN_QUEUE_NAME,
        async (job: Job<DesignJobPayload>) => processDesignJob(job),
        { connection, concurrency: config.DESIGN_CONCURRENCY },
    );

    worker.on('completed', (job) => logger.info({ jobId: job.data.jobId }, 'Design job completed'));
    worker.on('failed', (job, err) => logger.error({ jobId: job?.data.jobId, error: err.message }, 'Design job failed'));
    worker.on('error', (err) => logger.error({ error: err.message }, 'Design worker error'));

    logger.info({ queue: config.DESIGN_QUEUE_NAME, concurrency: config.DESIGN_CONCURRENCY }, 'Design worker started');
    return worker;
}

/**
 * Process one design job: run the loop and land a terminal DesignJob row. Never throws (a thrown handler
 * would let BullMQ mark the job failed without our richer row); every failure is captured onto the row so a
 * client poll always sees a terminal status with a message.
 */
async function processDesignJob(job: Job<DesignJobPayload>): Promise<void> {
    const { jobId, userId, prompt, constraints, maxRounds } = job.data;

    const parentCtx = propagation.extract(otelContext.active(), job.data.otel ?? {});
    const tracer = trace.getTracer('circuit-forge-worker');

    await tracer.startActiveSpan(
        'design.process',
        { attributes: { 'design.job_id': jobId, 'design.max_rounds': maxRounds } },
        parentCtx,
        async (span) => {
            try {
                // CLAIM the job atomically: QUEUED → RUNNING. This is optimistic concurrency on the
                // QUEUED→running transition — the worker's half of the guard against racing the API's enqueue
                // path. `updateMany` with the `status: 'QUEUED'` predicate flips the row ONLY if it is still
                // QUEUED; a count of 0 means the row is no longer claimable — it was canceled while queued
                // (DesignJobService.requestCancel set status CANCELED), or the API's enqueue-failure path
                // already marked it FAILED (queue.add's reply was lost AFTER Redis stored the job, so the API
                // 503'd while THIS worker dequeued it). In every such case we must NOT run (no LLM/sim spend)
                // and must NOT overwrite that terminal row. (This also subsumes the old QUEUED-cancel check.)
                const claim = await prisma.designJob.updateMany({
                    where: { id: jobId, status: 'QUEUED' },
                    data: { status: 'RUNNING', startedAt: new Date() },
                });
                if (claim.count === 0) {
                    logger.info({ jobId }, 'Design job not claimed (already canceled or marked terminal) — skipping');
                    span.setAttribute('design.outcome', 'not-claimed');
                    return;
                }

                // Defensive: the worker only starts with an LLM key (main.ts), but if a keyless worker somehow
                // claimed a job, fail it terminally with a clear message. We own the (RUNNING) row now, so the
                // write is safe from the API's QUEUED-gated failure-flip.
                if (!config.LLM_API_KEY) {
                    await finish(jobId, { status: 'FAILED', errorMessage: 'AI circuit generation is not configured on the worker (LLM_API_KEY is not set).' });
                    span.setAttribute('design.outcome', 'misconfigured');
                    return;
                }

                // runMultiCandidateDesign degenerates to a single runDesignLoop when DESIGN_CANDIDATES_N=1
                // (the default) — so this is byte-identical to the pre-multi-candidate path until N is raised.
                const result = await runMultiCandidateDesign(
                    { prompt, constraints, maxRounds },
                    {
                        llmConfig: buildLlmConfig(),
                        runSim: makeLocalSim(),
                        ground: noopGround,
                        userId,
                        pollTimeoutMs: config.DESIGN_POLL_TIMEOUT_MS ?? 90_000,
                        mcEnabled: config.DESIGN_MC_ENABLED !== 'false',
                        mcRuns: config.DESIGN_MC_RUNS,
                        isAborted: () => isAbortRequested(jobId),
                        progress: (round) => void job.updateProgress({ round }).catch(() => undefined),
                        // The worker has no HTTP layer; every error becomes a terminal FAILED / inconclusive
                        // result naturally, so nothing needs to propagate "untranslated".
                        isIntentfulError: () => false,
                    },
                    {
                        n: config.DESIGN_CANDIDATES_N ?? 1,
                        k: config.DESIGN_FINALISTS_K ?? 2,
                        llmBudget: config.DESIGN_JOB_LLM_BUDGET ?? 12,
                    },
                );

                // A cancel that landed AFTER the loop returned (between its last checkpoint and now) still wins
                // over the now-unwanted result.
                if (await isAbortRequested(jobId)) {
                    await finish(jobId, { status: 'CANCELED' });
                    span.setAttribute('design.outcome', 'canceled');
                    return;
                }

                await finish(jobId, { status: 'SUCCEEDED', result: result as unknown as Prisma.InputJsonValue });
                span.setAttribute('design.outcome', result.ok ? 'verified' : 'completed');
                span.setStatus({ code: SpanStatusCode.OK });
            } catch (err) {
                // DesignAbortedError = a mid-loop cancel was observed → CANCELED, not a failure.
                if (err instanceof DesignAbortedError) {
                    await finish(jobId, { status: 'CANCELED' });
                    span.setAttribute('design.outcome', 'canceled');
                    return;
                }
                const message =
                    err instanceof CircuitGenerationError
                        ? err.message
                        : err instanceof Error
                            ? err.message
                            : String(err);
                logger.error({ jobId, error: message }, 'Design job failed');
                span.recordException(err instanceof Error ? err : new Error(message));
                span.setStatus({ code: SpanStatusCode.ERROR, message });
                // Terminal FAILED (attempts:1 — these errors are deterministic; a retry just re-bills the LLM).
                await finish(jobId, { status: 'FAILED', errorMessage: message });
            } finally {
                span.end();
            }
        },
    );
}

/**
 * Write the terminal DesignJob row. Best-effort: if the DB write itself fails we log and swallow (BullMQ
 * still completes the job; a future reaper sweeps a row left non-terminal). Sets finishedAt always.
 */
async function finish(
    jobId: string,
    data: { status: 'SUCCEEDED' | 'FAILED' | 'CANCELED'; result?: Prisma.InputJsonValue; errorMessage?: string },
): Promise<void> {
    try {
        await prisma.designJob.update({
            where: { id: jobId },
            data: {
                status: data.status,
                finishedAt: new Date(),
                ...(data.result !== undefined ? { result: data.result } : {}),
                ...(data.errorMessage ? { errorMessage: data.errorMessage } : {}),
            },
        });
    } catch (e) {
        logger.error({ jobId, error: e instanceof Error ? e.message : String(e) }, 'Could not persist terminal design-job row');
    }
}
