/**
 * OpenTelemetry bootstrap for the simulation worker. INERT until configured — the SDK only starts when
 * OTEL_ENABLED=true or an OTEL_EXPORTER_OTLP_ENDPOINT is set, so there is zero overhead by default
 * (mirrors the rest of the system's "configure to activate" philosophy). When on, auto-instrumentation
 * captures ioredis/Redis commands as traces (incl. the queue's Redis ops), and a periodic reader exports
 * metrics — both over OTLP/HTTP to a collector. (Prisma queries are NOT traced — needs
 * @prisma/instrumentation + schema `tracing`.) Telemetry must NEVER crash or block the worker: init is wrapped
 * in try/catch and failures are logged and swallowed.
 *
 * The bootstrap (startTelemetry/telemetryEnabled) is intentionally byte-identical to the API's
 * apps/api/src/observability/telemetry.ts — diff the two to confirm parity. startTelemetry() must run
 * before any instrumented module is loaded, so the side-effecting call lives in
 * observability/instrumentation.ts, which main.ts imports FIRST. The recordSim() helper below is
 * worker-specific (the worker is what actually runs ngspice).
 */
import { diag, DiagConsoleLogger, DiagLogLevel, metrics, type Counter, type Histogram } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

let sdk: NodeSDK | undefined;

/** True when telemetry is configured to run (used to gate startup logs + custom metrics). */
export function telemetryEnabled(): boolean {
    return process.env.OTEL_ENABLED === 'true' || !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
}

/**
 * Start the OTel SDK if configured. Idempotent + crash-safe. `serviceName` labels the traces/metrics
 * (overridable via OTEL_SERVICE_NAME). Endpoints come from the standard OTEL_EXPORTER_OTLP_ENDPOINT
 * (the exporters append /v1/traces and /v1/metrics).
 */
export function startTelemetry(serviceName: string): void {
    if (sdk || !telemetryEnabled()) return;
    try {
        if (process.env.OTEL_DEBUG === 'true') diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
        sdk = new NodeSDK({
            serviceName: process.env.OTEL_SERVICE_NAME || serviceName,
            traceExporter: new OTLPTraceExporter(),
            // 'metricReaders' (plural) is the current option; the singular 'metricReader' is deprecated
            // in sdk-node 0.219.0 and warns on every boot.
            metricReaders: [
                new PeriodicExportingMetricReader({
                    exporter: new OTLPMetricExporter(),
                    exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL_MS) || 30_000,
                }),
            ],
            instrumentations: [
                getNodeAutoInstrumentations({
                    '@opentelemetry/instrumentation-fs': { enabled: false }, // far too noisy
                }),
            ],
        });
        sdk.start();
        // eslint-disable-next-line no-console
        console.log(`[otel] telemetry started for "${process.env.OTEL_SERVICE_NAME || serviceName}"`);
    } catch (e) {
        // Observability must never take the service down.
        // eslint-disable-next-line no-console
        console.error('[otel] init failed — continuing without telemetry:', e instanceof Error ? e.message : e);
    }
}

/**
 * Flush + stop the SDK. App-owned (deliberately NOT registered as a signal handler here) so it slots
 * into each service's EXISTING graceful-shutdown sequence — the worker must drain its in-flight job and
 * disconnect Prisma before the process exits, and telemetry flushing must not pre-empt that with its own
 * process.exit(). No-op when telemetry never started. Best-effort: a failed flush never blocks shutdown.
 */
export async function shutdownTelemetry(): Promise<void> {
    try {
        await sdk?.shutdown();
    } catch {
        // best-effort final flush
    } finally {
        sdk = undefined;
    }
}

// ─── Custom simulation metrics ──────────────────────────────────────────────────────────────────
// The auto-instrumentation covers queue/DB plumbing; these capture the worker's actual job: how long
// ngspice runs take, how often they fail, and how big each run is. The points histogram is a direct
// memory-pressure proxy — it records the TRUE pre-downsample point count, so a dashboard/alert can
// catch the "transient blows up memory" case (giant M×N results) before it OOMs a worker.

export type SimStatus = 'succeeded' | 'failed' | 'timed_out';

let simRuns: Counter | undefined;
let simDuration: Histogram | undefined;
let simPoints: Histogram | undefined;

/**
 * Lazily create the instruments. Deferred (not created at module load) because the OTel metrics API
 * only wires instruments to a real exporter AFTER the MeterProvider is registered by startTelemetry();
 * by the time a job finishes, the SDK is up. Keeps cardinality low: the only attribute is `status`.
 */
function instruments(): { runs: Counter; duration: Histogram; points: Histogram } {
    if (!simRuns || !simDuration || !simPoints) {
        const meter = metrics.getMeter('circuit-forge-worker');
        simRuns = meter.createCounter('circuitforge.sim.runs', {
            description: 'Count of ngspice simulation runs, by outcome',
        });
        simDuration = meter.createHistogram('circuitforge.sim.duration', {
            description: 'ngspice simulation wall-clock runtime',
            unit: 'ms',
        });
        simPoints = meter.createHistogram('circuitforge.sim.points', {
            description: 'True (pre-downsample) simulated point count per run — a memory-pressure proxy',
            unit: '{point}',
        });
    }
    return { runs: simRuns, duration: simDuration, points: simPoints };
}

/**
 * Record one simulation outcome. No-op + crash-safe when telemetry is off. `durationMs`/`points` are
 * optional because some failure paths (e.g. a pre-run processing error) have neither.
 */
export function recordSim(opts: { status: SimStatus; durationMs?: number; points?: number }): void {
    if (!telemetryEnabled()) return;
    try {
        const { runs, duration, points } = instruments();
        const attrs = { status: opts.status };
        runs.add(1, attrs);
        if (typeof opts.durationMs === 'number') duration.record(opts.durationMs, attrs);
        if (typeof opts.points === 'number') points.record(opts.points, attrs);
    } catch {
        // Metrics must never break a job.
    }
}
