/**
 * pcb-worker configuration (mirrors apps/worker-sim/src/config.ts): monorepo-root .env is the single
 * source of truth, then an optional per-package .env, then a Zod schema validates process.env.
 */
import path from 'path';
import { z } from 'zod';
import dotenv from 'dotenv';

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
    // Routing headroom (mm/side) for the quality route; matches pcb-core's default. 0 = exact outline.
    PCB_ROUTING_MARGIN_MM: z.string().transform(Number).default('6'),

    // Native toolchain — set by the pcb-runtime image; defaults let a locally-installed toolchain work too.
    FREEROUTING_JAR: z.string().default('/app/freerouting-executable.jar'),
    JAVA_BIN: z.string().default('java'),
    KICAD_CLI: z.string().default('kicad-cli'),

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
