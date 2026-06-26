/**
 * Worker configuration
 */
import path from 'path';
import { z } from 'zod';
import dotenv from 'dotenv';

// The monorepo root .env is the single source of truth (see turbo.json globalDependencies).
// When run via pnpm/turbo the CWD is this package's dir, so the root .env sits two levels up.
// In Docker, env vars are injected directly, so a missing file here is harmless (no-op).
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
// Allow an optional per-package .env to override (does not clobber already-set values).
dotenv.config();

// Optional env string: a blank value ('') is coerced to undefined so it can't masquerade as a real setting
// (e.g. an empty LLM_BASE_URL must NOT reach the SDK as ""). Mirrors the API's lenient ConfigService reads.
const optStr = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
// Optional positive integer from env: blank / non-numeric / non-positive → undefined (so llm-core applies its
// own default rather than receiving NaN). Mirrors apps/api DesignService's num() helper.
const optPosInt = z.preprocess((v) => {
    const n = v === undefined || v === '' ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}, z.number().int().positive().optional());

const ConfigSchema = z.object({
    // Database
    DATABASE_URL: z.string().url(),

    // Redis
    REDIS_URL: z.string().default('redis://localhost:6379'),

    // S3
    S3_ENDPOINT: z.string().url(),
    S3_ACCESS_KEY: z.string(),
    S3_SECRET_KEY: z.string(),
    S3_BUCKET: z.string(),
    S3_REGION: z.string().default('us-east-1'),
    S3_FORCE_PATH_STYLE: z.string().transform((val) => val === 'true').default('true'),

    // Simulation
    SIM_TIMEOUT_MS: z.string().transform(Number).default('10000'),
    SIM_MAX_OUTPUT_BYTES: z.string().transform(Number).default('5242880'), // 5MB
    SIM_TEMP_DIR: z.string().default('/tmp/sim'),
    NGSPICE_PATH: z.string().default('ngspice'),
    // Cap the STORED series length (per probe). A long transient can emit ~1M rows; we min-max
    // bucket down to this before persisting so the DB/S3 payload, the API hydrate, and the response
    // are all bounded — without losing visible waveform features. Full original count kept in metrics.
    WORKER_MAX_POINTS: z.string().transform(Number).default('20000'),

    // OS resource-limit hardening for the ngspice child (Linux only — see sandbox.ts).
    // 'auto' (default): rlimit on Linux, none elsewhere. 'rlimit' forces it; 'none' disables it.
    SIM_SANDBOX: z.string().optional(),
    SIM_SANDBOX_MEMORY_MB: z.string().transform(Number).optional(),
    SIM_SANDBOX_CPU_SEC: z.string().transform(Number).optional(),
    SIM_SANDBOX_FSIZE_MB: z.string().transform(Number).optional(),
    SIM_SANDBOX_NPROC: z.string().transform(Number).optional(),
    // Run ngspice as this dedicated low-privilege user on Linux (via su-exec) — its own process-count
    // limit + no worker privileges. Legacy two-user mode; the default image runs the whole worker non-root
    // instead, so this is normally unset. NOTE: ignored when SIM_BWRAP is active (a bwrap userns has one uid).
    SIM_SANDBOX_USER: z.string().optional(),

    // Optional bubblewrap (rootless namespace) isolation of the ngspice CHILD — OFF by default. When
    // enabled ('1'/'true'/'on') AND a startup preflight confirms the host allows unprivileged user
    // namespaces, each ngspice run is wrapped in a fresh mount/PID/IPC/UTS + NETWORK namespace over a
    // read-only root, so a compromised ngspice has no network and no host-FS view beyond its job dir.
    // Needs a host that permits unprivileged userns + a seccomp profile allowing unshare/clone (e.g.
    // self-managed EC2/K8s nodes). Falls back to the rlimit hardening if the preflight fails. See SECURITY.md.
    SIM_BWRAP: z.string().optional(),
    SIM_BWRAP_PATH: z.string().default('bwrap'),

    // Queue
    QUEUE_NAME: z.string().default('simulations'),
    CONCURRENCY: z.string().transform(Number).default('2'),

    // Monte-Carlo yield analysis (the worker runs N perturbed variants of a verified design locally).
    MC_N_DEFAULT: z.string().transform(Number).default('300'), // max variants (also the orchestrator cap)
    MC_CI_HALFWIDTH_STOP: z.string().transform(Number).default('0.03'), // adaptive-N: stop at ±3% Wilson CI
    MC_BATCH_BUDGET_MS: z.string().transform(Number).default('60000'), // per-batch wall-clock cap (honest partial on hit)

    // --- AI design loop (the future 'design' queue worker; wired in stage iii). ALL optional so a sim-only
    // worker still boots WITHOUT an LLM key — when LLM_API_KEY is unset the design processor fails an
    // individual design JOB terminally (clear error) rather than refusing to start. These mirror the keys
    // apps/api DesignService reads from ConfigService, so the API and the worker run the identical loop. ---
    LLM_API_KEY: optStr,
    LLM_BASE_URL: optStr,
    LLM_MODEL: optStr,
    LLM_USER_AGENT: optStr,
    LLM_TIMEOUT_MS: optPosInt,
    LLM_TOKEN_BUDGET: optPosInt,
    DESIGN_MC_ENABLED: optStr, // 'false' disables the informational Monte-Carlo yield pass (default on)
    DESIGN_MC_RUNS: optPosInt, // MC variant-count override; falls back to MC_N_DEFAULT
    DESIGN_POLL_TIMEOUT_MS: optPosInt, // per-round sim poll budget (processor applies a default when unset)
    // SEPARATE queue + concurrency pool from 'simulations' — a design job polls its own per-round sims, so
    // sharing the sim pool would let design jobs hold every slot while waiting on sims = self-deadlock.
    DESIGN_QUEUE_NAME: z.string().default('design'),
    DESIGN_CONCURRENCY: z.string().transform(Number).default('2'),

    // Orphan reaper — the recovery half of the durable queue. A worker can die mid-job (OOM, node
    // recycle, spot reclaim) leaving a DesignJob row stuck RUNNING forever, and the insert↔enqueue gap can
    // leave a row stuck QUEUED that no worker ever sees. The reaper periodically reconciles such rows
    // against the queue's ground truth (queue.getJob state) and fails the genuinely-orphaned ones. Lease-
    // correct (it trusts BullMQ's view: a 'waiting'/'active'-within-deadline job is never reaped), so it
    // can't kill healthy work. Runs in the design worker (boot sweep + every REAPER_INTERVAL_MS).
    REAPER_INTERVAL_MS: z.string().transform(Number).default('60000'),
    // Don't examine a row younger than this — avoids racing a row whose enqueue hasn't settled yet.
    DESIGN_REAP_GRACE_MS: z.string().transform(Number).default('60000'),
    // Absolute cap for a job BullMQ still reports 'active': beyond this the worker is hung (the loop's own
    // hard ceiling is ~8 min: 4 rounds × 90s poll + 60s MC), so 30 min is generous headroom.
    DESIGN_REAP_RUNNING_DEADLINE_MS: z.string().transform(Number).default('1800000'),

    // Multi-candidate design generation (staged in; ALL default to today's behavior so this ships DARK).
    // DESIGN_CANDIDATES_N=1 → the orchestrator degenerates to a single runDesignLoop = the current code path.
    DESIGN_CANDIDATES_N: optPosInt,   // default 1 (resolved in code); recommended 4, hard-capped at 5
    DESIGN_FINALISTS_K: optPosInt,    // default 2; the K finalists that get the full fix-loop + (winner) MC
    DESIGN_JOB_LLM_BUDGET: optPosInt, // default 12; hard ceiling on paid LLM requests per design request
    // PROCESS-GLOBAL concurrency caps (NOT per-job) — the load-bearing perf lever once a job runs candidates
    // concurrently: peak concurrent ngspice = NGSPICE_GLOBAL_CONCURRENCY regardless of N. Unset → computed
    // from the box: max(1, floor(cores*0.75) - CONCURRENCY), reserving headroom for the 'simulations' queue.
    NGSPICE_GLOBAL_CONCURRENCY: optPosInt,
    GLOBAL_LLM_CONCURRENCY: optPosInt, // default 6 — caps in-flight LLM requests process-wide (provider RPM/TPM)

    // Logging
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

function loadConfig() {
    const result = ConfigSchema.safeParse(process.env);

    if (!result.success) {
        console.error('Configuration validation failed:');
        for (const error of result.error.errors) {
            console.error(`  ${error.path.join('.')}: ${error.message}`);
        }
        process.exit(1);
    }

    return result.data;
}

export const config = loadConfig();

export type Config = z.infer<typeof ConfigSchema>;