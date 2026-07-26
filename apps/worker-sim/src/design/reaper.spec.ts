/**
 * Orphan reaper. Two layers locked here: the PURE reapDecision (given a row + its BullMQ state, reap or
 * not?) and the reapStaleDesignJobs SWEEP (it reaps only the genuine orphans, conditionally, and survives a
 * per-row error). The module's startDesignReaper pulls in config/prisma/redis at import, so those are stubbed.
 */
jest.mock('../config', () => ({
    config: {
        REDIS_URL: 'redis://x',
        DESIGN_QUEUE_NAME: 'design',
        REAPER_INTERVAL_MS: 60000,
        DESIGN_REAP_GRACE_MS: 60000,
        DESIGN_REAP_RUNNING_DEADLINE_MS: 1_800_000,
    },
}));
jest.mock('../prisma/client', () => ({ prisma: {} }));
jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));
jest.mock('bullmq', () => ({ Queue: jest.fn() }));
jest.mock('ioredis', () => jest.fn());

import { reapDecision, reapStaleDesignJobs, type ReapableRow } from './reaper';

const NOW = 1_000_000_000;
const DEADLINE = 1_800_000; // 30 min
const row = (over: Partial<ReapableRow> = {}): ReapableRow => ({
    id: 'd1',
    status: 'RUNNING',
    startedAt: new Date(NOW - 1000),
    createdAt: new Date(NOW - 120_000),
    ...over,
});

describe('reapDecision (pure)', () => {
    it('does NOT reap a job still waiting/delayed in the queue (protects a backed-up queue)', () => {
        expect(reapDecision(row({ status: 'QUEUED' }), 'waiting', NOW, DEADLINE).reap).toBe(false);
        expect(reapDecision(row({ status: 'QUEUED' }), 'delayed', NOW, DEADLINE).reap).toBe(false);
        expect(reapDecision(row({ status: 'QUEUED' }), 'prioritized', NOW, DEADLINE).reap).toBe(false);
    });

    it('does NOT reap an active job within the runtime deadline', () => {
        expect(reapDecision(row({ startedAt: new Date(NOW - 60_000) }), 'active', NOW, DEADLINE).reap).toBe(false);
    });

    it('REAPS an active job past the runtime deadline (hung worker)', () => {
        const d = reapDecision(row({ startedAt: new Date(NOW - DEADLINE - 1) }), 'active', NOW, DEADLINE);
        expect(d.reap).toBe(true);
        expect(d.reason).toMatch(/hung|runtime/i);
    });

    it('REAPS when the queue job is completed/failed but the row is still non-terminal', () => {
        expect(reapDecision(row(), 'completed', NOW, DEADLINE).reap).toBe(true);
        expect(reapDecision(row(), 'failed', NOW, DEADLINE).reap).toBe(true);
    });

    it('REAPS a missing queue job — QUEUED = insert↔enqueue orphan, RUNNING = dead worker', () => {
        expect(reapDecision(row({ status: 'QUEUED' }), 'missing', NOW, DEADLINE)).toMatchObject({
            reap: true,
            reason: expect.stringMatching(/orphaned before/i),
        });
        expect(reapDecision(row({ status: 'RUNNING' }), 'missing', NOW, DEADLINE)).toMatchObject({
            reap: true,
            reason: expect.stringMatching(/worker stopped/i),
        });
        // 'unknown' (queue can't resolve the job) is treated like missing → reaped.
        expect(reapDecision(row({ status: 'RUNNING' }), 'unknown', NOW, DEADLINE).reap).toBe(true);
    });
});

describe('reapStaleDesignJobs (sweep)', () => {
    function fakeQueue(states: Record<string, string | null>) {
        return {
            getJob: jest.fn(async (id: string) => {
                const s = states[id];
                if (s === null || s === undefined) return null; // missing
                return { getState: async () => s };
            }),
        };
    }

    it('reaps only the genuine orphans, conditionally (where status QUEUED/RUNNING), leaving healthy work', async () => {
        const rows: ReapableRow[] = [
            row({ id: 'orphan-queued', status: 'QUEUED', startedAt: null }), // missing → reap
            row({ id: 'healthy-active', status: 'RUNNING', startedAt: new Date(NOW - 5000) }), // active, fresh → keep
            row({ id: 'dead-worker', status: 'RUNNING' }), // failed in queue → reap
            row({ id: 'still-waiting', status: 'QUEUED', startedAt: null }), // waiting → keep
        ];
        const updateMany = jest.fn((_args: unknown) => Promise.resolve({ count: 1 }));
        const findMany = jest.fn((_args: unknown) => Promise.resolve(rows));
        const queue = fakeQueue({
            'orphan-queued': null,
            'healthy-active': 'active',
            'dead-worker': 'failed',
            'still-waiting': 'waiting',
        });

        const res = await reapStaleDesignJobs({
            prisma: { designJob: { findMany, updateMany } },
            queue,
            nowMs: NOW,
            graceMs: 60_000,
            runningDeadlineMs: DEADLINE,
        });

        expect(res).toEqual({ examined: 4, reaped: 2 });
        const reapedIds = updateMany.mock.calls.map((c) => (c[0] as { where: { id: string } }).where.id).sort();
        expect(reapedIds).toEqual(['dead-worker', 'orphan-queued']);
        // every reap write is conditional on the row still being non-terminal
        for (const c of updateMany.mock.calls) {
            expect((c[0] as { where: { status: unknown } }).where.status).toEqual({ in: ['QUEUED', 'RUNNING'] });
            expect((c[0] as { data: { status: string } }).data.status).toBe('FAILED');
        }
        // the grace filter is applied (findMany scopes to rows older than now-grace)
        expect((findMany.mock.calls[0]![0] as { where: { createdAt: { lt: Date } } }).where.createdAt.lt).toEqual(
            new Date(NOW - 60_000),
        );
    });

    it('a per-row error does not abort the sweep (the other orphans are still reaped)', async () => {
        const rows: ReapableRow[] = [
            row({ id: 'boom', status: 'RUNNING' }),
            row({ id: 'orphan', status: 'QUEUED', startedAt: null }),
        ];
        const updateMany = jest.fn((_args: unknown) => Promise.resolve({ count: 1 }));
        const queue = {
            getJob: jest.fn((id: string) => {
                if (id === 'boom') throw new Error('redis hiccup');
                return Promise.resolve(null); // 'orphan' → missing → reap
            }),
        };
        const res = await reapStaleDesignJobs({
            prisma: { designJob: { findMany: () => Promise.resolve(rows), updateMany } },
            queue,
            nowMs: NOW,
            graceMs: 0,
            runningDeadlineMs: DEADLINE,
        });
        expect(res.reaped).toBe(1);
        expect((updateMany.mock.calls[0]![0] as { where: { id: string } }).where.id).toBe('orphan');
    });

    it('counts only rows actually updated (a row finalized concurrently → updateMany count 0 → not counted)', async () => {
        const rows: ReapableRow[] = [row({ id: 'raced', status: 'RUNNING' })];
        const updateMany = jest.fn((_args: unknown) => Promise.resolve({ count: 0 })); // worker finalized it first
        const queue = { getJob: jest.fn((_id: string) => Promise.resolve(null)) }; // missing → decision says reap
        const res = await reapStaleDesignJobs({
            prisma: { designJob: { findMany: () => Promise.resolve(rows), updateMany } },
            queue,
            nowMs: NOW,
            graceMs: 0,
            runningDeadlineMs: DEADLINE,
        });
        expect(res.reaped).toBe(0); // decision said reap, but the conditional write hit 0 rows → not counted
    });
});
