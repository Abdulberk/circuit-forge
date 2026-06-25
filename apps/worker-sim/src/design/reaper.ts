/**
 * Orphan reaper — the recovery half of the durable design queue.
 *
 * A durable queue removes "an API deploy abandons in-flight work", but two unavoidable failure modes remain
 * (they exist in EVERY distributed job system — see SQS visibility timeout, BullMQ stalled jobs, K8s pod
 * reaping, Airflow zombie tasks):
 *   1. WORKER DIED MID-JOB — the row is RUNNING but the process that owned it is gone (OOM, node recycle,
 *      spot reclaim). Our QUEUED→RUNNING claim makes a BullMQ redelivery a no-op (it can't re-bill the LLM),
 *      which also means the redelivery completes without writing a terminal row — so the row would sit
 *      RUNNING forever, and (because quota counts QUEUED+RUNNING) eventually lock the org out.
 *   2. INSERT↔ENQUEUE GAP — create() inserts the QUEUED row, then enqueues; an API crash strictly between
 *      the two leaves a row QUEUED that no worker will ever see (it never became a queue job).
 *
 * This reaper reconciles such rows against the queue's GROUND TRUTH. Because we set the BullMQ job id = the
 * DesignJob row id, we can look each row up (queue.getJob(rowId)) and act on its real state. It is
 * lease-correct: a job BullMQ still reports 'waiting'/'delayed' (legitimately queued, even in a backed-up
 * queue) or 'active' within a generous runtime deadline is NEVER reaped — so it cannot kill healthy work.
 * Every write is a CONDITIONAL updateMany gated on status ∈ {QUEUED,RUNNING}, so it never clobbers a row the
 * worker (or a cancel) has already finalized, and concurrent reapers across worker instances are idempotent.
 */
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { prisma } from '../prisma/client';
import { config } from '../config';
import { logger } from '../logger';

/** The minimal row shape the reaper reasons about. */
export interface ReapableRow {
    id: string;
    status: string;
    startedAt: Date | null;
    createdAt: Date;
}

export interface ReapDecision {
    reap: boolean;
    reason?: string;
}

/**
 * PURE decision: given a stale row and the BullMQ state of its job (or 'missing' when the queue has no such
 * job), should the row be reaped, and why? Exported for unit testing — no I/O.
 *
 * `state` is a BullMQ job state ('waiting' | 'delayed' | 'prioritized' | 'waiting-children' | 'active' |
 * 'completed' | 'failed' | 'unknown') or the sentinel 'missing' (queue.getJob returned null).
 */
export function reapDecision(row: ReapableRow, state: string, nowMs: number, runningDeadlineMs: number): ReapDecision {
    switch (state) {
        // Legitimately queued / scheduled — BullMQ will get to it. Never reap (this is what keeps a healthy
        // job waiting in a backed-up queue from being false-positive killed).
        case 'waiting':
        case 'waiting-children':
        case 'delayed':
        case 'prioritized':
            return { reap: false };

        // Genuinely being processed. Only reap if it has blown past the absolute runtime ceiling — then the
        // worker is hung (the loop's own max is ~8 min; the deadline is far beyond that).
        case 'active': {
            const startedMs = row.startedAt ? row.startedAt.getTime() : row.createdAt.getTime();
            if (nowMs - startedMs > runningDeadlineMs) {
                return { reap: true, reason: 'reaped: exceeded the maximum runtime (the worker appears hung)' };
            }
            return { reap: false };
        }

        // BullMQ says the job is DONE (completed or failed) yet the row is still non-terminal → the worker
        // stopped before writing the outcome (a redelivery no-op'd, or it crashed). Reconcile to FAILED.
        case 'completed':
            return { reap: true, reason: 'reaped: the queue job finished but the worker never wrote the result (it stopped mid-job)' };
        case 'failed':
            return { reap: true, reason: 'reaped: the queue job failed (the worker stopped unexpectedly)' };

        // No queue job at all ('missing'/'unknown'): a QUEUED row was orphaned in the insert↔enqueue gap;
        // a RUNNING row's worker is gone and its queue job was already evicted. Either way it's dead.
        default:
            return {
                reap: true,
                reason:
                    row.status === 'QUEUED'
                        ? 'reaped: orphaned before reaching the queue (never picked up)'
                        : 'reaped: the worker stopped and no active queue job remains',
            };
    }
}

/** Minimal queue surface the sweep needs (a BullMQ Queue satisfies it; tests pass a fake). */
export interface ReaperQueue {
    getJob(id: string): Promise<{ getState(): Promise<string> } | null | undefined>;
}

/**
 * One reaper sweep. Finds DesignJob rows stuck in QUEUED/RUNNING past the grace window, asks the queue for
 * each one's true state, and FAILS the genuinely-orphaned rows (conditionally). Returns the tally. Never
 * throws on a per-row error — one bad row must not abort the sweep.
 */
export async function reapStaleDesignJobs(deps: {
    prisma: {
        designJob: {
            findMany: (args: unknown) => Promise<ReapableRow[]>;
            updateMany: (args: unknown) => Promise<{ count: number }>;
        };
    };
    queue: ReaperQueue;
    nowMs: number;
    graceMs: number;
    runningDeadlineMs: number;
    log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}): Promise<{ examined: number; reaped: number }> {
    const { prisma: db, queue, nowMs, graceMs, runningDeadlineMs, log } = deps;

    const rows = await db.designJob.findMany({
        where: {
            status: { in: ['QUEUED', 'RUNNING'] },
            createdAt: { lt: new Date(nowMs - graceMs) },
        },
        select: { id: true, status: true, startedAt: true, createdAt: true },
    });

    let reaped = 0;
    for (const row of rows) {
        try {
            const job = await queue.getJob(row.id);
            const state = job ? await job.getState() : 'missing';
            const decision = reapDecision(row, state, nowMs, runningDeadlineMs);
            if (!decision.reap) continue;

            // Conditional: only fail a row STILL in QUEUED/RUNNING — never clobber one the worker or a cancel
            // already finalized (and concurrent reapers race harmlessly: the loser updates 0 rows).
            const res = await db.designJob.updateMany({
                where: { id: row.id, status: { in: ['QUEUED', 'RUNNING'] } },
                data: { status: 'FAILED', errorMessage: decision.reason, finishedAt: new Date(nowMs) },
            });
            if (res.count > 0) {
                reaped += res.count;
                log?.warn({ jobId: row.id, was: row.status, queueState: state, reason: decision.reason }, 'Reaped orphaned design job');
            }
        } catch (e) {
            log?.warn({ jobId: row.id, error: e instanceof Error ? e.message : String(e) }, 'Reaper skipped a row after an error');
        }
    }

    if (reaped > 0) log?.info({ examined: rows.length, reaped }, 'Design-job reaper sweep complete');
    return { examined: rows.length, reaped };
}

/**
 * Start the periodic reaper (boot sweep + every intervalMs). Owns its own Redis connection + Queue handle
 * (needed for getJob). Returns a handle whose stop() clears the timer and closes the connection — call it on
 * graceful shutdown. Each tick is isolated: a sweep error is logged, never crashes the loop.
 */
export function startDesignReaper(): { stop: () => Promise<void> } {
    const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
    const queue = new Queue(config.DESIGN_QUEUE_NAME, { connection });

    const tick = async () => {
        try {
            await reapStaleDesignJobs({
                // The generated PrismaClient's findMany/updateMany are generically typed; the reaper only needs
                // the two methods, so narrow via the loose injectable shape (the real calls are runtime-safe).
                prisma: prisma as unknown as Parameters<typeof reapStaleDesignJobs>[0]['prisma'],
                queue,
                nowMs: Date.now(),
                graceMs: config.DESIGN_REAP_GRACE_MS,
                runningDeadlineMs: config.DESIGN_REAP_RUNNING_DEADLINE_MS,
                log: logger,
            });
        } catch (e) {
            logger.warn({ error: e instanceof Error ? e.message : String(e) }, 'Reaper sweep failed');
        }
    };

    void tick(); // boot sweep
    const timer = setInterval(() => void tick(), config.REAPER_INTERVAL_MS);
    // Don't let the reaper timer keep the event loop alive on its own (graceful shutdown owns exit).
    timer.unref?.();
    logger.info({ intervalMs: config.REAPER_INTERVAL_MS, queue: config.DESIGN_QUEUE_NAME }, 'Design-job reaper started');

    return {
        stop: async () => {
            clearInterval(timer);
            await queue.close();
            connection.disconnect();
        },
    };
}
