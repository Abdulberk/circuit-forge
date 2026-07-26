/**
 * OpenTelemetry entry point — imported FIRST in main.ts (before any instrumented module) so the SDK
 * can patch ioredis/Redis at load time. Keeping the side-effecting start() call in its own module
 * guarantees the ordering.
 *
 * It ALSO loads the root .env here, before startTelemetry(): because this module runs first — before
 * config.ts loads .env — OTEL_ENABLED / OTEL_EXPORTER_OTLP_ENDPOINT read from the .env FILE wouldn't be
 * in process.env yet otherwise (so telemetry would silently stay off when configured via the file).
 * Uses Node's built-in process.loadEnvFile (≥ 20.12) — no dependency. No-op if the file is absent
 * (Docker/CI set env directly) and it does not override vars already in the real environment.
 *
 * Skipped under NODE_ENV=test so test runs never start the SDK or export test telemetry.
 */
import * as path from 'path';

import { startTelemetry } from './telemetry';

if (process.env.NODE_ENV !== 'test') {
    const loadEnvFile = (process as { loadEnvFile?: (p?: string) => void }).loadEnvFile;
    try {
        loadEnvFile?.(path.resolve(process.cwd(), '../../.env'));
    } catch {
        /* no root .env — env from the real environment */
    }
    startTelemetry('circuit-forge-worker');
}
