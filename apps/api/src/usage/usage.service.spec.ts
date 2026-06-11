import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsageService } from './usage.service';
import type { PrismaService } from '../prisma/prisma.service';

/** ConfigService stub backed by a plain object. */
const cfg = (vals: Record<string, string>) =>
    ({ get: (k: string) => vals[k] }) as unknown as ConfigService;

/**
 * Minimal prisma stub. Aggregation now happens via $queryRaw (single-row results); the stub
 * dispatches on the SQL text: the month aggregate selects runtimeMs, the storage one outputSizeBytes.
 */
function prismaStub(over: Partial<Record<string, unknown>> = {}) {
    return {
        $queryRaw: jest.fn().mockImplementation((strings: TemplateStringsArray) => {
            const sql = strings.join('?');
            if (sql.includes('runtimeMs')) return Promise.resolve([{ jobs: 3, runtimeMs: 350 }]);
            return Promise.resolve([{ bytes: 200 }]); // spilled-result storage
        }),
        simulationJob: { count: jest.fn().mockResolvedValue(1) },
        asset: { aggregate: jest.fn().mockResolvedValue({ _sum: { sizeBytes: 5000 } }) },
        usageRecord: {
            findUnique: jest.fn().mockResolvedValue({ amount: 7 }),
            upsert: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            create: jest.fn().mockResolvedValue({}),
        },
        ...over,
    } as unknown as PrismaService;
}

const records = (prisma: PrismaService) =>
    prisma as unknown as { usageRecord: Record<'findUnique' | 'upsert' | 'updateMany' | 'create', jest.Mock> };

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
        // no env limits configured → everything unlimited (null)
        expect(u.sim.limits.jobsPerMonth).toBeNull();
        expect(u.storage.limits.bytes).toBeNull();
    });

    it('quota gates are NO-OPS when no limits are configured (but parts metering still counts)', async () => {
        const prisma = prismaStub();
        const svc = new UsageService(prisma, cfg({}));
        await expect(svc.assertSimQuota('org1')).resolves.toBeUndefined();
        await expect(svc.assertStorageQuota('org1', 10_000_000)).resolves.toBeUndefined();
        await expect(svc.assertAndCountPartsCall('user1')).resolves.toBeUndefined();
        // no limit → no gate queries at all, just the metering upsert
        expect((prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw).not.toHaveBeenCalled();
        expect(records(prisma).usageRecord.upsert).toHaveBeenCalledTimes(1);
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

    it('parts gate increments atomically via conditional updateMany (true ceiling, no read-then-write race)', async () => {
        const prisma = prismaStub();
        const svc = new UsageService(prisma, cfg({ QUOTA_PARTS_CALLS_PER_MONTH: '100' }));
        await svc.assertAndCountPartsCall('user1');
        const um = records(prisma).usageRecord.updateMany;
        expect(um).toHaveBeenCalledTimes(1);
        expect(um.mock.calls[0][0].where.amount).toEqual({ lt: 100 });
        expect(records(prisma).usageRecord.findUnique).not.toHaveBeenCalled(); // hit → no extra read
    });

    it('parts gate 429s at the limit without advancing the counter', async () => {
        const prisma = prismaStub({
            usageRecord: {
                updateMany: jest.fn().mockResolvedValue({ count: 0 }), // conditional update missed: at limit
                findUnique: jest.fn().mockResolvedValue({ amount: 7 }),
                create: jest.fn(),
                upsert: jest.fn(),
            },
        });
        const svc = new UsageService(prisma, cfg({ QUOTA_PARTS_CALLS_PER_MONTH: '7' }));
        await expect(svc.assertAndCountPartsCall('user1')).rejects.toMatchObject({
            response: { metric: 'parts_calls', used: 7, limit: 7 },
        });
        expect(records(prisma).usageRecord.create).not.toHaveBeenCalled();
    });

    it("parts gate creates the row on a user's first call of the period (and survives a creation race)", async () => {
        const prisma = prismaStub({
            usageRecord: {
                updateMany: jest.fn().mockResolvedValue({ count: 0 }), // no row yet
                findUnique: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue({}),
                upsert: jest.fn(),
            },
        });
        const svc = new UsageService(prisma, cfg({ QUOTA_PARTS_CALLS_PER_MONTH: '100' }));
        await expect(svc.assertAndCountPartsCall('user1')).resolves.toBeUndefined();
        expect(records(prisma).usageRecord.create).toHaveBeenCalledTimes(1);

        // lost the creation race → falls back to the atomic increment
        const racy = prismaStub({
            usageRecord: {
                updateMany: jest.fn().mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 }),
                findUnique: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockRejectedValue(new Error('unique violation')),
                upsert: jest.fn(),
            },
        });
        const svc2 = new UsageService(racy, cfg({ QUOTA_PARTS_CALLS_PER_MONTH: '100' }));
        await expect(svc2.assertAndCountPartsCall('user1')).resolves.toBeUndefined();
        expect(records(racy).usageRecord.updateMany).toHaveBeenCalledTimes(2);
    });

    it('treats garbage/zero env limits as unlimited', async () => {
        const svc = new UsageService(prismaStub(), cfg({ QUOTA_SIM_JOBS_PER_MONTH: '0', QUOTA_SIM_RUNTIME_MS_PER_MONTH: 'abc' }));
        await expect(svc.assertSimQuota('org1')).resolves.toBeUndefined();
    });
});
