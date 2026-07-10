/**
 * runDesignLoop — the cooperative-abort seam (the genuine behavior change introduced when the loop was
 * extracted for the queue worker). The full generate→sim→fix loop is exercised end-to-end by the API's
 * design-spec-satisfaction suite (mocked SDK + sim); here we only lock the NEW abort hook, which fires at the
 * first checkpoint BEFORE any LLM/sim call — so it needs no Anthropic SDK mock.
 */
import { runDesignLoop, DesignAbortedError, specCloseness, selectFinalists, screenSpecsMet, classifyRobustness, preserveMetricOverlays, pollBackoffMs, type DesignDeps, type ScreenResult } from './design-core';
import type { AssertionResult, AcceptanceCriterion, CircuitJson } from '@circuit-forge/eda-core';

const A = (over: Partial<AssertionResult>): AssertionResult => ({
    label: 'x', probe: 'out', metric: 'final', op: 'approx', target: 5, tol: 0.5, actual: 5, pass: true, distance: 0, detail: '', ...over,
});

describe('pollBackoffMs (sync /design-circuit sim-poll backoff — #12)', () => {
    it('starts fast (no 1s floor) then grows exponentially, capped at 2s', () => {
        expect(pollBackoffMs(0)).toBe(150);
        expect(pollBackoffMs(1)).toBe(300);
        expect(pollBackoffMs(2)).toBe(600);
        expect(pollBackoffMs(3)).toBe(1200);
        expect(pollBackoffMs(4)).toBe(2000); // 150*16=2400 → capped
        expect(pollBackoffMs(12)).toBe(2000); // stays capped
    });

    it('is monotonic non-decreasing (never polls FASTER as the wait grows)', () => {
        for (let a = 1; a <= 12; a++) expect(pollBackoffMs(a)).toBeGreaterThanOrEqual(pollBackoffMs(a - 1));
    });

    it('issues far fewer status queries than the old fixed-1s loop over a 90s wait', () => {
        let elapsed = 0, polls = 0;
        for (let a = 0; elapsed < 90_000; a++) { elapsed += pollBackoffMs(a); polls++; }
        expect(polls).toBeLessThan(90); // the old fixed-1s loop was ~90 findUnique; backoff roughly halves it
    });
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

describe('screenSpecsMet (S1 screen coverage gate)', () => {
    const crit = (probe: string): AcceptanceCriterion => ({ probe, metric: 'max', op: 'approx', value: 1 });
    const passA = (probe: string): AssertionResult => ({ label: '', probe, metric: 'max', op: 'approx', target: 1, actual: 1, pass: true, distance: 0, detail: '' });

    it('a prompt-required CURRENT dimension left uncovered → NOT spec-met even if assertions pass', () => {
        // The candidate self-graded on a voltage-only rubric while the prompt demanded "10mA" — a lowball.
        expect(screenSpecsMet([passA('v(out)')], 'deliver 10mA to the load', [crit('v(out)')])).toBe(false);
    });

    it('the same prompt WITH a current criterion that passes → spec-met', () => {
        expect(
            screenSpecsMet([passA('v(out)'), passA('i(R1)')], 'deliver 10mA to the load', [crit('v(out)'), crit('i(R1)')]),
        ).toBe(true);
    });

    it('no prompt-required enforceable dimension → spec-met when all assertions pass (unchanged behaviour)', () => {
        expect(screenSpecsMet([passA('v(out)')], 'a 5V voltage divider', [crit('v(out)')])).toBe(true);
    });

    it('a failing assertion or no assertions → not spec-met', () => {
        expect(screenSpecsMet([{ ...passA('v(out)'), pass: false }], 'a divider', [crit('v(out)')])).toBe(false);
        expect(screenSpecsMet([], 'anything', [])).toBe(false);
    });
});

describe('classifyRobustness (tolerance-aware tier layered on top of nominal verified)', () => {
    const rep = (yld: number, low: number, high: number, evaluated = 200) => ({ yield: yld, evaluated, ci95: { low, high } });

    it('robust when the Wilson LOWER bound clears the consumer bar (≥99%)', () => {
        const r = classifyRobustness(rep(0.998, 0.992, 1.0));
        expect(r.tier).toBe('robust');
        expect(r.yieldLowerBound).toBeCloseTo(0.992, 6);
        expect(r.profile).toBe('consumer');
    });

    it('grades on the LOWER bound, not the point estimate (99.9% point but ~95% lower bound → marginal)', () => {
        expect(classifyRobustness(rep(0.999, 0.95, 1.0)).tier).toBe('marginal');
    });

    it('at-risk when the lower bound is below the marginal floor (<90%)', () => {
        expect(classifyRobustness(rep(0.85, 0.8, 0.9)).tier).toBe('at-risk');
    });

    it("unknown (= 'verified at nominal only') when no Monte-Carlo ran or yield is unavailable", () => {
        const r = classifyRobustness(undefined);
        expect(r.tier).toBe('unknown');
        expect(r.yieldLowerBound).toBeNull();
        expect(r.note).toMatch(/nominal/i);
        expect(classifyRobustness({ available: false, reason: 'capacity' }).tier).toBe('unknown');
    });

    it('the automotive profile applies a stricter bar (≈Cpk 1.67) than consumer on the SAME data', () => {
        expect(classifyRobustness(rep(0.997, 0.995, 0.999), 'automotive').tier).toBe('marginal'); // 0.995 < 0.999
        expect(classifyRobustness(rep(0.997, 0.995, 0.999), 'consumer').tier).toBe('robust'); // 0.995 ≥ 0.99
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

    it('among spec-met candidates, ranks the MORE ROBUST (wider inequality margin) first — not the thinnest (audit S2)', () => {
        // Both pass `gte 10`, but `robust` clears it by 40 (actual 50) and `marginal` by only 0.5 (actual 10.5).
        // specCloseness would put `marginal` (tiny |distance|) first — the THINNEST, least tolerance-robust
        // design — sending winner-only Monte-Carlo to it. Robustness ranking must put `robust` first instead.
        const crit = (over: Partial<AssertionResult>): AssertionResult => ({
            label: 'g', probe: 'i(R1)', metric: 'max', op: 'gte', target: 10, actual: 0, pass: true, distance: 0, detail: '', ...over,
        });
        const robust = mk(['resistor', 'voltage_source'], { specsMet: true, closeness: 4, assertions: [crit({ actual: 50, distance: 40 })] });
        const marginal = mk(['resistor', 'diode'], { specsMet: true, closeness: 0.05, assertions: [crit({ actual: 10.5, distance: 0.5 })] });
        const picked = selectFinalists([marginal, robust], 2);
        expect(picked[0]).toBe(robust); // wider margin wins despite the WORSE closeness
        expect(picked[1]).toBe(marginal);
    });
});

describe('preserveMetricOverlays — a fix cannot silently drop a thd/gain overlay', () => {
    const F = { fundamentalFreq: '1k', probes: ['v(out)'] };
    const TF = { output: 'v(out)', inputSource: 'V1' };
    const tran = (fourier?: unknown) => ({ type: 'tran', stopTime: '5m', stepTime: '5u', ...(fourier ? { fourier } : {}) }) as never;
    const op = (tf?: unknown) => ({ type: 'op', ...(tf ? { tf } : {}) }) as never;
    const thdCrit = [{ probe: 'out', metric: 'thd', op: 'lt', value: 1 }] as never;
    const gainCrit = [{ probe: 'out', metric: 'gain', op: 'approx', value: 20, tol: 2 }] as never;

    it('carries the fourier overlay forward when a thd criterion needs it and the fix dropped it', () => {
        const out = preserveMetricOverlays(tran(F), tran(), thdCrit) as { fourier?: unknown };
        expect(out.fourier).toEqual(F);
    });

    it('carries the tf overlay forward when a gain criterion needs it and the fix dropped it', () => {
        const out = preserveMetricOverlays(op(TF), op(), gainCrit) as { tf?: unknown };
        expect(out.tf).toEqual(TF);
    });

    it('does NOT carry an overlay when no thd/gain criterion is active', () => {
        const out = preserveMetricOverlays(tran(F), tran(), [{ probe: 'out', metric: 'pp', op: 'lt', value: 1 }] as never) as { fourier?: unknown };
        expect(out.fourier).toBeUndefined();
    });

    it('respects a deliberate analysis-TYPE change by the fix (tran+fourier → op): does not force-carry', () => {
        const out = preserveMetricOverlays(tran(F), op(), thdCrit) as { type: string; fourier?: unknown };
        expect(out.type).toBe('op');        // the fix's new type stands
        expect(out.fourier).toBeUndefined(); // a tran overlay is not smuggled onto an op
    });

    it('does NOT clobber an overlay the fix already re-emitted itself', () => {
        const fresh = { fundamentalFreq: '2k', probes: ['v(x)'] };
        const out = preserveMetricOverlays(tran(F), tran(fresh), thdCrit) as { fourier?: unknown };
        expect(out.fourier).toEqual(fresh); // keep the model's own, don't overwrite with the stale one
    });
});

describe('runDesignLoop — a thd criterion is measured via the seed analysis fourier (SDK-free)', () => {
    // A divider/RC seed is enough — the sim is FAKED, so we test the plumbing (fold fourier → measurement →
    // evaluate → verdict), not real ngspice THD. Seeding skips generateCircuit, so no real Anthropic call.
    const SEED_T: CircuitJson = {
        version: '1.0',
        components: [
            { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'SIN(0 1 1k)', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: '0' }] },
            { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
            { id: 'c1', type: 'capacitor', designator: 'C1', value: '100n', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: '0' }] },
            { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: '0' }] },
        ],
        nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: '0', name: '0', isGround: true }],
    } as unknown as CircuitJson;

    it('folds THD from the sim result onto the measurement so a thd criterion verifies (was always-null before the loop attached it)', async () => {
        const result = {
            meta: { pointsCount: 3 },
            series: [{ name: 'v(out)', points: [{ x: 0, y: 0 }, { x: 1e-3, y: 1 }, { x: 2e-3, y: 0 }] }],
            fourier: [{ probe: 'v(out)', fundamentalFreq: 1000, thd: 0.5, harmonics: [] }],
        };
        const runSim = {
            createQuickSim: jest.fn(async () => ({ jobId: 'j1' })),
            getStatus: jest.fn(async () => ({ status: 'SUCCEEDED', metrics: { pointsCount: 3 } })),
            getResult: jest.fn(async () => ({ status: 'SUCCEEDED', result, metrics: { pointsCount: 3 } })),
            createMonteCarloJob: jest.fn(),
        };
        const deps = fakeDeps({ runSim: runSim as unknown as DesignDeps['runSim'] });
        const res = await runDesignLoop(
            {
                prompt: 'a low-distortion stage, THD under 1%',
                seedCircuit: SEED_T,
                seedAnalysisConfig: { type: 'tran', stopTime: '5m', stepTime: '5u', fourier: { fundamentalFreq: '1k', probes: ['v(out)'] } } as never,
                seedCriteria: [{ probe: 'out', metric: 'thd', op: 'lt', value: 1 }] as never,
                maxRounds: 1,
            },
            deps,
        );
        expect(runSim.createQuickSim).toHaveBeenCalledTimes(1); // seed simulated directly, no LLM
        expect(res.ok).toBe(true);
        expect(res.verified).toBe(true);
        const a = (res.assertions ?? []).find((x) => x.metric === 'thd');
        expect(a?.actual).toBe(0.5); // THD folded from result.fourier (undefined → not-determinable before)
        expect(a?.pass).toBe(true);  // 0.5% < 1%
    });
});
