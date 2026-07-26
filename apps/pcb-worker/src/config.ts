/**
 * pcb-worker configuration (mirrors apps/worker-sim/src/config.ts): monorepo-root .env is the single
 * source of truth, then an optional per-package .env, then a Zod schema validates process.env.
 */
import path from 'path';

import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
dotenv.config();

const ConfigSchema = z.object({
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().default('redis://localhost:6379'),

    // S3 / MinIO — GLB + Gerbers are too large for an inline Prisma column (see LAYOUTJOB_PLAN §3).
    S3_ENDPOINT: z.string().url(),
    S3_ACCESS_KEY: z.string(),
    S3_SECRET_KEY: z.string(),
    S3_BUCKET: z.string(),
    S3_REGION: z.string().default('us-east-1'),
    S3_FORCE_PATH_STYLE: z.string().transform((v) => v === 'true').default('true'),

    // Queue — SEPARATE from 'simulations'/'design'. PCB jobs are heavy (freerouting is CPU+memory bound,
    // 10–120s), so default concurrency 1 — the per-box lever against oversubscription (plan §5).
    PCB_QUEUE_NAME: z.string().default('pcb-layout'),
    PCB_CONCURRENCY: z.string().transform(Number).default('1'),
    // Routing headroom (mm/side) for the quality route. UNSET is the correct production setting: pcb-core then
    // walks its margin LADDER ([6, 4, 10, 2, 8, 12]) and keeps the first rung the DRC notary accepts. Freerouting
    // is NON-MONOTONIC in margin — a board that fails at 6 can be clean at 10 — so a single margin is not a
    // superset of the others. Setting this pins the route to that ONE margin (routeBestMargin treats an explicit
    // value as a binding cap), which withholds the fab bundle for every board whose clean rung is a different
    // one. Pin it only to reproduce a specific run. 0 = exact outline.
    PCB_ROUTING_MARGIN_MM: z.string().transform(Number).optional(),

    // Orphan reaper (mirrors worker-sim's design reaper) — recovers layout jobs a dead/redeployed worker left
    // stuck RUNNING, or the API's insert↔enqueue gap left QUEUED. It reconciles such rows against the queue's
    // ground truth (getJob state) and FAILs the genuine orphans; runs in this worker (boot sweep + interval).
    REAPER_INTERVAL_MS: z.string().transform(Number).default('60000'),
    // Don't examine a row younger than this — avoids racing a row whose enqueue hasn't settled yet.
    PCB_REAP_GRACE_MS: z.string().transform(Number).default('60000'),
    // Absolute cap for a job BullMQ still reports 'active': beyond this the worker is hung. A quality PCB job
    // (freerouting + kicad DRC, possibly a placer:'auto' ladder) can legitimately run several minutes, so this
    // is generous — it ONLY governs the rare hung-but-active case; a DEAD worker's row (missing/failed queue
    // job) is reaped right after the grace, independent of this deadline.
    PCB_REAP_RUNNING_DEADLINE_MS: z.string().transform(Number).default('3600000'),

    // Native toolchain — set by the pcb-runtime image; defaults let a locally-installed toolchain work too.
    FREEROUTING_JAR: z.string().default('/app/freerouting-executable.jar'),
    JAVA_BIN: z.string().default('java'),
    KICAD_CLI: z.string().default('kicad-cli'),
    RUST_PLACER_PATH: z.string().default('cf-pcb-place'),
    RUST_PLACER_TIMEOUT_MS: z.string().transform(Number).default('30000'),

    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

function loadConfig() {
    const result = ConfigSchema.safeParse(process.env);
    if (!result.success) {
        console.error('pcb-worker configuration validation failed:');
        for (const e of result.error.errors) console.error(`  ${e.path.join('.')}: ${e.message}`);
        process.exit(1);
    }
    return result.data;
}

export const config = loadConfig();
export type Config = z.infer<typeof ConfigSchema>;
