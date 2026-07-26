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
import { Prisma, OrgQuotaOverride } from '@prisma/client';

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
    design: {
        jobs: number; // agentic design jobs created this month
        concurrent: number; // QUEUED + RUNNING right now (not period-scoped)
        limits: { jobsPerMonth: number | null; concurrent: number | null };
    };
    layout: {
        jobs: number; // PCB layout jobs created this month
        concurrent: number; // QUEUED + RUNNING right now (not period-scoped)
        limits: { jobsPerMonth: number | null; concurrent: number | null };
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

/** JSON-safe view of a per-org quota override (storageBytes BigInt -> number so res.json can serialize). */
export interface QuotaOverrideView {
    simConcurrent: number | null;
    simJobsPerMonth: number | null;
    simRuntimeMsPerMonth: number | null;
    designConcurrent: number | null;
    designJobsPerMonth: number | null;
    storageBytes: number | null;
    partsCallsPerMonth: number | null;
    updatedByAdminId: string | null;
    updatedAt: Date;
}

/** The org usage snapshot the ADMIN console sees: same metering as OrgUsage but EFFECTIVE (override-aware)
 *  limits, no user-scoped parts count, plus the raw override row for transparency. */
export interface AdminOrgUsage {
    orgId: string;
    period: string;
    sim: OrgUsage['sim'];
    design: OrgUsage['design'];
    layout: OrgUsage['layout'];
    storage: OrgUsage['storage'];
    override: QuotaOverrideView | null;
}

/** Map a Prisma OrgQuotaOverride to a JSON-safe view (BigInt storageBytes -> number). */
export function toQuotaOverrideView(o: OrgQuotaOverride | null): QuotaOverrideView | null {
    if (!o) return null;
    return {
        simConcurrent: o.simConcurrent,
        simJobsPerMonth: o.simJobsPerMonth,
        simRuntimeMsPerMonth: o.simRuntimeMsPerMonth,
        designConcurrent: o.designConcurrent,
        designJobsPerMonth: o.designJobsPerMonth,
        storageBytes: o.storageBytes === null ? null : Number(o.storageBytes),
        partsCallsPerMonth: o.partsCallsPerMonth,
        updatedByAdminId: o.updatedByAdminId,
        updatedAt: o.updatedAt,
    };
}

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
    async assertSimQuota(orgId: string, db: Db = this.prisma, override?: OrgQuotaOverride | null): Promise<void> {
        const ov = override === undefined ? await this.loadOverride(orgId, db) : override;
        const concurrentLimit = this.effective('QUOTA_SIM_CONCURRENT_PER_ORG', ov?.simConcurrent);
        const jobsLimit = this.effective('QUOTA_SIM_JOBS_PER_MONTH', ov?.simJobsPerMonth);
        const runtimeLimit = this.effective('QUOTA_SIM_RUNTIME_MS_PER_MONTH', ov?.simRuntimeMsPerMonth);
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
        // Suspension is enforced for EVERY write (one PK-join read), regardless of quota config; the same
        // read tells us whether a per-org override is active, so an override enforces even with no env quota.
        const gate = await this.loadOrgGate(orgId);
        this.throwIfSuspended(gate);
        if (!this.hasSimQuota() && !this.simOverrideActive(gate.override)) return create(this.prisma);
        return this.withOrgLock('sim', orgId, async (tx) => {
            await this.assertSimQuota(orgId, tx); // re-loads the override fresh under the lock
            return create(tx);
        });
    }

    // ---------------------------------------------------------------- design jobs

    /**
     * One agentic DESIGN job is the billable/admission unit — NOT the per-round simulations it runs. Those
     * sims execute locally inside the design-queue worker and never touch this counter, so metering at the
     * job level (admission control at enqueue: gate once, before the work is queued) is both the natural
     * model and far cheaper than the old per-round locking. Actual consumption (rounds, sims, MC variants)
     * is recorded on the DesignJob.result for future credit-based settlement.
     */
    hasDesignQuota(): boolean {
        return (
            this.limit('QUOTA_DESIGN_CONCURRENT_PER_ORG') !== null ||
            this.limit('QUOTA_DESIGN_JOBS_PER_MONTH') !== null
        );
    }

    /** Design jobs the org created this month — drift-free COUNT from the source table (no counter row). */
    private async designJobsThisMonth(orgId: string, db: Db = this.prisma): Promise<number> {
        const { start, end } = this.monthRange();
        return db.designJob.count({ where: { orgId, createdAt: { gte: start, lt: end } } });
    }

    /** The org's in-flight (QUEUED+RUNNING) design jobs right now — the noisy-neighbor / abuse guard that
     *  matters most for an expensive LLM+simulation loop. Stale (crashed-worker) rows age out like sims. */
    private async designConcurrent(orgId: string, db: Db = this.prisma): Promise<number> {
        return db.designJob.count({
            where: {
                orgId,
                status: { in: ['QUEUED', 'RUNNING'] },
                createdAt: { gte: new Date(Date.now() - CONCURRENT_STALENESS_MS) },
            },
        });
    }

    /**
     * Gate a new design-job enqueue (each check skipped when its limit is unset):
     *  - QUOTA_DESIGN_CONCURRENT_PER_ORG — in-flight (QUEUED+RUNNING) cap; the primary abuse guard.
     *  - QUOTA_DESIGN_JOBS_PER_MONTH    — design jobs created this month.
     * Pass a tx client to run inside the advisory-locked tx (see createDesignGuarded).
     */
    async assertDesignQuota(orgId: string, db: Db = this.prisma, override?: OrgQuotaOverride | null): Promise<void> {
        const ov = override === undefined ? await this.loadOverride(orgId, db) : override;
        const concurrentLimit = this.effective('QUOTA_DESIGN_CONCURRENT_PER_ORG', ov?.designConcurrent);
        const jobsLimit = this.effective('QUOTA_DESIGN_JOBS_PER_MONTH', ov?.designJobsPerMonth);
        const [inFlight, monthly] = await Promise.all([
            concurrentLimit !== null ? this.designConcurrent(orgId, db) : null,
            jobsLimit !== null ? this.designJobsThisMonth(orgId, db) : null,
        ]);
        if (inFlight !== null) this.enforce('design_concurrent', inFlight, concurrentLimit);
        if (monthly !== null) this.enforce('design_jobs', monthly, jobsLimit);
    }

    /**
     * Authoritative design-enqueue path. Mirrors createSimGuarded: when a QUOTA_DESIGN_* limit is set,
     * runs `create` under a per-org advisory lock with the quota RE-CHECKED inside the lock (concurrent
     * same-org enqueues serialized, can't race past the cap). When unset, a plain create with ZERO added
     * cost — so merging changes nothing until a design quota is configured. Keep `create(tx)` to the
     * DesignJob insert only (the BullMQ add happens AFTER the lock releases — never hold a lock over Redis).
     */
    async createDesignGuarded<T>(orgId: string, create: (tx: Db) => Promise<T>): Promise<T> {
        const gate = await this.loadOrgGate(orgId);
        this.throwIfSuspended(gate);
        if (!this.hasDesignQuota() && !this.designOverrideActive(gate.override)) return create(this.prisma);
        return this.withOrgLock('design', orgId, async (tx) => {
            await this.assertDesignQuota(orgId, tx); // re-loads the override fresh under the lock
            return create(tx);
        });
    }

    // ---------------------------------------------------------------- PCB layout jobs

    /**
     * One PCB layout job (freerouting + kicad-cli, CPU/memory-heavy, minutes long) is the admission unit,
     * mirroring the design model. Env-only quotas for now — there is no per-org OrgQuotaOverride column for
     * layout yet (that would be an additive migration + admin-DTO change; a clean follow-up), so a layout
     * limit is configured globally via QUOTA_LAYOUT_* and enforced identically for every org.
     */
    hasLayoutQuota(): boolean {
        return (
            this.limit('QUOTA_LAYOUT_CONCURRENT_PER_ORG') !== null ||
            this.limit('QUOTA_LAYOUT_JOBS_PER_MONTH') !== null
        );
    }

    /** Layout jobs the org created this month — drift-free COUNT from the source table (no counter row). */
    private async layoutJobsThisMonth(orgId: string, db: Db = this.prisma): Promise<number> {
        const { start, end } = this.monthRange();
        return db.layoutJob.count({ where: { orgId, createdAt: { gte: start, lt: end } } });
    }

    /** The org's in-flight (QUEUED+RUNNING) layout jobs right now — the noisy-neighbor guard for an expensive
     *  freerouting+DRC pipeline. Stale (crashed-worker) rows drop out of this count via the staleness window,
     *  same as sims (and once merged, the LayoutJob reaper flips them terminal so they never linger). */
    private async layoutConcurrent(orgId: string, db: Db = this.prisma): Promise<number> {
        return db.layoutJob.count({
            where: {
                orgId,
                status: { in: ['QUEUED', 'RUNNING'] },
                createdAt: { gte: new Date(Date.now() - CONCURRENT_STALENESS_MS) },
            },
        });
    }

    /**
     * Gate a new layout enqueue (each check skipped when its limit is unset):
     *  - QUOTA_LAYOUT_CONCURRENT_PER_ORG — in-flight (QUEUED+RUNNING) cap; the primary abuse guard.
     *  - QUOTA_LAYOUT_JOBS_PER_MONTH    — layout jobs created this month.
     * Pass a tx client to run inside the advisory-locked tx (see createLayoutGuarded).
     */
    async assertLayoutQuota(orgId: string, db: Db = this.prisma): Promise<void> {
        const concurrentLimit = this.limit('QUOTA_LAYOUT_CONCURRENT_PER_ORG');
        const jobsLimit = this.limit('QUOTA_LAYOUT_JOBS_PER_MONTH');
        const [inFlight, monthly] = await Promise.all([
            concurrentLimit !== null ? this.layoutConcurrent(orgId, db) : null,
            jobsLimit !== null ? this.layoutJobsThisMonth(orgId, db) : null,
        ]);
        if (inFlight !== null) this.enforce('layout_concurrent', inFlight, concurrentLimit);
        if (monthly !== null) this.enforce('layout_jobs', monthly, jobsLimit);
    }

    /**
     * Authoritative layout-enqueue path. Mirrors createDesignGuarded: SUSPENSION is enforced for every
     * enqueue (a suspended org cannot start a PCB job — the gate every other job type had but /layouts was
     * bypassing); when a QUOTA_LAYOUT_* limit is set, the quota is RE-CHECKED under a per-org advisory lock
     * so concurrent same-org enqueues can't race past the cap. When unset, a plain create with ZERO added
     * cost. Keep `create(tx)` to the LayoutJob insert only (the BullMQ add happens AFTER the lock releases —
     * never hold a lock over Redis).
     */
    async createLayoutGuarded<T>(orgId: string, create: (tx: Db) => Promise<T>): Promise<T> {
        this.throwIfSuspended(await this.loadOrgGate(orgId));
        if (!this.hasLayoutQuota()) return create(this.prisma);
        return this.withOrgLock('layout', orgId, async (tx) => {
            await this.assertLayoutQuota(orgId, tx);
            return create(tx);
        });
    }

    // ---------------------------------------------------------------- storage

    /** Uploaded model assets + spilled result payloads (the ACTUAL persisted bytes), org-wide. */
    private async storageBytes(orgId: string, db: Db = this.prisma): Promise<{ assetBytes: number; resultBytes: number }> {
        const [assets, results] = await Promise.all([
            db.asset.aggregate({ where: { orgId }, _sum: { sizeBytes: true } }),
            // Only S3-spilled results occupy object storage. Count metrics.storedResultBytes — the downsampled +
            // serialized bytes ACTUALLY written to S3 — not outputSizeBytes (the raw ngspice size, which is many×
            // larger before the WORKER_MAX_POINTS downsample and would wrongly reject legit uploads). Fall back to
            // outputSizeBytes for rows written before storedResultBytes existed (over-estimate, but no worse than
            // the old behavior). See the worker's handleSuccess.
            db.$queryRaw<Array<{ bytes: number }>>`
                SELECT COALESCE(SUM(
                    CASE WHEN jsonb_typeof(metrics -> 'storedResultBytes') = 'number' THEN (metrics ->> 'storedResultBytes')::float
                         WHEN jsonb_typeof(metrics -> 'outputSizeBytes') = 'number'  THEN (metrics ->> 'outputSizeBytes')::float
                         ELSE 0 END), 0)::float AS "bytes"
                FROM simulation_jobs
                WHERE "orgId" = ${orgId} AND "resultS3Key" IS NOT NULL`,
        ]);
        return { assetBytes: assets._sum.sizeBytes ?? 0, resultBytes: results[0]?.bytes ?? 0 };
    }

    /** Gate an upload of `addBytes` against QUOTA_STORAGE_BYTES_PER_ORG (unset = unlimited). */
    async assertStorageQuota(orgId: string, addBytes: number, db: Db = this.prisma, override?: OrgQuotaOverride | null): Promise<void> {
        const ov = override === undefined ? await this.loadOverride(orgId, db) : override;
        const limit = this.effective('QUOTA_STORAGE_BYTES_PER_ORG', ov?.storageBytes);
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
        const gate = await this.loadOrgGate(orgId);
        this.throwIfSuspended(gate);
        if (this.limit('QUOTA_STORAGE_BYTES_PER_ORG') === null && !this.storageOverrideActive(gate.override)) {
            return create(this.prisma);
        }
        return this.withOrgLock('storage', orgId, async (tx) => {
            await this.assertStorageQuota(orgId, addBytes, tx); // re-loads the override fresh under the lock
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
        const [sim, concurrent, designJobs, designConcurrent, layoutJobs, layoutConcurrent, storage, partsRow] = await Promise.all([
            this.simUsageThisMonth(orgId),
            this.simConcurrent(orgId),
            this.designJobsThisMonth(orgId),
            this.designConcurrent(orgId),
            this.layoutJobsThisMonth(orgId),
            this.layoutConcurrent(orgId),
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
            design: {
                jobs: designJobs,
                concurrent: designConcurrent,
                limits: {
                    jobsPerMonth: this.limit('QUOTA_DESIGN_JOBS_PER_MONTH'),
                    concurrent: this.limit('QUOTA_DESIGN_CONCURRENT_PER_ORG'),
                },
            },
            layout: {
                jobs: layoutJobs,
                concurrent: layoutConcurrent,
                limits: {
                    jobsPerMonth: this.limit('QUOTA_LAYOUT_JOBS_PER_MONTH'),
                    concurrent: this.limit('QUOTA_LAYOUT_CONCURRENT_PER_ORG'),
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

    // ---------------------------------------------------------------- per-org overrides (admin)

    /** The per-org quota override row (null = none configured → every metric inherits the env default). */
    async loadOverride(orgId: string, db: Db = this.prisma): Promise<OrgQuotaOverride | null> {
        return db.orgQuotaOverride.findUnique({ where: { orgId } });
    }

    /**
     * The EFFECTIVE limit for one metric: a positive per-org override wins; otherwise the env default;
     * otherwise unlimited. A non-positive/absent override falls back to env — matching the env rule that
     * 0/blank = unlimited, so quotas are never *tightened* by a stray 0. Use suspension to hard-block.
     */
    private effective(envKey: string, override: number | bigint | null | undefined): number | null {
        if (override !== null && override !== undefined) {
            const n = typeof override === 'bigint' ? Number(override) : override;
            if (Number.isFinite(n) && n > 0) return Math.floor(n);
        }
        return this.limit(envKey);
    }

    // ---------------------------------------------------------------- suspension + override gating

    /** One read of the org's write-gate state: suspension + its quota override (a PK-join query). */
    private async loadOrgGate(
        orgId: string,
        db: Db = this.prisma,
    ): Promise<{ suspendedAt: Date | null; suspendReason: string | null; override: OrgQuotaOverride | null }> {
        const org = await db.organization.findUnique({
            where: { id: orgId },
            select: { suspendedAt: true, suspendReason: true, quotaOverride: true },
        });
        return {
            suspendedAt: org?.suspendedAt ?? null,
            suspendReason: org?.suspendReason ?? null,
            override: org?.quotaOverride ?? null,
        };
    }

    private throwIfSuspended(gate: { suspendedAt: Date | null; suspendReason: string | null }): void {
        if (gate.suspendedAt) {
            throw new HttpException(
                {
                    code: 'ORG_SUSPENDED',
                    message: 'This organization is suspended and cannot perform this action.',
                    suspendedAt: gate.suspendedAt,
                    reason: gate.suspendReason,
                },
                HttpStatus.FORBIDDEN,
            );
        }
    }

    /** Suspension gate for a write path that does NOT go through a guarded create (e.g. asset presign).
     *  READS must never call this — a suspended org keeps read access so its members can see the reason. */
    async assertOrgNotSuspended(orgId: string, db: Db = this.prisma): Promise<void> {
        this.throwIfSuspended(await this.loadOrgGate(orgId, db));
    }

    private simOverrideActive(o: OrgQuotaOverride | null): boolean {
        return !!o && (o.simConcurrent !== null || o.simJobsPerMonth !== null || o.simRuntimeMsPerMonth !== null);
    }
    private designOverrideActive(o: OrgQuotaOverride | null): boolean {
        return !!o && (o.designConcurrent !== null || o.designJobsPerMonth !== null);
    }
    private storageOverrideActive(o: OrgQuotaOverride | null): boolean {
        return !!o && o.storageBytes !== null;
    }

    /** Cross-tenant usage snapshot for the admin console — EFFECTIVE (override-aware) limits, no
     *  user-scoped parts count. Not membership-gated (the admin guard authorizes the caller). */
    async getOrgUsageForAdmin(orgId: string): Promise<AdminOrgUsage> {
        const period = this.period();
        const [sim, concurrent, designJobs, designConcurrent, layoutJobs, layoutConcurrent, storage, override] = await Promise.all([
            this.simUsageThisMonth(orgId),
            this.simConcurrent(orgId),
            this.designJobsThisMonth(orgId),
            this.designConcurrent(orgId),
            this.layoutJobsThisMonth(orgId),
            this.layoutConcurrent(orgId),
            this.storageBytes(orgId),
            this.loadOverride(orgId),
        ]);
        return {
            orgId,
            period,
            sim: {
                jobs: sim.jobs,
                runtimeMs: sim.runtimeMs,
                concurrent,
                limits: {
                    jobsPerMonth: this.effective('QUOTA_SIM_JOBS_PER_MONTH', override?.simJobsPerMonth),
                    runtimeMsPerMonth: this.effective('QUOTA_SIM_RUNTIME_MS_PER_MONTH', override?.simRuntimeMsPerMonth),
                    concurrent: this.effective('QUOTA_SIM_CONCURRENT_PER_ORG', override?.simConcurrent),
                },
            },
            design: {
                jobs: designJobs,
                concurrent: designConcurrent,
                limits: {
                    jobsPerMonth: this.effective('QUOTA_DESIGN_JOBS_PER_MONTH', override?.designJobsPerMonth),
                    concurrent: this.effective('QUOTA_DESIGN_CONCURRENT_PER_ORG', override?.designConcurrent),
                },
            },
            layout: {
                jobs: layoutJobs,
                concurrent: layoutConcurrent,
                // Env-only limits — there is no per-org OrgQuotaOverride column for layout yet (a clean
                // additive-migration follow-up), so the admin snapshot shows the global QUOTA_LAYOUT_* values.
                limits: {
                    jobsPerMonth: this.limit('QUOTA_LAYOUT_JOBS_PER_MONTH'),
                    concurrent: this.limit('QUOTA_LAYOUT_CONCURRENT_PER_ORG'),
                },
            },
            storage: {
                assetBytes: storage.assetBytes,
                resultBytes: storage.resultBytes,
                totalBytes: storage.assetBytes + storage.resultBytes,
                limits: { bytes: this.effective('QUOTA_STORAGE_BYTES_PER_ORG', override?.storageBytes) },
            },
            override: toQuotaOverrideView(override),
        };
    }
}
