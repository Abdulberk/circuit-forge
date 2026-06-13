/**
 * OpenTelemetry entry point — imported FIRST in main.ts (before any instrumented module) so the SDK
 * can patch ioredis/Redis at load time. Keeping the side-effecting start() call in its own
 * module is what guarantees the ordering: the runtime evaluates this import fully — including the
 * startTelemetry() call below — before main.ts's next import is required. Inert unless OTEL is
 * configured (see telemetry.ts).
 */
import { startTelemetry } from './telemetry';

startTelemetry('circuit-forge-worker');
