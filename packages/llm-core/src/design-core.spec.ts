/**
 * runDesignLoop — the cooperative-abort seam (the genuine behavior change introduced when the loop was
 * extracted for the queue worker). The full generate→sim→fix loop is exercised end-to-end by the API's
 * design-spec-satisfaction suite (mocked SDK + sim); here we only lock the NEW abort hook, which fires at the
 * first checkpoint BEFORE any LLM/sim call — so it needs no Anthropic SDK mock.
 */
import { runDesignLoop, DesignAbortedError, specCloseness, selectFinalists, type DesignDeps, type ScreenResult } from './design-core';
import type { AssertionResult, CircuitJson } from '@circuit-forge/eda-core';

const A = (over: Partial<AssertionResult>): AssertionResult => ({
    label: 'x', probe: 'out', metric: 'final', op: 'approx', target: 5, tol: 0.5, actual: 5, pass: true, distance: 0, detail: '', ...over,
});

describe('specCloseness (candidate screen scoring)', () => {
    it('is 0 when every criterion is dead-on, and rises with the normalized miss', () => {
        expect(specCloseness([A({ distance: 0 })])).toBe(0);
        // distance 0.5 on target 5 → 0.1; distance 1 on target 10 → 0.1 → sum 0.2
        expect(specCloseness([A({ target: 5, distance: 0.5 }), A({ target: 10, distance: 1 })])).toBeCloseTo(0.2);
    });

    it('penalizes an unmeasured criterion (distance null) a full unit', () => {
        expect(specCloseness([A({ distance: null })])).toBe(1);
        expect(specCloseness([A({ distance: 0 }), A({ distance: null })])).toBe(1);
    });

    it('falls back to tol then 1 when the target is ~0 (avoids divide-by-zero)', () => {
        expect(specCloseness([A({ target: 0, tol: 0.2, distance: 0.2 })])).toBeCloseTo(1); // 0.2/0.2
        expect(specCloseness([A({ target: 0, tol: 0, distance: 3 })])).toBe(3); // denom→1
    });

    it('returns Infinity for no criteria (cannot rank)', () => {
        expect(specCloseness([])).toBe(Number.POSITIVE_INFINITY);
    });

    it('lower score = closer to spec (the ranking invariant)', () => {
        const near = specCloseness([A({ target: 5, distance: 0.1 })]);
        const far = specCloseness([A({ target: 5, distance: 2 })]);
        expect(near).toBeLessThan(far);
    });
});

function fakeDeps(over: Partial<DesignDeps>): DesignDeps {
    const runSim = {
        createQuickSim: jest.fn(),
        getStatus: jest.fn(),
        getResult: jest.fn(),
        createMonteCarloJob: jest.fn(),
    };
    return {
        llmConfig: { apiKey: 'test-key' } as unknown as DesignDeps['llmConfig'],
        runSim: runSim as unknown as DesignDeps['runSim'],
        ground: { grounding: () => undefined, enrichSourcing: jest.fn(async () => undefined) },
        userId: 'u1',
        pollTimeoutMs: 1000,
        mcEnabled: false,
        ...over,
    };
}

describe('runDesignLoop — cooperative abort', () => {
    it('throws DesignAbortedError at the first checkpoint when already aborted — BEFORE any LLM or sim call', async () => {
        const deps = fakeDeps({ isAborted: () => Promise.resolve(true) });
        await expect(runDesignLoop({ prompt: 'an RC low-pass', maxRounds: 2 }, deps)).rejects.toBeInstanceOf(DesignAbortedError);
        // The abort fires before generateCircuit, so no simulation is ever enqueued (no spend).
        expect((deps.runSim.createQuickSim as jest.Mock)).not.toHaveBeenCalled();
        expect((deps.ground.enrichSourcing as jest.Mock)).not.toHaveBeenCalled();
    });

    it('DesignAbortedError is a distinct, catchable error type', () => {
        const e = new DesignAbortedError();
        expect(e).toBeInstanceOf(Error);
        expect(e.name).toBe('DesignAbortedError');
    });
});

describe('runDesignLoop — seedCircuit skips generateCircuit (SDK-free proof)', () => {
    const SEED: CircuitJson = {
        version: '1.0',
        components: [
            { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 10', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: '0' }] },
            { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
            { id: 'r2', type: 'resistor', designator: 'R2', value: '1k', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: '0' }] },
            { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: '0' }] },
        ],
        nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: '0', name: '0', isGround: true }],
    } as unknown as CircuitJson;

    it('simulates the SEED directly + returns without any LLM call (would 401/network-error if generate ran)', async () => {
        const runSim = {
            createQuickSim: jest.fn(async () => ({ jobId: 'j1' })),
            getStatus: jest.fn(async () => ({ status: 'SUCCEEDED', metrics: { pointsCount: 1 } })),
            getResult: jest.fn(async () => ({ status: 'SUCCEEDED', result: { meta: { pointsCount: 1 }, series: [] }, metrics: { pointsCount: 1 } })),
            createMonteCarloJob: jest.fn(),
        };
        const deps = fakeDeps({ runSim: runSim as unknown as DesignDeps['runSim'] });
        const res = await runDesignLoop(
            { prompt: 'a voltage divider', seedCircuit: SEED, seedAnalysisConfig: { type: 'op' } as never, seedCriteria: [], maxRounds: 1 },
            deps,
        );
        // The seed went STRAIGHT to simulate — no generateCircuit (the real Anthropic SDK would have been hit,
        // failing on the fake 'test-key', if generate had run). createQuickSim was called with the seed netlist.
        expect(runSim.createQuickSim).toHaveBeenCalledTimes(1);
        expect(res.circuit).toBe(SEED);
    });
});

describe('selectFinalists', () => {
    const mk = (types: string[], over: Partial<ScreenResult> = {}): ScreenResult => ({
        circuit: { version: '1.0', components: types.map((t, i) => ({ id: `c${i}`, type: t, designator: `X${i}` })), nets: [{ id: 'n', name: 'n' }] } as unknown as CircuitJson,
        analysisConfig: { type: 'op' } as never,
        acceptanceCriteria: [],
        assertions: [],
        simHealthy: true,
        pointsCount: 1,
        specsMet: false,
        closeness: 1,
        simStatus: 'SUCCEEDED',
        ...over,
    });

    it('ranks simulating > non-simulating, then spec-met, then closeness, then fewer parts', () => {
        const nonSim = mk(['resistor', 'capacitor'], { simHealthy: false, closeness: Infinity });
        const far = mk(['resistor', 'inductor'], { closeness: 5 });
        const near = mk(['resistor', 'diode'], { closeness: 0.2 });
        const met = mk(['resistor', 'voltage_source'], { specsMet: true, closeness: 1 });
        const picked = selectFinalists([nonSim, far, near, met], 3);
        expect(picked[0]).toBe(met);   // spec-met wins
        expect(picked[1]).toBe(near);  // then closest
        expect(picked[2]).toBe(far);   // then farther (still simulating)
        expect(picked).not.toContain(nonSim); // non-simulating excluded by k=3
    });

    it('dedups identical topologies, keeping the better-scoring one', () => {
        const worse = mk(['resistor', 'resistor'], { closeness: 9 });
        const better = mk(['resistor', 'resistor'], { closeness: 0.1 }); // same topology key
        const other = mk(['resistor', 'capacitor'], { closeness: 1 });
        const picked = selectFinalists([worse, better, other], 5);
        expect(picked).toHaveLength(2); // the two duplicates collapsed to one + the other
        expect(picked).toContain(better);
        expect(picked).not.toContain(worse);
    });

    it('returns at least 1 and at most k', () => {
        const cands = [mk(['resistor']), mk(['capacitor']), mk(['inductor'])];
        expect(selectFinalists(cands, 2)).toHaveLength(2);
        expect(selectFinalists(cands, 0).length).toBe(1); // k floored to ≥1
    });
});
