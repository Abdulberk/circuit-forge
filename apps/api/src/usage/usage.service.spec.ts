import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../prisma/prisma.service';

import { UsageService } from './usage.service';

/** ConfigService stub backed by a plain object. */
const cfg = (vals: Record<string, string>) =>
    ({ get: (k: string) => vals[k] }) as unknown as ConfigService;

/**
 * Minimal prisma stub. Aggregation + the gated parts counter run via $queryRaw; the stub dispatches
 * on the SQL text: month aggregate (runtimeMs), storage (outputSizeBytes), parts gate (usage_records).
 * $transaction invokes its callback with the same stub (so advisory-locked paths exercise real logic).
 */
function prismaStub(over: Partial<Record<string, unknown>> = {}) {
    const stub: Record<string, unknown> = {
        $queryRaw: jest.fn().mockImplementation((strings: TemplateStringsArray) => {
            const sql = strings.join('?');
            if (sql.includes('runtimeMs')) return Promise.resolve([{ jobs: 3, runtimeMs: 350 }]);
            if (sql.includes('outputSizeBytes')) return Promise.resolve([{ bytes: 200 }]);
            if (sql.includes('usage_records')) return Promise.resolve([{ amount: 1 }]); // parts: counted
            return Promise.resolve([]);
        }),
        $executeRaw: jest.fn().mockResolvedValue(1),
        simulationJob: { count: jest.fn().mockResolvedValue(1) },
        designJob: { count: jest.fn().mockResolvedValue(2) },
        layoutJob: { count: jest.fn().mockResolvedValue(2) },
        asset: { aggregate: jest.fn().mockResolvedValue({ _sum: { sizeBytes: 5000 } }) },
        usageRecord: {
            findUnique: jest.fn().mockResolvedValue({ amount: 7 }),
            upsert: jest.fn().mockResolvedValue({}),
        },
        // Suspension + per-org quota-override gate reads (default: not suspended, no override → env-only
        // behavior identical to before these were added).
        organization: {
            findUnique: jest.fn().mockResolvedValue({ suspendedAt: null, suspendReason: null, quotaOverride: null }),
        },
        orgQuotaOverride: { findUnique: jest.fn().mockResolvedValue(null) },
        ...over,
    };
    stub.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(stub));
    return stub as unknown as PrismaService;
}

const rec = (prisma: PrismaService) =>
    prisma as unknown as {
        $queryRaw: jest.Mock;
        $transaction: jest.Mock;
        $executeRaw: jest.Mock;
        usageRecord: Record<'findUnique' | 'upsert', jest.Mock>;
        simulationJob: { count: jest.Mock };
        designJob: { count: jest.Mock };
    };

describe('UsageService', () => {
    it('aggregates org usage on demand (jobs + summed runtime, storage incl. spilled results, parts calls)', async () => {
        const svc = new UsageService(prismaStub(), cfg({}));
        const u = await svc.getOrgUsage('org1', 'user1');
        expect(u.sim.jobs).toBe(3);
        expect(u.sim.runtimeMs).toBe(350);
        expect(u.storage.assetBytes).toBe(5000);
        expect(u.storage.resultBytes).toBe(200);
        expect(u.storage.totalBytes).toBe(5200);
        expect(u.parts.calls).toBe(7);
        // design jobs aggregated drift-free from the design_jobs table (count mock = 2 for both this-month
        // and in-flight).
        expect(u.design.jobs).toBe(2);
        expect(u.design.concurrent).toBe(2);
        // layout jobs aggregated drift-free from the layout_jobs table (count mock = 2 for both this-month
        // and in-flight), same parity as design.
        expect(u.layout.jobs).toBe(2);
        expect(u.layout.concurrent).toBe(2);
        // no env limits configured → everything unlimited (null)
        expect(u.sim.limits.jobsPerMonth).toBeNull();
        expect(u.design.limits.jobsPerMonth).toBeNull();
        expect(u.design.limits.concurrent).toBeNull();
        expect(u.layout.limits.jobsPerMonth).toBeNull();
        expect(u.layout.limits.concurrent).toBeNull();
        expect(u.storage.limits.bytes).toBeNull();
    });

    it('quota gates are NO-OPS when no limits are configured (parts still metered via native upsert)', async () => {
        const prisma = prismaStub();
        const svc = new UsageService(prisma, cfg({}));
        await expect(svc.assertSimQuota('org1')).resolves.toBeUndefined();
        await expect(svc.assertStorageQuota('org1', 10_000_000)).resolves.toBeUndefined();
        await expect(svc.assertAndCountPartsCall('user1')).resolves.toBeUndefined();
        // unlimited → no gate queries, just the metering upsert; gated parts SQL never runs
        expect(rec(prisma).usageRecord.upsert).toHaveBeenCalledTimes(1);
        expect(rec(prisma).$queryRaw).not.toHaveBeenCalled();
    });

    it('throws a structured 429 when the concurrent (fairness) cap is hit — counting only fresh jobs', async () => {
        const count = jest.fn().mockResolvedValue(3);
        const prisma = prismaStub({ simulationJob: { count } });
        const svc = new UsageService(prisma, cfg({ QUOTA_SIM_CONCURRENT_PER_ORG: '3' }));
        const err = await svc.assertSimQuota('org1').catch((e) => e);
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(429);
        expect((err as HttpException).getResponse()).toMatchObject({
            code: 'QUOTA_EXCEEDED',
            metric: 'sim_concurrent',
            used: 3,
            limit: 3,
        });
        // orphaned QUEUED/RUNNING rows (crashed worker) must not lock the org out forever
        expect(count.mock.calls[0][0].where.createdAt.gte).toBeInstanceOf(Date);
    });

    it('enforces the monthly job and runtime ceilings', async () => {
        const svc = new UsageService(prismaStub(), cfg({ QUOTA_SIM_JOBS_PER_MONTH: '3' }));
        await expect(svc.assertSimQuota('org1')).rejects.toMatchObject({ response: { metric: 'sim_jobs' } });
        const svc2 = new UsageService(prismaStub(), cfg({ QUOTA_SIM_RUNTIME_MS_PER_MONTH: '300' }));
        await expect(svc2.assertSimQuota('org1')).rejects.toMatchObject({ response: { metric: 'sim_runtime_ms' } });
        // under the ceiling → passes
        const svc3 = new UsageService(prismaStub(), cfg({ QUOTA_SIM_JOBS_PER_MONTH: '10', QUOTA_SIM_RUNTIME_MS_PER_MONTH: '10000' }));
        await expect(svc3.assertSimQuota('org1')).resolves.toBeUndefined();
    });

    it('storage gate counts assets + spilled results + the incoming upload, and 429s with the PROJECTED total', async () => {
        // assets 5000 + results 200 = 5200 used
        const svc = new UsageService(prismaStub(), cfg({ QUOTA_STORAGE_BYTES_PER_ORG: '6000' }));
        await expect(svc.assertStorageQuota('org1', 500)).resolves.toBeUndefined(); // 5700 ≤ 6000
        const err = await svc.assertStorageQuota('org1', 1500).catch((e) => e); // 6700 > 6000
        expect((err as HttpException).getResponse()).toMatchObject({
            metric: 'storage_bytes',
            used: 6700, // projected (current + rejected upload) — always > limit in the 429
            limit: 6000,
        });
    });

    it('parts gate is ONE atomic conditional upsert (INSERT … ON CONFLICT DO UPDATE … WHERE amount < limit)', async () => {
        const prisma = prismaStub();
        const svc = new UsageService(prisma, cfg({ QUOTA_PARTS_CALLS_PER_MONTH: '100' }));
        await svc.assertAndCountPartsCall('user1');
        const q = rec(prisma).$queryRaw;
        expect(q).toHaveBeenCalledTimes(1);
        const sql = (q.mock.calls[0][0] as TemplateStringsArray).join('?');
        expect(sql).toMatch(/INSERT INTO usage_records/);
        expect(sql).toMatch(/ON CONFLICT/);
        expect(sql).toMatch(/amount < /);
        // counted in one round-trip — no separate read on the success path
        expect(rec(prisma).usageRecord.findUnique).not.toHaveBeenCalled();
    });

    it('parts gate 429s at the limit (atomic upsert touches 0 rows) and reports the TRUE used', async () => {
        const prisma = prismaStub({
            // gated parts SQL returns [] (DO UPDATE WHERE amount<limit matched nothing → at/over limit)
            $queryRaw: jest.fn().mockResolvedValue([]),
            usageRecord: { findUnique: jest.fn().mockResolvedValue({ amount: 7 }), upsert: jest.fn() },
        });
        const svc = new UsageService(prisma, cfg({ QUOTA_PARTS_CALLS_PER_MONTH: '7' }));
        await expect(svc.assertAndCountPartsCall('user1')).rejects.toMatchObject({
            response: { metric: 'parts_calls', used: 7, limit: 7 },
        });
    });

    it('createSimGuarded: zero overhead when no quota — runs the create directly, no transaction/lock', async () => {
        const prisma = prismaStub();
        const svc = new UsageService(prisma, cfg({}));
        const created = await svc.createSimGuarded('org1', async () => ({ id: 'job-x' }));
        expect(created).toEqual({ id: 'job-x' });
        expect(rec(prisma).$transaction).not.toHaveBeenCalled();
        expect(rec(prisma).$executeRaw).not.toHaveBeenCalled();
    });

    it('createSimGuarded: when a quota is set, takes a per-org advisory lock and re-checks inside the tx', async () => {
        const prisma = prismaStub({ simulationJob: { count: jest.fn().mockResolvedValue(0) } });
        const svc = new UsageService(prisma, cfg({ QUOTA_SIM_CONCURRENT_PER_ORG: '5' }));
        const created = await svc.createSimGuarded('org1', async () => ({ id: 'job-y' }));
        expect(created).toEqual({ id: 'job-y' });
        expect(rec(prisma).$transaction).toHaveBeenCalledTimes(1);
        const lockSql = (rec(prisma).$executeRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
        expect(lockSql).toMatch(/pg_advisory_xact_lock/);
    });

    it('design quota: 429s on the concurrent (in-flight) cap — the primary abuse guard for the LLM+sim loop', async () => {
        const count = jest.fn().mockResolvedValue(2);
        const prisma = prismaStub({ designJob: { count } });
        const svc = new UsageService(prisma, cfg({ QUOTA_DESIGN_CONCURRENT_PER_ORG: '2' }));
        const err = await svc.assertDesignQuota('org1').catch((e) => e);
        expect((err as HttpException).getStatus()).toBe(429);
        expect((err as HttpException).getResponse()).toMatchObject({ code: 'QUOTA_EXCEEDED', metric: 'design_concurrent', used: 2, limit: 2 });
        // stale (crashed-worker) rows age out, so a dead job can't lock the org out forever
        expect(count.mock.calls[0][0].where.createdAt.gte).toBeInstanceOf(Date);
    });

    it('design quota: enforces the monthly job ceiling and passes under it', async () => {
        const svc = new UsageService(prismaStub({ designJob: { count: jest.fn().mockResolvedValue(5) } }), cfg({ QUOTA_DESIGN_JOBS_PER_MONTH: '5' }));
        await expect(svc.assertDesignQuota('org1')).rejects.toMatchObject({ response: { metric: 'design_jobs' } });
        const svc2 = new UsageService(prismaStub({ designJob: { count: jest.fn().mockResolvedValue(2) } }), cfg({ QUOTA_DESIGN_JOBS_PER_MONTH: '10' }));
        await expect(svc2.assertDesignQuota('org1')).resolves.toBeUndefined();
    });

    it('createDesignGuarded: zero overhead when no quota; advisory-locked re-check (domain "design") when set', async () => {
        const noQuota = prismaStub();
        const svc = new UsageService(noQuota, cfg({}));
        await expect(svc.createDesignGuarded('org1', async () => ({ id: 'd1' }))).resolves.toEqual({ id: 'd1' });
        expect(rec(noQuota).$transaction).not.toHaveBeenCalled();

        const quota = prismaStub({ designJob: { count: jest.fn().mockResolvedValue(0) } });
        const svc2 = new UsageService(quota, cfg({ QUOTA_DESIGN_CONCURRENT_PER_ORG: '5' }));
        await expect(svc2.createDesignGuarded('org1', async () => ({ id: 'd2' }))).resolves.toEqual({ id: 'd2' });
        expect(rec(quota).$transaction).toHaveBeenCalledTimes(1);
        expect((rec(quota).$executeRaw.mock.calls[0][0] as TemplateStringsArray).join('?')).toMatch(/pg_advisory_xact_lock/);
    });

    // ---------------------------------------------------------------- PCB layout quota (parity with design)

    it('layout quota: 429s on the concurrent (in-flight) cap — the noisy-neighbor guard for the freerouting+DRC pipeline', async () => {
        const count = jest.fn().mockResolvedValue(2);
        const prisma = prismaStub({ layoutJob: { count } });
        const svc = new UsageService(prisma, cfg({ QUOTA_LAYOUT_CONCURRENT_PER_ORG: '2' }));
        const err = await svc.assertLayoutQuota('org1').catch((e) => e);
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getResponse()).toMatchObject({ code: 'QUOTA_EXCEEDED', metric: 'layout_concurrent', used: 2, limit: 2 });
    });

    it('layout quota: enforces the monthly job ceiling and passes under it', async () => {
        const svc = new UsageService(prismaStub({ layoutJob: { count: jest.fn().mockResolvedValue(5) } }), cfg({ QUOTA_LAYOUT_JOBS_PER_MONTH: '5' }));
        await expect(svc.assertLayoutQuota('org1')).rejects.toMatchObject({ response: { metric: 'layout_jobs' } });
        const svc2 = new UsageService(prismaStub({ layoutJob: { count: jest.fn().mockResolvedValue(2) } }), cfg({ QUOTA_LAYOUT_JOBS_PER_MONTH: '10' }));
        await expect(svc2.assertLayoutQuota('org1')).resolves.toBeUndefined();
    });

    it('createLayoutGuarded: zero overhead when no quota; advisory-locked re-check (domain "layout") when set', async () => {
        const noQuota = prismaStub();
        const svc = new UsageService(noQuota, cfg({}));
        await expect(svc.createLayoutGuarded('org1', async () => ({ id: 'l1' }))).resolves.toEqual({ id: 'l1' });
        expect(rec(noQuota).$transaction).not.toHaveBeenCalled();

        const quota = prismaStub({ layoutJob: { count: jest.fn().mockResolvedValue(0) } });
        const svc2 = new UsageService(quota, cfg({ QUOTA_LAYOUT_CONCURRENT_PER_ORG: '5' }));
        await expect(svc2.createLayoutGuarded('org1', async () => ({ id: 'l2' }))).resolves.toEqual({ id: 'l2' });
        expect(rec(quota).$transaction).toHaveBeenCalledTimes(1);
        expect((rec(quota).$executeRaw.mock.calls[0][0] as TemplateStringsArray).join('?')).toMatch(/pg_advisory_xact_lock/);
    });

    it('createLayoutGuarded: rejects ORG_SUSPENDED before running the create (the /layouts write-gate that was bypassed)', async () => {
        const prisma = prismaStub({
            organization: { findUnique: jest.fn().mockResolvedValue({ suspendedAt: new Date(), suspendReason: 'abuse', quotaOverride: null }) },
        });
        const svc = new UsageService(prisma, cfg({}));
        const create = jest.fn();
        await expect(svc.createLayoutGuarded('org1', create as never)).rejects.toMatchObject({ response: { code: 'ORG_SUSPENDED' } });
        expect(create).not.toHaveBeenCalled();
        expect(rec(prisma).$transaction).not.toHaveBeenCalled();
    });

    it('createAssetGuarded: locked re-check rejects when the projected total exceeds the cap', async () => {
        const prisma = prismaStub();
        const svc = new UsageService(prisma, cfg({ QUOTA_STORAGE_BYTES_PER_ORG: '6000' }));
        // assets 5000 + results 200 + 2000 = 7200 > 6000 → 429 inside the lock; create never runs
        const create = jest.fn(async () => ({ id: 'asset-x' }));
        await expect(svc.createAssetGuarded('org1', 2000, create)).rejects.toMatchObject({
            response: { metric: 'storage_bytes' },
        });
        expect(create).not.toHaveBeenCalled();
        expect(rec(prisma).$transaction).toHaveBeenCalledTimes(1);
    });

    it('treats garbage/zero env limits as unlimited', async () => {
        const svc = new UsageService(prismaStub(), cfg({ QUOTA_SIM_JOBS_PER_MONTH: '0', QUOTA_SIM_RUNTIME_MS_PER_MONTH: 'abc' }));
        await expect(svc.assertSimQuota('org1')).resolves.toBeUndefined();
    });

    // ---------------------------------------------------------------- suspension + per-org overrides

    const overrideRow = (partial: Record<string, number | null>) => ({
        simConcurrent: null,
        simJobsPerMonth: null,
        simRuntimeMsPerMonth: null,
        designConcurrent: null,
        designJobsPerMonth: null,
        storageBytes: null,
        partsCallsPerMonth: null,
        updatedByAdminId: 'admin1',
        updatedAt: new Date(),
        ...partial,
    });

    it('assertOrgNotSuspended: 403 ORG_SUSPENDED for a suspended org, resolves otherwise', async () => {
        const suspended = prismaStub({
            organization: { findUnique: jest.fn().mockResolvedValue({ suspendedAt: new Date(), suspendReason: 'abuse', quotaOverride: null }) },
        });
        await expect(new UsageService(suspended, cfg({})).assertOrgNotSuspended('org1')).rejects.toMatchObject({
            response: { code: 'ORG_SUSPENDED' },
        });
        await expect(new UsageService(prismaStub(), cfg({})).assertOrgNotSuspended('org1')).resolves.toBeUndefined();
    });

    it('createSimGuarded: rejects ORG_SUSPENDED before running the create (write path blocked platform-wide)', async () => {
        const prisma = prismaStub({
            organization: { findUnique: jest.fn().mockResolvedValue({ suspendedAt: new Date(), suspendReason: 'abuse', quotaOverride: null }) },
        });
        const svc = new UsageService(prisma, cfg({}));
        const create = jest.fn();
        await expect(svc.createSimGuarded('org1', create as never)).rejects.toMatchObject({ response: { code: 'ORG_SUSPENDED' } });
        expect(create).not.toHaveBeenCalled();
        expect(rec(prisma).$transaction).not.toHaveBeenCalled();
    });

    it('a per-org override overrides the env default (tighter override wins)', async () => {
        // env allows 10 concurrent, override says 2, and 2 are in flight → 429 at the override limit
        const prisma = prismaStub({
            orgQuotaOverride: { findUnique: jest.fn().mockResolvedValue(overrideRow({ simConcurrent: 2 })) },
            simulationJob: { count: jest.fn().mockResolvedValue(2) },
        });
        const svc = new UsageService(prisma, cfg({ QUOTA_SIM_CONCURRENT_PER_ORG: '10' }));
        await expect(svc.assertSimQuota('org1')).rejects.toMatchObject({
            response: { metric: 'sim_concurrent', used: 2, limit: 2 },
        });
    });

    it('createSimGuarded: a per-org override enforces even with NO env quota (enters the advisory lock)', async () => {
        const prisma = prismaStub({
            organization: {
                findUnique: jest.fn().mockResolvedValue({ suspendedAt: null, suspendReason: null, quotaOverride: overrideRow({ simConcurrent: 1 }) }),
            },
            orgQuotaOverride: { findUnique: jest.fn().mockResolvedValue(overrideRow({ simConcurrent: 1 })) },
            simulationJob: { count: jest.fn().mockResolvedValue(1) }, // 1 in-flight >= override 1 → 429
        });
        const svc = new UsageService(prisma, cfg({})); // no env quota at all
        await expect(svc.createSimGuarded('org1', async () => ({ id: 'x' }))).rejects.toMatchObject({
            response: { metric: 'sim_concurrent', limit: 1 },
        });
        expect(rec(prisma).$transaction).toHaveBeenCalledTimes(1); // entered the lock despite no env quota
    });
});
