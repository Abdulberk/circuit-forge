/**
 * Proves the flagship /design-circuit endpoint is grounded too: the initial design call receives the
 * catalog tools, and the final (simulation-verified) circuit gets authoritative sourcing attached.
 * Anthropic SDK + SimulationService + PartsService are mocked (no network, no DB, no worker).
 */
import type { ConfigService } from '@nestjs/config';
import type { PartsService } from '../parts/parts.service';
import type { SimulationService } from '../simulation/simulation.service';

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
    __esModule: true,
    default: class MockAnthropic {
        messages = { create: mockCreate };
        constructor(_opts: unknown) {}
    },
}));

import { DesignService } from './design.service';
import { CatalogGroundingService } from './catalog-grounding.service';
import type { CircuitSimulatorService } from './circuit-simulator.service';

/** Stub simulator — unavailable, so these catalog-focused design tests are unchanged. */
const noSimulator = { available: () => false, simulate: jest.fn() } as unknown as CircuitSimulatorService;

const VALID_CIRCUIT = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'SIN(0 5 1k)', pins: [
            { pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '10k',
            pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }],
            mpn: 'RC0603FR-0710KL', manufacturer: 'YAGEO' },
        { id: 'c1', type: 'capacitor', designator: 'C1', value: '100n', pins: [
            { pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [{ id: 'in', name: 'IN' }, { id: 'out', name: 'OUT' }, { id: 'gnd', name: 'GND', isGround: true }],
};

function makeParts() {
    const part = {
        mpn: 'RC0603FR-0710KL', manufacturer: 'YAGEO', description: '10k 0603', footprint: '0603',
        stock: 50000, unitCost: 0.002, currency: 'EUR', datasheetUrl: 'https://d/x.pdf',
        parameters: [], priceBreaks: [], supplier: 'tme', supplierId: 'SYM-RES-1',
    };
    return {
        search: jest.fn(async () => ({ items: [part], page: 1, pageSize: 1 })),
        getProduct: jest.fn(async () => part),
        getComponent: jest.fn(async () => ({ simulatable: true, component: { type: 'resistor', value: '10K' }, catalog: part })),
    };
}

function makeConfig(): ConfigService {
    const v: Record<string, string | undefined> = { LLM_API_KEY: 'k', TME_TOKEN: 't', TME_SECRET: 's' };
    return { get: (k: string) => v[k] } as unknown as ConfigService;
}

/** A SimulationService that reports an immediately-successful run with data points. */
function makeSim(): SimulationService {
    return {
        createQuickSim: jest.fn(async () => ({ jobId: 'job-1' })),
        getStatus: jest.fn(async () => ({ status: 'SUCCEEDED', metrics: { pointsCount: 42 } })),
        getResult: jest.fn(async () => ({ result: { meta: { pointsCount: 42 } }, metrics: { pointsCount: 42 } })),
    } as unknown as SimulationService;
}

describe('DesignService grounding (flagship /design-circuit)', () => {
    beforeEach(() => mockCreate.mockReset());

    it('grounds the initial design and attaches sourcing to the simulation-verified circuit', async () => {
        // The model returns a grounded circuit directly (no tool_use needed for the assertion).
        mockCreate.mockResolvedValueOnce({
            content: [{ type: 'text', text: JSON.stringify({
                circuit: VALID_CIRCUIT, analysisConfig: { type: 'tran', stopTime: '5m', stepTime: '20u' },
                explanation: 'RC low-pass',
            }) }],
        });
        const cfg = makeConfig();
        const parts = makeParts();
        const service = new DesignService(cfg, makeSim(), new CatalogGroundingService(cfg, parts as unknown as PartsService, noSimulator));

        // No frequency/current target in the prompt: this test is about GROUNDING the happy path, not the
        // spec-coverage gate (which would otherwise block ok:true for an unmeasured named frequency — see
        // design-spec-satisfaction scenarios L/M). A plain description reaches the verified path cleanly.
        const result = await service.design({ prompt: 'an RC low-pass filter', maxRounds: 1 } as never, 'user-1');

        // Grounding was offered to the model on the initial design call.
        expect(mockCreate.mock.calls[0][0].tools).toBeDefined();
        // The verified circuit carries authoritative sourcing (the flagship endpoint is grounded too).
        const r1 = result.circuit.components.find((c) => c.id === 'r1')!;
        expect(r1.sourcing).toMatchObject({ supplier: 'tme', supplierId: 'SYM-RES-1', unitCost: 0.002 });
        expect(parts.getProduct).toHaveBeenCalled();
        expect(result.ok).toBe(true);
    });
});

/** SimulationService whose status / enqueue behavior is configurable for the operational-outcome tests. */
function makeSimWith(opts: { status?: string; createThrows?: boolean; failureClass?: string }): SimulationService {
    return {
        createQuickSim: jest.fn(async () => {
            if (opts.createThrows) throw new Error('Redis down');
            return { jobId: 'job-1' };
        }),
        getStatus: jest.fn(async () => ({
            status: opts.status ?? 'SUCCEEDED',
            metrics: { pointsCount: 42, ...(opts.failureClass ? { failureClass: opts.failureClass } : {}) },
        })),
        getResult: jest.fn(async () => ({ result: { meta: { pointsCount: 42 } }, metrics: { pointsCount: 42 } })),
    } as unknown as SimulationService;
}

/** Make the model return one valid design (the initial generate call). */
function initialDesignOnce() {
    mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: JSON.stringify({ circuit: VALID_CIRCUIT, analysisConfig: { type: 'op' }, explanation: 'x' }) }],
    });
}

function makeService(sim: SimulationService): DesignService {
    const cfg = makeConfig();
    return new DesignService(cfg, sim, new CatalogGroundingService(cfg, makeParts() as unknown as PartsService, noSimulator));
}

describe('DesignService — infra/operational outcomes are inconclusive, not a design fault', () => {
    beforeEach(() => mockCreate.mockReset());

    it('a queue/worker outage (enqueue throws) is INCONCLUSIVE — circuit returned, LLM NOT asked to "fix" it', async () => {
        initialDesignOnce();
        const r = (await makeService(makeSimWith({ createThrows: true })).design({ prompt: 'x', maxRounds: 2 } as never, 'user-1')) as Record<string, unknown>;
        expect(r.ok).toBe(false);
        expect(r.inconclusive).toBe(true);
        expect(r.circuit).toBeDefined();
        expect(mockCreate).toHaveBeenCalledTimes(1); // initial design only — no fix round on an infra outage
    });

    it('a job nothing consumes (poll never reaches a terminal state) is INCONCLUSIVE, not a sim failure', async () => {
        const prev = process.env.DESIGN_POLL_TIMEOUT_MS;
        process.env.DESIGN_POLL_TIMEOUT_MS = '1500'; // expire the server-side poll fast
        try {
            initialDesignOnce();
            const r = (await makeService(makeSimWith({ status: 'RUNNING' })).design({ prompt: 'x', maxRounds: 2 } as never, 'user-1')) as Record<string, unknown>;
            expect(r.ok).toBe(false);
            expect(r.inconclusive).toBe(true);
            expect(mockCreate).toHaveBeenCalledTimes(1); // no fix round
        } finally {
            if (prev === undefined) delete process.env.DESIGN_POLL_TIMEOUT_MS;
            else process.env.DESIGN_POLL_TIMEOUT_MS = prev;
        }
    });

    it('a genuine FAILED sim is NOT inconclusive — it stays a (fixable) circuit fault', async () => {
        initialDesignOnce();
        const r = (await makeService(makeSimWith({ status: 'FAILED' })).design({ prompt: 'x', maxRounds: 1 } as never, 'user-1')) as Record<string, unknown>;
        expect(r.ok).toBe(false);
        expect(r.inconclusive).toBeUndefined(); // ngspice ran and failed → a real fault, not an operational outcome
    });

    it('a worker INFRA failure (FAILED + failureClass=infra) is INCONCLUSIVE, NOT fed to the LLM', async () => {
        initialDesignOnce();
        const r = (await makeService(makeSimWith({ status: 'FAILED', failureClass: 'infra' })).design({ prompt: 'x', maxRounds: 2 } as never, 'user-1')) as Record<string, unknown>;
        expect(r.ok).toBe(false);
        expect(r.inconclusive).toBe(true);
        expect(mockCreate).toHaveBeenCalledTimes(1); // worker infra error → no "fix" round, no design-failed
    });
});
