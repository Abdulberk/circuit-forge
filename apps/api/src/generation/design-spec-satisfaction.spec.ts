/**
 * #2 — "Verified" must mean "meets the spec," not "the sim ran".
 * The design loop now (a) reads the model's acceptance criteria, (b) checks them against the real sim,
 * (c) only reports ok:true+verified when they pass, (d) feeds failing criteria (with distance) AND the
 * worker's convergence diagnosis into the AI fix round. Anthropic SDK + SimulationService are mocked, so
 * this exercises the REAL llm-core parse + the REAL loop deterministically (no network, no ngspice).
 */
import type { ConfigService } from '@nestjs/config';
import type { PartsService } from '../parts/parts.service';
import type { SimulationService } from '../simulation/simulation.service';
import { sanitizeNodeName } from '@circuit-forge/eda-core';

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

const noSimulator = { available: () => false, simulate: jest.fn() } as unknown as CircuitSimulatorService;

const VALID_CIRCUIT = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'SIN(0 5 1k)', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '10k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'c1', type: 'capacitor', designator: 'C1', value: '100n', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [{ id: 'in', name: 'IN' }, { id: 'out', name: 'OUT' }, { id: 'gnd', name: 'GND', isGround: true }],
};

function makeConfig(): ConfigService {
    const v: Record<string, string | undefined> = { LLM_API_KEY: 'k', TME_TOKEN: 't', TME_SECRET: 's' };
    return { get: (k: string) => v[k] } as unknown as ConfigService;
}
function makeParts() {
    const part = { mpn: 'RC0603FR-0710KL', manufacturer: 'YAGEO', description: '10k', footprint: '0603', stock: 50000, unitCost: 0.002, currency: 'EUR', datasheetUrl: 'https://d/x.pdf', parameters: [], priceBreaks: [], supplier: 'tme', supplierId: 'SYM-RES-1' };
    return { search: jest.fn(async () => ({ items: [part], page: 1, pageSize: 1 })), getProduct: jest.fn(async () => part), getComponent: jest.fn(async () => ({ simulatable: true, component: {}, catalog: part })) };
}
function makeService(sim: SimulationService): DesignService {
    const cfg = makeConfig();
    return new DesignService(cfg, sim, new CatalogGroundingService(cfg, makeParts() as unknown as PartsService, noSimulator));
}

/** Make the model return ONE design (optionally with acceptance criteria). */
function generateOnce(acceptanceCriteria?: unknown[]) {
    mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: JSON.stringify({ circuit: VALID_CIRCUIT, analysisConfig: { type: 'op' }, explanation: 'x', ...(acceptanceCriteria ? { acceptanceCriteria } : {}) }) }],
    });
}
/** The model's next call (a fix round) returns a (still VALID) circuit. */
function fixOnce() {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify({ circuit: VALID_CIRCUIT, analysisConfig: { type: 'op' }, explanation: 'fixed' }) }] });
}

/** A SimulationService whose result series / status / metrics are configurable. `ys` are the y-samples of
 *  the "out" node — summarizeSeries derives min/max/final/pp from them (e.g. [-1.5,1.5] → pp=3). */
function makeSimSeries(opts: { status?: string; ys?: number[]; metrics?: Record<string, unknown> }): SimulationService {
    const node = `v(${sanitizeNodeName('out')})`;
    const series = opts.ys ? [{ name: node, points: opts.ys.map((y, i) => ({ x: i, y })) }] : [];
    const pc = opts.ys?.length ?? 1;
    return {
        createQuickSim: jest.fn(async () => ({ jobId: 'job-1' })),
        getStatus: jest.fn(async () => ({ status: opts.status ?? 'SUCCEEDED', metrics: opts.metrics ?? { pointsCount: pc } })),
        getResult: jest.fn(async () => ({ result: { meta: { pointsCount: pc }, series }, metrics: { pointsCount: pc } })),
    } as unknown as SimulationService;
}

describe('DesignService — spec satisfaction (#2: verified means meets-the-spec)', () => {
    beforeEach(() => mockCreate.mockReset());

    it('A — healthy sim that MEETS the acceptance criteria → ok:true, verified:true, one round, no fix', async () => {
        generateOnce([{ probe: 'out', metric: 'final', op: 'approx', value: 5, tol: 0.1 }]);
        const r = (await makeService(makeSimSeries({ ys: [5, 5] })).design({ prompt: 'reg to 5V', maxRounds: 2 } as never, 'u')) as Record<string, unknown>;
        expect(r.ok).toBe(true);
        expect(r.verified).toBe(true);
        expect((r.assertions as { pass: boolean }[])[0]!.pass).toBe(true);
        expect(mockCreate).toHaveBeenCalledTimes(1); // no fix round
    });

    it('B — healthy sim that MISSES the spec (gain 3 vs 10) → a fix round runs, ends ok:false NOT verified, gap surfaced', async () => {
        generateOnce([{ probe: 'out', metric: 'pp', op: 'gte', value: 9.5, label: 'gain ≥ 10' }]);
        fixOnce(); // round-1 specs fail → applyFix returns a (still-wrong) circuit
        const r = (await makeService(makeSimSeries({ ys: [-1.5, 1.5] })).design({ prompt: 'gain 10 amplifier', maxRounds: 2 } as never, 'u')) as Record<string, unknown>;
        expect(r.ok).toBe(false);
        expect(r.verified).toBe(false);
        expect(mockCreate).toHaveBeenCalledTimes(2); // initial generate + exactly one fix round
        const a = (r.assertions as { pass: boolean; distance: number }[])[0]!;
        expect(a.pass).toBe(false);
        expect(a.distance).toBeCloseTo(3 - 9.5, 5); // pp=3 vs ≥9.5 → catastrophic, signed
        expect(r.warning).toMatch(/acceptance criteria/i);
        // the fix prompt told the model WHAT to fix (the failing spec)
        expect(JSON.stringify(mockCreate.mock.calls[1]![0])).toMatch(/does NOT meet|gain/i);
    });

    it('D — no acceptance criteria (no measurable intent) → ok:true but verified:false (only proved it simulates)', async () => {
        generateOnce(); // no acceptanceCriteria
        const r = (await makeService(makeSimSeries({ ys: [5] })).design({ prompt: 'some circuit', maxRounds: 2 } as never, 'u')) as Record<string, unknown>;
        expect(r.ok).toBe(true);
        expect(r.verified).toBe(false);
        expect(r.assertions).toEqual([]);
        expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('F — SUCCEEDED but results unavailable (S3 offload) with criteria present → INCONCLUSIVE, not a spec fail', async () => {
        generateOnce([{ probe: 'out', metric: 'final', op: 'approx', value: 5, tol: 0.1 }]);
        // Healthy per metrics (pointsCount > 0) but the result carries NO series (offloaded + unfetchable).
        const sim = {
            createQuickSim: jest.fn(async () => ({ jobId: 'job-1' })),
            getStatus: jest.fn(async () => ({ status: 'SUCCEEDED', metrics: { pointsCount: 4242 } })),
            getResult: jest.fn(async () => ({ result: { meta: { pointsCount: 4242 } }, metrics: { pointsCount: 4242 }, error: 'Result data is currently unavailable from storage.' })),
        } as unknown as SimulationService;
        const r = (await makeService(sim).design({ prompt: 'reg to 5V', maxRounds: 2 } as never, 'u')) as Record<string, unknown>;
        expect(r.ok).toBe(false);
        expect(r.inconclusive).toBe(true); // storage issue, never a design fault
        expect(mockCreate).toHaveBeenCalledTimes(1); // NOT fed to the LLM as a "fix" — no fix round
    });

    it('G — MIXED criteria (one passes, one fails) → ok:false, only the FAILING one drives the fix', async () => {
        generateOnce([
            { probe: 'out', metric: 'final', op: 'approx', value: 5, tol: 0.1 }, // passes (final 5)
            { probe: 'out', metric: 'pp', op: 'gte', value: 10, label: 'swing ≥ 10' }, // fails (pp 0)
        ]);
        fixOnce();
        const r = (await makeService(makeSimSeries({ ys: [5, 5] })).design({ prompt: 'x', maxRounds: 2 } as never, 'u')) as Record<string, unknown>;
        expect(r.ok).toBe(false);
        expect(r.verified).toBe(false);
        const a = r.assertions as { pass: boolean }[];
        expect(a.filter((x) => x.pass).length).toBe(1);
        expect(a.filter((x) => !x.pass).length).toBe(1);
        // the fix prompt names the FAILING criterion (not the passing one)
        expect(JSON.stringify(mockCreate.mock.calls[1]![0])).toMatch(/swing|pp/);
    });

    it('H — malformed acceptance criteria are dropped by the REAL parser; only valid ones are checked', async () => {
        generateOnce([
            { probe: 'out', metric: 'final', op: 'approx', value: 5, tol: 0.1 }, // valid
            { probe: 'out', metric: 'BOGUS', op: 'gt', value: 1 }, // invalid metric → dropped
            { nonsense: true }, // junk → dropped
            { probe: 'out', metric: 'final', op: 'gt', value: 'NaNstring' }, // non-numeric value → dropped
        ]);
        const r = (await makeService(makeSimSeries({ ys: [5] })).design({ prompt: 'x', maxRounds: 1 } as never, 'u')) as Record<string, unknown>;
        expect((r.assertions as unknown[]).length).toBe(1); // 3 malformed dropped by parseAcceptanceCriteria
        expect(r.ok).toBe(true);
        expect(r.verified).toBe(true);
    });

    it('E — the worker convergence diagnosis is fed into the AI fix prompt (cheap win)', async () => {
        generateOnce();
        fixOnce();
        const sim = makeSimSeries({
            status: 'FAILED',
            metrics: { failureClass: 'sim', error: 'no convergence', convergence: { recovered: false, kind: 'no_convergence', diagnosis: 'matrix is singular at node out', triedRemedies: ['add gmin', 'relaxed tolerances'] } },
        });
        await makeService(sim).design({ prompt: 'stiff circuit', maxRounds: 2 } as never, 'u');
        expect(mockCreate).toHaveBeenCalledTimes(2);
        const fixArgs = JSON.stringify(mockCreate.mock.calls[1]![0]);
        expect(fixArgs).toMatch(/matrix is singular at node out/);
        expect(fixArgs).toMatch(/add gmin/);
    });
});
