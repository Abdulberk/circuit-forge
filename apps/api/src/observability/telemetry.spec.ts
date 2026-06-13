/**
 * Gating + crash-safety for the OTel bootstrap. The SDK and exporters are mocked so the test asserts
 * the WIRING (inert when unconfigured, starts when configured, never throws) without spinning up real
 * exporters or registering global providers. The worker ships an identical bootstrap.
 */
const mockNodeSdkCtor = jest.fn();
const mockNodeSdkStart = jest.fn();
const mockNodeSdkShutdown = jest.fn().mockResolvedValue(undefined);

jest.mock('@opentelemetry/sdk-node', () => ({
    NodeSDK: jest.fn().mockImplementation((cfg: unknown) => {
        mockNodeSdkCtor(cfg);
        return { start: mockNodeSdkStart, shutdown: mockNodeSdkShutdown };
    }),
}));
jest.mock('@opentelemetry/auto-instrumentations-node', () => ({ getNodeAutoInstrumentations: jest.fn(() => []) }));
jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({ OTLPTraceExporter: jest.fn() }));
jest.mock('@opentelemetry/exporter-metrics-otlp-http', () => ({ OTLPMetricExporter: jest.fn() }));
jest.mock('@opentelemetry/sdk-metrics', () => ({ PeriodicExportingMetricReader: jest.fn() }));
jest.mock('@opentelemetry/exporter-logs-otlp-http', () => ({ OTLPLogExporter: jest.fn() }));
jest.mock('@opentelemetry/sdk-logs', () => ({ BatchLogRecordProcessor: jest.fn() }));
jest.mock('@prisma/instrumentation', () => ({ PrismaInstrumentation: jest.fn() }));

describe('telemetry bootstrap', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        process.env = { ...OLD_ENV };
        delete process.env.OTEL_ENABLED;
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
        delete process.env.OTEL_SERVICE_NAME;
        delete process.env.OTEL_DEBUG;
        // Don't leak signal listeners or print the startup banner during the suite.
        jest.spyOn(process, 'once').mockReturnValue(process as unknown as NodeJS.Process);
        jest.spyOn(console, 'log').mockImplementation(() => undefined);
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    afterAll(() => {
        process.env = OLD_ENV;
    });

    // Fresh module each time so the internal `sdk` singleton resets between cases.
    const load = () => require('./telemetry') as typeof import('./telemetry');

    describe('telemetryEnabled', () => {
        it('is false when nothing is configured', () => {
            expect(load().telemetryEnabled()).toBe(false);
        });

        it('is true when OTEL_ENABLED=true', () => {
            process.env.OTEL_ENABLED = 'true';
            expect(load().telemetryEnabled()).toBe(true);
        });

        it('is true when an OTLP endpoint is set (even without OTEL_ENABLED)', () => {
            process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
            expect(load().telemetryEnabled()).toBe(true);
        });

        it('is false for a non-"true" OTEL_ENABLED value', () => {
            process.env.OTEL_ENABLED = '1';
            expect(load().telemetryEnabled()).toBe(false);
        });
    });

    describe('startTelemetry', () => {
        it('is inert (constructs no SDK) and does not throw when disabled', () => {
            const t = load();
            expect(() => t.startTelemetry('circuit-forge-api')).not.toThrow();
            expect(mockNodeSdkCtor).not.toHaveBeenCalled();
        });

        it('starts the SDK with the given service name when enabled', () => {
            process.env.OTEL_ENABLED = 'true';
            load().startTelemetry('circuit-forge-api');
            expect(mockNodeSdkCtor).toHaveBeenCalledTimes(1);
            expect(mockNodeSdkCtor.mock.calls[0]![0]).toMatchObject({ serviceName: 'circuit-forge-api' });
            expect(mockNodeSdkStart).toHaveBeenCalledTimes(1);
        });

        it('honors OTEL_SERVICE_NAME over the passed default', () => {
            process.env.OTEL_ENABLED = 'true';
            process.env.OTEL_SERVICE_NAME = 'custom-name';
            load().startTelemetry('circuit-forge-api');
            expect(mockNodeSdkCtor.mock.calls[0]![0]).toMatchObject({ serviceName: 'custom-name' });
        });

        it('is idempotent — a second call does not start a second SDK', () => {
            process.env.OTEL_ENABLED = 'true';
            const t = load();
            t.startTelemetry('svc');
            t.startTelemetry('svc');
            expect(mockNodeSdkCtor).toHaveBeenCalledTimes(1);
        });

        it('never throws even if SDK start fails', () => {
            process.env.OTEL_ENABLED = 'true';
            mockNodeSdkStart.mockImplementationOnce(() => {
                throw new Error('exporter unreachable');
            });
            const t = load();
            expect(() => t.startTelemetry('svc')).not.toThrow();
        });
    });
});
