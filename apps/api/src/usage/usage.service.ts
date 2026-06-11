/**
 * Usage metering + quota gates.
 *
 * Design principles:
 *  - METERING IS ALWAYS ON, QUOTAS DEFAULT TO UNLIMITED: every limit comes from a QUOTA_* env var and
 *    an unset/zero value means "no limit" — merging this changes NOTHING until limits are configured.
 *  - DRIFT-FREE WHERE POSSIBLE: sim jobs/runtime and storage are aggregated ON-DEMAND from their source
 *    tables (SimulationJob, Asset) instead of counters, so the numbers can never disagree with reality.
 *    Aggregation happens IN the database (single-row results), never by streaming rows into JS.
 *    Only metrics with no natural source table (parts catalog calls) use UsageRecord counter rows.
 *  - Periods are UTC calendar months ('YYYY-MM').
 *  - Parts calls are metered PER REQUEST on the user-facing catalog routes (cache hits included —
 *    the billable unit is the API request, not the upstream TME call). Facet routes
 *    (manufacturers/categories) and internal AI design-loop grounding lookups are intentionally
 *    NOT metered; AI-path quotas are a separate, deferred concern.
 *
 * Quota violations throw 429 with a STRUCTURED body: { code: 'QUOTA_EXCEEDED', metric, used, limit,
 * period } — the frontend can show "X of Y used this month" without parsing prose. `used` >= `limit`
 * holds in every 429 (storage reports the PROJECTED total including the rejected upload).
 */
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

export interface OrgUsage {
    period: string;
    sim: {
        jobs: number;
        runtimeMs: number;
        concurrent: number; // QUEUED + RUNNING right now (not period-scoped)
        limits: { jobsPerMonth: number | null; runtimeMsPerMonth: number | null; concurrent: number | null };
    };
    storage: {
        assetBytes: number;
        resultBytes: number;
        totalBytes: number;
        limits: { bytes: number | null };
    };
    parts: {
        calls: number; // the REQUESTING USER's calls this period (parts endpoints are user-scoped)
        limits: { callsPerMonth: number | null };
    };
}

/** A job still QUEUED/RUNNING after this long is an orphan (crashed worker) — it must not count
 *  against the concurrency gate forever. Worker timeouts are seconds; 24h is generous. */
const CONCURRENT_STALENESS_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class UsageService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly config: ConfigService,
    ) {}

    /** Current UTC month period key, e.g. '2026-06'. */
    period(now = new Date()): string {
        return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    }

    /** [start, end) of the current UTC month. */
    private monthRange(now = new Date()): { start: Date; end: Date } {
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
        return { start, end };
    }

    /** A QUOTA_* limit from env; unset/0/negative/garbage → null = unlimited. */
    private limit(envKey: string): number | null {
        const raw = this.config.get<string>(envKey);
        if (raw === undefined || raw === '') return null;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    private quotaError(metric: string, used: number, limit: number): HttpException {
        return new HttpException(
            {
                code: 'QUOTA_EXCEEDED',
                metric,
                used,
                limit,
                period: this.period(),
                message: `Quota exceeded for ${metric}: ${used} of ${limit} used this period.`,
            },
            HttpStatus.TOO_MANY_REQUESTS,
        );
    }

    /** Throw the structured 429 when a configured limit is reached (null limit = unlimited = no-op). */
    private enforce(metric: string, used: number, limit: number | null): void {
        if (limit !== null && used >= limit) throw this.quotaError(metric, used, limit);
    }

    // ---------------------------------------------------------------- sims

    /** Jobs created by the org this month + their summed runtime — one aggregate row from the DB. */
    private async simUsageThisMonth(orgId: string): Promise<{ jobs: number; runtimeMs: number }> {
        const { start, end } = this.monthRange();
        // metrics is JSONB; jsonb_typeof guards against null/absent/malformed runtimeMs entries.
        const rows = await this.prisma.$queryRaw<Array<{ jobs: number; runtimeMs: number }>>`
            SELECT COUNT(*)::int AS "jobs",
                   COALESCE(SUM(CASE WHEN jsonb_typeof(metrics -> 'runtimeMs') = 'number'
                                     THEN (metrics ->> 'runtimeMs')::float ELSE 0 END), 0)::float AS "runtimeMs"
            FROM simulation_jobs
            WHERE "orgId" = ${orgId} AND "createdAt" >= ${start} AND "createdAt" < ${end}`;
        return { jobs: rows[0]?.jobs ?? 0, runtimeMs: rows[0]?.runtimeMs ?? 0 };
    }

    /** The org's in-flight jobs RIGHT NOW — the multi-tenant fairness lever. */
    private async simConcurrent(orgId: string): Promise<number> {
        return this.prisma.simulationJob.count({
            where: {
                orgId,
                status: { in: ['QUEUED', 'RUNNING'] },
                createdAt: { gte: new Date(Date.now() - CONCURRENT_STALENESS_MS) },
            },
        });
    }

    /**
     * Gate a new simulation enqueue. Checks (each skipped when its limit is unset):
     *  - QUOTA_SIM_CONCURRENT_PER_ORG — in-flight (QUEUED+RUNNING) cap; the noisy-neighbor guard.
     *  - QUOTA_SIM_JOBS_PER_MONTH    — job count this month.
     *  - QUOTA_SIM_RUNTIME_MS_PER_MONTH — summed worker runtime this month.
     */
    async assertSimQuota(orgId: string): Promise<void> {
        const concurrentLimit = this.limit('QUOTA_SIM_CONCURRENT_PER_ORG');
        const jobsLimit = this.limit('QUOTA_SIM_JOBS_PER_MONTH');
        const runtimeLimit = this.limit('QUOTA_SIM_RUNTIME_MS_PER_MONTH');
        const [inFlight, monthly] = await Promise.all([
            concurrentLimit !== null ? this.simConcurrent(orgId) : null,
            jobsLimit !== null || runtimeLimit !== null ? this.simUsageThisMonth(orgId) : null,
        ]);
        if (inFlight !== null) this.enforce('sim_concurrent', inFlight, concurrentLimit);
        if (monthly !== null) {
            this.enforce('sim_jobs', monthly.jobs, jobsLimit);
            this.enforce('sim_runtime_ms', monthly.runtimeMs, runtimeLimit);
        }
    }

    // ---------------------------------------------------------------- storage

    /** Uploaded model assets + spilled result payloads (job metrics.outputSizeBytes), org-wide. */
    private async storageBytes(orgId: string): Promise<{ assetBytes: number; resultBytes: number }> {
        const [assets, results] = await Promise.all([
            this.prisma.asset.aggregate({ where: { orgId }, _sum: { sizeBytes: true } }),
            // Only S3-spilled results occupy object storage; outputSizeBytes is what the worker measured.
            this.prisma.$queryRaw<Array<{ bytes: number }>>`
                SELECT COALESCE(SUM(CASE WHEN jsonb_typeof(metrics -> 'outputSizeBytes') = 'number'
                                         THEN (metrics ->> 'outputSizeBytes')::float ELSE 0 END), 0)::float AS "bytes"
                FROM simulation_jobs
                WHERE "orgId" = ${orgId} AND "resultS3Key" IS NOT NULL`,
        ]);
        return { assetBytes: assets._sum.sizeBytes ?? 0, resultBytes: results[0]?.bytes ?? 0 };
    }

    /** Gate an upload of `addBytes` against QUOTA_STORAGE_BYTES_PER_ORG (unset = unlimited). */
    async assertStorageQuota(orgId: string, addBytes: number): Promise<void> {
        const limit = this.limit('QUOTA_STORAGE_BYTES_PER_ORG');
        if (limit === null) return;
        const { assetBytes, resultBytes } = await this.storageBytes(orgId);
        // `used` is the PROJECTED total (current + this upload), so the 429 always shows used > limit.
        const projected = assetBytes + resultBytes + Math.max(0, addBytes);
        if (projected > limit) throw this.quotaError('storage_bytes', projected, limit);
    }

    // ---------------------------------------------------------------- parts (counter-based)

    private partsKey(userId: string, period: string) {
        return { scope: 'user', scopeId: userId, metric: 'parts_calls', period };
    }

    /**
     * Gate + count one catalog request for a USER (parts endpoints have no org context).
     * The conditional `amount < limit` UPDATE is atomic, so the cap is a true ceiling even under
     * concurrent requests — there is no check-then-write window to race through.
     */
    async assertAndCountPartsCall(userId: string): Promise<void> {
        const key = this.partsKey(userId, this.period());
        const limit = this.limit('QUOTA_PARTS_CALLS_PER_MONTH');
        if (limit === null) {
            await this.prisma.usageRecord.upsert({
                where: { scope_scopeId_metric_period: key },
                create: { ...key, amount: 1 },
                update: { amount: { increment: 1 } },
            });
            return;
        }
        const hit = await this.prisma.usageRecord.updateMany({
            where: { ...key, amount: { lt: limit } },
            data: { amount: { increment: 1 } },
        });
        if (hit.count === 1) return;
        // No row was updated: either the user is at the limit, or this is their first call this period.
        const row = await this.prisma.usageRecord.findUnique({ where: { scope_scopeId_metric_period: key } });
        if (row) throw this.quotaError('parts_calls', row.amount, limit);
        try {
            await this.prisma.usageRecord.create({ data: { ...key, amount: 1 } });
        } catch {
            // Lost the row-creation race to a parallel first call — fall back to the atomic increment.
            const retry = await this.prisma.usageRecord.updateMany({
                where: { ...key, amount: { lt: limit } },
                data: { amount: { increment: 1 } },
            });
            if (retry.count !== 1) throw this.quotaError('parts_calls', limit, limit);
        }
    }

    // ---------------------------------------------------------------- reporting

    /** The usage snapshot for an org (+ the requesting user's parts calls). Membership checked by the caller. */
    async getOrgUsage(orgId: string, userId: string): Promise<OrgUsage> {
        const period = this.period();
        const [sim, concurrent, storage, partsRow] = await Promise.all([
            this.simUsageThisMonth(orgId),
            this.simConcurrent(orgId),
            this.storageBytes(orgId),
            this.prisma.usageRecord.findUnique({
                where: { scope_scopeId_metric_period: this.partsKey(userId, period) },
            }),
        ]);
        return {
            period,
            sim: {
                jobs: sim.jobs,
                runtimeMs: sim.runtimeMs,
                concurrent,
                limits: {
                    jobsPerMonth: this.limit('QUOTA_SIM_JOBS_PER_MONTH'),
                    runtimeMsPerMonth: this.limit('QUOTA_SIM_RUNTIME_MS_PER_MONTH'),
                    concurrent: this.limit('QUOTA_SIM_CONCURRENT_PER_ORG'),
                },
            },
            storage: {
                assetBytes: storage.assetBytes,
                resultBytes: storage.resultBytes,
                totalBytes: storage.assetBytes + storage.resultBytes,
                limits: { bytes: this.limit('QUOTA_STORAGE_BYTES_PER_ORG') },
            },
            parts: {
                calls: partsRow?.amount ?? 0,
                limits: { callsPerMonth: this.limit('QUOTA_PARTS_CALLS_PER_MONTH') },
            },
        };
    }
}
