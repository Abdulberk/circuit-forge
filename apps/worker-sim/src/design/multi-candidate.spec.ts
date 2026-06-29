/**
 * runMultiCandidateDesign orchestration. llm-core is mocked so this is a fast, deterministic test of the
 * FLOW: N=1 dark passthrough, N>1 screen→select→seeded-finalist-loop→winner-only-MC, the row-bounding of
 * alternatives (#6), the per-request LLM budget, and the all-screens-failed fallback.
 */
const runDesignLoop = jest.fn();
const screenCandidate = jest.fn();
const selectFinalists = jest.fn();
const runYieldAnalysis = jest.fn();
// classifyRobustness is a PURE classifier (yield report → robustness tier) that the orchestrator only ATTACHES
// to the winner result — so a representative stub keeps this flow test fast/deterministic. (Its real behaviour
// is unit-tested in llm-core's design-core.spec.) Omitting it here is what made the worker `test` job go red.
jest.mock('@circuitforge/llm-core', () => ({
    runDesignLoop, screenCandidate, selectFinalists, runYieldAnalysis,
    classifyRobustness: (y?: { yield?: number; evaluated?: number }) => ({
        tier: 'robust', profile: 'consumer', yield: y?.yield ?? null, yieldLowerBound: 0.92, evaluated: y?.evaluated ?? null, note: 'stub',
    }),
}));
jest.mock('./pools', () => ({ llmSem: { run: (fn: () => unknown) => fn() }, ngspiceSem: { run: (fn: () => unknown) => fn() } }));
jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { runMultiCandidateDesign } from './multi-candidate';

const deps = { llmConfig: { apiKey: 'k' }, runSim: {}, ground: {}, userId: 'u', pollTimeoutMs: 1000, mcEnabled: true } as never;
const input = { prompt: 'a divider', maxRounds: 2 } as never;

const screenOf = (temp: number) => ({
    circuit: { components: [{ id: 'r', type: 'resistor' }], nets: [{ id: 'n', name: 'n' }], _temp: temp },
    analysisConfig: { type: 'op' }, acceptanceCriteria: [], assertions: [], simHealthy: true, pointsCount: 1,
    specsMet: false, closeness: temp, simStatus: 'SUCCEEDED',
});
const loopResultOf = (seed: unknown) => ({
    ok: true, verified: true, circuit: seed ?? { components: [], nets: [] }, analysisConfig: { type: 'op' },
    rounds: 2, history: [], simulation: { status: 'SUCCEEDED', result: { series: [{ name: 'out', points: Array(20000).fill({ x: 0, y: 0 }) }] } },
    acceptanceCriteria: [], assertions: [{ pass: true }],
});

beforeEach(() => {
    runDesignLoop.mockReset().mockImplementation((i: { seedCircuit?: unknown }) => Promise.resolve(loopResultOf(i.seedCircuit)));
    screenCandidate.mockReset().mockImplementation((_i: unknown, d: { llmConfig: { temperature: number } }) => Promise.resolve(screenOf(d.llmConfig.temperature)));
    selectFinalists.mockReset().mockImplementation((s: unknown[], k: number) => s.slice(0, k)); // pure-ish stand-in
    runYieldAnalysis.mockReset().mockResolvedValue({ yield: 0.95, evaluated: 120 });
});

describe('runMultiCandidateDesign', () => {
    it('N=1 → DARK: a single runDesignLoop, no screening/select/MC fan-out', async () => {
        await runMultiCandidateDesign(input, deps, { n: 1, k: 2, llmBudget: 12 });
        expect(runDesignLoop).toHaveBeenCalledTimes(1);
        expect(screenCandidate).not.toHaveBeenCalled();
        expect(selectFinalists).not.toHaveBeenCalled();
        expect(runYieldAnalysis).not.toHaveBeenCalled();
    });

    it('N=4 → screens 4 DIVERSE candidates, runs K=2 seeded finalists, MC on the winner ONLY', async () => {
        const res = await runMultiCandidateDesign(input, deps, { n: 4, k: 2, llmBudget: 12 });
        // 4 screens, each with a DISTINCT prompt (diversity via topology directives, not temperature)
        expect(screenCandidate).toHaveBeenCalledTimes(4);
        const constraintsSeen = new Set(screenCandidate.mock.calls.map((c) => (c[0] as { constraints?: string }).constraints));
        expect(constraintsSeen.size).toBe(4);
        // K=2 finalists run the FULL loop, each SEEDED (not regenerating)
        expect(runDesignLoop).toHaveBeenCalledTimes(2);
        for (const call of runDesignLoop.mock.calls) {
            expect((call[0] as { seedCircuit?: unknown }).seedCircuit).toBeDefined();
            expect((call[1] as { mcEnabled: boolean }).mcEnabled).toBe(false); // MC OFF per-finalist
        }
        // MC runs exactly once — on the winner
        expect(runYieldAnalysis).toHaveBeenCalledTimes(1);
        expect((res as { yield?: unknown }).yield).toEqual({ yield: 0.95, evaluated: 120 });
        expect((res as { candidates?: { generated: number } }).candidates?.generated).toBe(4);
    });

    it('row-bound (#6): the winner keeps its full series; alternatives are series-free summaries', async () => {
        const res = (await runMultiCandidateDesign(input, deps, { n: 4, k: 2, llmBudget: 12 })) as {
            simulation?: { result?: { series?: unknown[] } };
            alternatives?: Array<Record<string, unknown>>;
        };
        // winner: full series retained
        expect(res.simulation?.result?.series?.[0]).toBeDefined();
        // alternatives: 1 (K-1), and it carries NO waveform series — just a summary
        expect(res.alternatives).toHaveLength(1);
        const alt = res.alternatives![0]!;
        expect(alt.simulation).toBeUndefined();
        expect(alt.circuit).toBeDefined();
        expect(alt).toMatchObject({ ok: true, assertionsPassed: 1, assertionsTotal: 1 });
    });

    it('per-request LLM budget caps fan-out (no finalist full-loops when the budget is spent screening)', async () => {
        // budget = 4 → 4 screens consume it all → no finalist loop → falls back to a single seeded loop
        await runMultiCandidateDesign(input, deps, { n: 4, k: 2, llmBudget: 4 });
        expect(screenCandidate).toHaveBeenCalledTimes(4);
        expect(runDesignLoop).toHaveBeenCalledTimes(1); // only the fallback seeded loop, not 2 finalists
    });

    it('all screens fail (provider down) → falls back to a single runDesignLoop, no MC', async () => {
        screenCandidate.mockRejectedValue(new Error('provider down'));
        const res = await runMultiCandidateDesign(input, deps, { n: 4, k: 2, llmBudget: 12 });
        expect(runDesignLoop).toHaveBeenCalledTimes(1); // the fallback
        expect(runYieldAnalysis).not.toHaveBeenCalled();
        expect((res as { ok: boolean }).ok).toBe(true);
    });
});
