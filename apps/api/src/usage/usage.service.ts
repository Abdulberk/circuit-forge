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
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** A Prisma client OR an interactive-transaction client — the read+write quota methods accept either,
 *  so the same code runs standalone or inside an advisory-locked transaction. */
type Db = PrismaService | Prisma.TransactionClient;

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
    private readonly logger = new Logger(UsageService.name);

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

    /** A QUOTA_* limit from env; unset/0/negative/garbage → null = unlimited. Integer (floored). */
    private limit(envKey: string): number | null {
        const raw = this.config.get<string>(envKey);
        if (raw === undefined || raw === '') return null;
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
            // A non-empty but unparseable value is almost always a typo ("10,000", "1_000", "10k").
            // Fail OPEN (unlimited) per the design, but make the silently-disabled quota visible —
            // '0' is the documented "unlimited" sentinel, so don't warn for it.
            if (raw.trim() !== '0') this.logger.warn(`Ignoring unparseable ${envKey}="${raw}" — quota left UNLIMITED.`);
            return null;
        }
        return Math.floor(n);
    }

    private quotaError(metric: string, used: number, limit: number, period = this.period()): HttpException {
        return new HttpException(
            {
                code: 'QUOTA_EXCEEDED',
                metric,
                used,
                limit,
                period,
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

    /** True iff any sim quota is configured — lets callers skip the locking path entirely otherwise. */
    hasSimQuota(): boolean {
        return (
            this.limit('QUOTA_SIM_CONCURRENT_PER_ORG') !== null ||
            this.limit('QUOTA_SIM_JOBS_PER_MONTH') !== null ||
            this.limit('QUOTA_SIM_RUNTIME_MS_PER_MONTH') !== null
        );
    }

    /** Jobs created by the org this month + their summed runtime — one aggregate row from the DB. */
    private async simUsageThisMonth(orgId: string, db: Db = this.prisma): Promise<{ jobs: number; runtimeMs: number }> {
        const { start, end } = this.monthRange();
        // metrics is JSONB; jsonb_typeof guards against null/absent/malformed runtimeMs entries.
        const rows = await db.$queryRaw<Array<{ jobs: number; runtimeMs: number }>>`
            SELECT COUNT(*)::int AS "jobs",
                   COALESCE(SUM(CASE WHEN jsonb_typeof(metrics -> 'runtimeMs') = 'number'
                                     THEN (metrics ->> 'runtimeMs')::float ELSE 0 END), 0)::float AS "runtimeMs"
            FROM simulation_jobs
            WHERE "orgId" = ${orgId} AND "createdAt" >= ${start} AND "createdAt" < ${end}`;
        return { jobs: rows[0]?.jobs ?? 0, runtimeMs: rows[0]?.runtimeMs ?? 0 };
    }

    /** The org's in-flight jobs RIGHT NOW — the multi-tenant fairness lever. */
    private async simConcurrent(orgId: string, db: Db = this.prisma): Promise<number> {
        return db.simulationJob.count({
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
     * Pass a transaction client to run the checks inside an advisory-locked tx (see createSimGuarded).
     */
    async assertSimQuota(orgId: string, db: Db = this.prisma): Promise<void> {
        const concurrentLimit = this.limit('QUOTA_SIM_CONCURRENT_PER_ORG');
        const jobsLimit = this.limit('QUOTA_SIM_JOBS_PER_MONTH');
        const runtimeLimit = this.limit('QUOTA_SIM_RUNTIME_MS_PER_MONTH');
        const [inFlight, monthly] = await Promise.all([
            concurrentLimit !== null ? this.simConcurrent(orgId, db) : null,
            jobsLimit !== null || runtimeLimit !== null ? this.simUsageThisMonth(orgId, db) : null,
        ]);
        if (inFlight !== null) this.enforce('sim_concurrent', inFlight, concurrentLimit);
        if (monthly !== null) {
            this.enforce('sim_jobs', monthly.jobs, jobsLimit);
            this.enforce('sim_runtime_ms', monthly.runtimeMs, runtimeLimit);
        }
    }

    /**
     * Authoritative sim-enqueue path. When a sim quota is configured, runs `create` under a per-org
     * advisory lock with the quota RE-CHECKED inside the lock — so concurrent same-org enqueues are
     * serialized and cannot race past the cap (the plain check-then-create is otherwise a soft cap
     * with an overshoot window). When no quota is set, runs `create` directly: ZERO added cost —
     * no transaction, no lock — preserving today's behavior. `create(tx)` must do only the job insert.
     */
    async createSimGuarded<T>(orgId: string, create: (tx: Db) => Promise<T>): Promise<T> {
        if (!this.hasSimQuota()) return create(this.prisma);
        return this.withOrgLock('sim', orgId, async (tx) => {
            await this.assertSimQuota(orgId, tx);
            return create(tx);
        });
    }

    // ---------------------------------------------------------------- storage

    /** Uploaded model assets + spilled result payloads (job metrics.outputSizeBytes), org-wide. */
    private async storageBytes(orgId: string, db: Db = this.prisma): Promise<{ assetBytes: number; resultBytes: number }> {
        const [assets, results] = await Promise.all([
            db.asset.aggregate({ where: { orgId }, _sum: { sizeBytes: true } }),
            // Only S3-spilled results occupy object storage; outputSizeBytes is what the worker measured.
            db.$queryRaw<Array<{ bytes: number }>>`
                SELECT COALESCE(SUM(CASE WHEN jsonb_typeof(metrics -> 'outputSizeBytes') = 'number'
                                         THEN (metrics ->> 'outputSizeBytes')::float ELSE 0 END), 0)::float AS "bytes"
                FROM simulation_jobs
                WHERE "orgId" = ${orgId} AND "resultS3Key" IS NOT NULL`,
        ]);
        return { assetBytes: assets._sum.sizeBytes ?? 0, resultBytes: results[0]?.bytes ?? 0 };
    }

    /** Gate an upload of `addBytes` against QUOTA_STORAGE_BYTES_PER_ORG (unset = unlimited). */
    async assertStorageQuota(orgId: string, addBytes: number, db: Db = this.prisma): Promise<void> {
        const limit = this.limit('QUOTA_STORAGE_BYTES_PER_ORG');
        if (limit === null) return;
        const { assetBytes, resultBytes } = await this.storageBytes(orgId, db);
        // `used` is the PROJECTED total (current + this upload), so the 429 always shows used > limit.
        const projected = assetBytes + resultBytes + Math.max(0, addBytes);
        if (projected > limit) throw this.quotaError('storage_bytes', projected, limit);
    }

    /**
     * Authoritative asset-commit path. Mirrors createSimGuarded: when QUOTA_STORAGE_BYTES_PER_ORG is
     * set, re-checks the storage cap under a per-org advisory lock so concurrent commits can't each
     * read the same pre-insert SUM and collectively blow past the cap. When unset, runs `create`
     * directly with no transaction/lock overhead.
     */
    async createAssetGuarded<T>(orgId: string, addBytes: number, create: (tx: Db) => Promise<T>): Promise<T> {
        if (this.limit('QUOTA_STORAGE_BYTES_PER_ORG') === null) return create(this.prisma);
        return this.withOrgLock('storage', orgId, async (tx) => {
            await this.assertStorageQuota(orgId, addBytes, tx);
            return create(tx);
        });
    }

    // ---------------------------------------------------------------- advisory locking

    /**
     * Run `fn` inside a transaction holding a per-(domain,org) PostgreSQL advisory lock. The lock is
     * transaction-scoped (pg_advisory_xact_lock) so it auto-releases at COMMIT/ROLLBACK — safe under
     * PgBouncer transaction pooling, and immune to leaks if `fn` throws. hashtextextended gives a
     * 64-bit key (collisions negligible), and prefixing the domain keeps 'sim' and 'storage' locks
     * for the same org independent. Different orgs never contend. Keep `fn` to the cheap check+insert
     * only — never wrap slow work (netlisting, S3) so lock hold time stays in the millisecond range.
     */
    private withOrgLock<T>(domain: string, orgId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
        return this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${domain}:${orgId}`}, 0))`;
            return fn(tx);
        });
    }

    // ---------------------------------------------------------------- parts (counter-based)

    private partsKey(userId: string, period: string) {
        return { scope: 'user', scopeId: userId, metric: 'parts_calls', period };
    }

    /**
     * Gate + count one catalog request for a USER (parts endpoints have no org context).
     *
     * The entire gate is a SINGLE atomic statement. INSERT seeds the first call of the period; on
     * conflict the DO UPDATE increments ONLY WHILE amount < limit. Under READ COMMITTED Postgres
     * re-evaluates that WHERE against the row version it locks (EvalPlanQual), so N concurrent
     * requests can never push the counter past the limit and there is no check-then-write window to
     * race — proven against the live DB (200-way concurrent burst lands exactly at the limit).
     * Prisma's upsert API can't express a conditional DO UPDATE, hence raw SQL; gen_random_uuid()
     * and now() provide the @id/@updatedAt values Prisma would otherwise compute client-side.
     */
    async assertAndCountPartsCall(userId: string): Promise<void> {
        const period = this.period();
        const key = this.partsKey(userId, period);
        const limit = this.limit('QUOTA_PARTS_CALLS_PER_MONTH');

        if (limit === null) {
            // Unlimited: pure metering. Prisma compiles this to a native atomic
            // INSERT ... ON CONFLICT DO UPDATE, so concurrent first-calls can't collide.
            await this.prisma.usageRecord.upsert({
                where: { scope_scopeId_metric_period: key },
                create: { ...key, amount: 1 },
                update: { amount: { increment: 1 } },
            });
            return;
        }

        const rows = await this.prisma.$queryRaw<Array<{ amount: number }>>`
            INSERT INTO usage_records (id, scope, "scopeId", metric, period, amount, "updatedAt")
            VALUES (gen_random_uuid(), ${key.scope}, ${key.scopeId}, ${key.metric}, ${key.period}, 1, now())
            ON CONFLICT (scope, "scopeId", metric, period)
            DO UPDATE SET amount = usage_records.amount + 1, "updatedAt" = now()
            WHERE usage_records.amount < ${limit}
            RETURNING amount`;
        if (rows.length > 0) return; // counted

        // No row returned ⇒ the row exists and is already at/over the limit. Read the true amount so
        // the 429 reports the real `used` (it can exceed `limit` if the limit was lowered mid-period).
        const row = await this.prisma.usageRecord.findUnique({ where: { scope_scopeId_metric_period: key } });
        throw this.quotaError('parts_calls', row?.amount ?? limit, limit, period);
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
