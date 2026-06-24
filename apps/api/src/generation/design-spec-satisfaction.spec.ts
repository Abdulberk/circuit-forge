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

// Same RC topology but the source declares an AC magnitude, so the REAL generateNetlist accepts an `.ac`
// analysis (it rejects a frequency-response request with a DC-only source). Used by the cutoff scenario.
const VALID_CIRCUIT_AC = {
    ...VALID_CIRCUIT,
    components: VALID_CIRCUIT.components.map((c) => (c.id === 'v1' ? { ...c, value: 'AC 1' } : c)),
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
/** A fix round that ALSO returns (revised) acceptance criteria — e.g. adding a current check the coverage
 *  gate demanded. */
function fixOnceWithCriteria(acceptanceCriteria: unknown[]) {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify({ circuit: VALID_CIRCUIT, analysisConfig: { type: 'op' }, explanation: 'fixed', acceptanceCriteria }) }] });
}

/** A SimulationService whose result series / status / metrics are configurable. `ys` are the y-samples of
 *  the "out" node; `currents` maps a device designator → its branch-current samples (named "@<dev>[i]",
 *  exactly how ngspice/wrdata reports a saved R/C current). summarizeSeries derives min/max/final/pp. */
function makeSimSeries(opts: { status?: string; ys?: number[]; currents?: Record<string, number[]>; metrics?: Record<string, unknown> }): SimulationService {
    const node = `v(${sanitizeNodeName('out')})`;
    const series: { name: string; points: { x: number; y: number }[] }[] = [];
    if (opts.ys) series.push({ name: node, points: opts.ys.map((y, i) => ({ x: i, y })) });
    for (const [dev, ys] of Object.entries(opts.currents ?? {})) {
        series.push({ name: `@${dev.toLowerCase()}[i]`, points: ys.map((y, i) => ({ x: i, y })) });
    }
    const pc = (opts.ys?.length ?? 0) + Object.values(opts.currents ?? {}).reduce((n, a) => n + a.length, 0) || 1;
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

    it('I — CURRENT spec checked only by a voltage proxy → NOT verified (coverage gate); fix demands a real current check', async () => {
        // The voltage criterion PASSES, but the user named a current and nothing measures it. This is the
        // headline fidelity bug (LED "≈10mA" "verified" via anode-voltage proxy) — now caught.
        generateOnce([{ probe: 'out', metric: 'final', op: 'approx', value: 5, tol: 0.1 }]);
        fixOnce(); // fix returns no new criteria → the current gap stays open
        const r = (await makeService(makeSimSeries({ ys: [5, 5] })).design({ prompt: 'deliver about 10 mA to the load from a 5V supply', maxRounds: 2 } as never, 'u')) as Record<string, unknown>;
        expect(r.ok).toBe(false);
        expect(r.verified).toBe(false);
        expect((r.assertions as { pass: boolean }[]).every((a) => a.pass)).toBe(true); // the proxy itself passed
        expect(r.warning).toMatch(/current/i);
        expect(JSON.stringify(mockCreate.mock.calls[1]![0])).toMatch(/i\(R1\)|current/i); // fix prompt demanded it
        expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('J — CURRENT spec WITH a faithful i(R1) criterion the sim measures (@r1[i]) → verified in one round', async () => {
        generateOnce([
            { probe: 'out', metric: 'final', op: 'approx', value: 5, tol: 0.1 },
            { probe: 'i(R1)', metric: 'final', op: 'approx', value: 0.01, tol: 0.002, label: '~10mA through R1' },
        ]);
        const sim = makeSimSeries({ ys: [5, 5], currents: { R1: [0.01, 0.01] } });
        const r = (await makeService(sim).design({ prompt: 'about 10 mA from 5V through R1', maxRounds: 2 } as never, 'u')) as Record<string, unknown>;
        expect(r.ok).toBe(true);
        expect(r.verified).toBe(true);
        const cur = (r.assertions as { probe: string; pass: boolean; actual: number }[]).find((x) => x.probe === 'i(R1)')!;
        expect(cur.pass).toBe(true); // the current criterion matched its @r1[i] measurement end-to-end
        expect(cur.actual).toBeCloseTo(0.01, 5);
        expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('K — current gap CLOSED by a fix that ADDS an i(R1) criterion; the original voltage criterion is PRESERVED (append-only)', async () => {
        generateOnce([{ probe: 'out', metric: 'final', op: 'approx', value: 5, tol: 0.1 }]); // no current → gap
        fixOnceWithCriteria([
            { probe: 'out', metric: 'final', op: 'approx', value: 5, tol: 0.1 },
            { probe: 'i(R1)', metric: 'final', op: 'approx', value: 0.01, tol: 0.002 },
        ]);
        const sim = makeSimSeries({ ys: [5, 5], currents: { R1: [0.01, 0.01] } });
        const r = (await makeService(sim).design({ prompt: 'deliver 10 mA from a 5V supply', maxRounds: 3 } as never, 'u')) as Record<string, unknown>;
        expect(r.ok).toBe(true);
        expect(r.verified).toBe(true);
        const crit = r.acceptanceCriteria as { probe: string }[];
        expect(crit.some((c) => c.probe === 'i(R1)')).toBe(true); // current criterion adopted
        expect(crit.some((c) => c.probe === 'out')).toBe(true); // original voltage criterion preserved
        expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('L — a FREQUENCY spec checked only by a voltage proxy is NOT verified (frequency is now hard-gated)', async () => {
        generateOnce([{ probe: 'out', metric: 'pp', op: 'approx', value: 1.414, tol: 0.3 }]); // voltage proxy only
        fixOnce(); // the fix round fails to add a cutoff criterion → the frequency gap stays open
        const sim = makeSimSeries({ ys: [-0.707, 0.707] }); // the voltage criterion itself passes (pp = 1.414)
        const r = (await makeService(sim).design({ prompt: 'RC low-pass with a 1 kHz cutoff', maxRounds: 2 } as never, 'u')) as Record<string, unknown>;
        expect(r.ok).toBe(false);
        expect(r.verified).toBe(false); // simulates + meets its stated criteria, but the named frequency is unmeasured
        expect(String(r.warning)).toMatch(/frequency/i);
        expect(mockCreate).toHaveBeenCalledTimes(2); // gen + one fix attempt that didn't close the gap
    });

    it('M — a cutoff criterion over an AC sweep verifies the named −3 dB corner DIRECTLY (frequency gap closed)', async () => {
        const fc = 1000;
        // First-order low-pass magnitude over a log sweep 10..100k Hz — the locator should find ~fc.
        const node = `v(${sanitizeNodeName('out')})`;
        const decades = Math.log10(100_000 / 10);
        const n = Math.round(decades * 20);
        const points = Array.from({ length: n + 1 }, (_, i) => {
            const f = 10 * 10 ** ((i / n) * decades);
            return { x: f, y: 1 / Math.sqrt(1 + (f / fc) ** 2) };
        });
        const sim = {
            createQuickSim: jest.fn(async () => ({ jobId: 'job-ac' })),
            getStatus: jest.fn(async () => ({ status: 'SUCCEEDED', metrics: { pointsCount: points.length } })),
            getResult: jest.fn(async () => ({ result: { meta: { pointsCount: points.length }, series: [{ name: node, points }] }, metrics: { pointsCount: points.length } })),
        } as unknown as SimulationService;
        mockCreate.mockResolvedValueOnce({
            content: [{ type: 'text', text: JSON.stringify({
                circuit: VALID_CIRCUIT_AC,
                analysisConfig: { type: 'ac', variation: 'dec', points: 20, startFreq: '10', stopFreq: '100k' },
                explanation: 'rc low-pass',
                acceptanceCriteria: [{ probe: 'out', metric: 'cutoff', op: 'approx', value: 1000, tol: 200 }],
            }) }],
        });
        const r = (await makeService(sim).design({ prompt: 'RC low-pass with a 1 kHz cutoff', maxRounds: 2 } as never, 'u')) as Record<string, unknown>;
        expect(r.ok).toBe(true);
        expect(r.verified).toBe(true);
        const cut = (r.assertions as { metric: string; pass: boolean; actual: number }[]).find((x) => x.metric === 'cutoff')!;
        expect(cut.pass).toBe(true);
        expect(cut.actual).toBeGreaterThan(900);
        expect(cut.actual).toBeLessThan(1100);
        // The narrowed caveat now states the corner is verified (not "approximate") — and bounds the claim.
        expect(JSON.stringify(r.caveats)).toMatch(/−3 dB corner|corner/i);
        expect(mockCreate).toHaveBeenCalledTimes(1); // verified in one round, no fix needed
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
