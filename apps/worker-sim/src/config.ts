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

    // Queue
    QUEUE_NAME: z.string().default('simulations'),
    CONCURRENCY: z.string().transform(Number).default('2'),

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