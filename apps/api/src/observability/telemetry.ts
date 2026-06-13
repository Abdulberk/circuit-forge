/**
 * OpenTelemetry bootstrap. INERT until configured — the SDK only starts when OTEL_ENABLED=true or an
 * OTEL_EXPORTER_OTLP_ENDPOINT is set, so there is zero overhead by default (mirrors the rest of the
 * system's "configure to activate" philosophy). When on, auto-instrumentation captures HTTP/Express/
 * Nest requests (+ outgoing HTTP), ioredis/Redis commands, and Prisma DB queries as traces; pino logs
 * are exported as OTLP logs (trace-correlated); and a periodic reader exports metrics — all over
 * OTLP/HTTP to a collector. Telemetry must NEVER crash the app: init is
 * wrapped in try/catch and failures are logged and swallowed.
 *
 * startTelemetry() must run before any instrumented module is loaded, so the side-effecting call lives
 * in observability/instrumentation.ts, which main.ts imports FIRST. This file stays pure (no start on
 * import) so it's unit-testable.
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';

let sdk: NodeSDK | undefined;

/** True when telemetry is configured to run (used to gate startup logs). */
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
            // pino logs → OTLP logs (the pino auto-instrumentation bridges them once a LoggerProvider
            // is registered, which these processors do). Trace context is injected, so logs correlate
            // with their span in Grafana.
            logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
            instrumentations: [
                getNodeAutoInstrumentations({
                    '@opentelemetry/instrumentation-fs': { enabled: false }, // far too noisy
                }),
                // NOTE: @prisma/instrumentation@5.22 is INCOMPATIBLE with sdk-trace-base@1.30.1 (it calls
                // the removed parentTracer.getActiveSpanProcessor() → crashes on the first query). Prisma
                // DB-query spans are therefore disabled until the versions line up. See docs/OBSERVABILITY.md.
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
