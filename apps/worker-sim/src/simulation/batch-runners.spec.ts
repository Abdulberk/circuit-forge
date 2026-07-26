/**
 * The worker-only concerns of the three variant-batch runners, isolated from real ngspice by stubbing the shared
 * job-dir helper + the eda-core orchestrators:
 *   - sweep: clampSpec caps a runaway point count / truncates an over-long value list and reports it honestly;
 *   - monte-carlo: the per-batch wall-clock budget flips budgetHit when the deadline passes;
 *   - corner: the WorstCaseResult is passed through with a measured runtime.
 * A bug here either runs a runaway sweep, silently under-reports points as complete, or mis-times a batch.
 */
jest.mock('../config', () => ({
    config: { MC_N_DEFAULT: 300, MC_CI_HALFWIDTH_STOP: 0.03, MC_BATCH_BUDGET_MS: 60000 },
}));
jest.mock('../logger', () => ({ logger: { info: jest.fn() } }));

const runMonteCarlo = jest.fn();
const runParametricSweep = jest.fn();
const runWorstCase = jest.fn();
// Keep the REAL eda-core so `extraProbesForCriteria` (the criterion→probe derivation the batch runners now call) is
// exercised for real, not re-mocked — a hand-mirrored copy here would defeat the whole point of centralizing it.
// Override ONLY the three heavy orchestrators whose return values this suite drives.
jest.mock('@circuit-forge/eda-core', () => ({
    ...jest.requireActual('@circuit-forge/eda-core'),
    runMonteCarlo: (...a: unknown[]) => runMonteCarlo(...a),
    runParametricSweep: (...a: unknown[]) => runParametricSweep(...a),
    runWorstCase: (...a: unknown[]) => runWorstCase(...a),
}));
// The job-dir helper is unit-tested separately (job-dir.spec.ts) — here it RECORDS its args (so we can assert the
// criterion probes were derived + forwarded at index 3) and runs the body with a fake runner.
const fakeRunner = jest.fn();
const jobDirCalls: unknown[][] = [];
jest.mock('./job-dir', () => ({
    withVariantJobDir: (...args: unknown[]) => {
        jobDirCalls.push(args);
        return (args[5] as (rv: unknown, dir: string) => unknown)(fakeRunner, 'dir');
    },
}));

import { config } from '../config';

import { runCornerBatch } from './corner-runner';
import { runMonteCarloBatch } from './montecarlo-runner';
import { runSweepBatch } from './sweep-runner';

const input = { jobId: 'j1', circuit: {} as never, analysis: { type: 'op' } as never, criteria: [] };

beforeEach(() => {
    jest.clearAllMocks();
    jobDirCalls.length = 0;
    (config as { MC_BATCH_BUDGET_MS: number }).MC_BATCH_BUDGET_MS = 60000;
    runParametricSweep.mockResolvedValue({
        parameter: 'R1',
        evaluated: 1,
        passed: 1,
        failed: 0,
        errored: 0,
        passAll: true,
    });
    runWorstCase.mockResolvedValue({
        componentsCornered: 2,
        evaluated: 4,
        passed: 4,
        failed: 0,
        errored: 0,
        passAllCorners: true,
        omitted: [],
    });
    runMonteCarlo.mockResolvedValue({ yield: 1, evaluated: 10, ran: 10, passed: 10, failed: 0, errored: 0 });
});

describe('runSweepBatch — clampSpec bounds a runaway sweep', () => {
    it('truncates an explicit value list longer than the cap and flags clamped', async () => {
        const values = Array.from({ length: 150 }, (_, i) => i);
        const r = await runSweepBatch({ ...input, sweep: { component: 'R1', values } } as never);
        expect(r.clamped).toBe(true);
        expect((runParametricSweep.mock.calls[0]![2] as { values: number[] }).values).toHaveLength(100); // MAX_SWEEP_POINTS
    });

    it('caps a generated range point count over the limit and flags clamped', async () => {
        const r = await runSweepBatch({ ...input, sweep: { component: 'R1', points: 500 } } as never);
        expect(r.clamped).toBe(true);
        expect((runParametricSweep.mock.calls[0]![2] as { points: number }).points).toBe(100);
    });

    it('leaves a within-limit sweep untouched (clamped:false) and carries runtimeMs', async () => {
        const r = await runSweepBatch({ ...input, sweep: { component: 'R1', values: [1, 2, 3] } } as never);
        expect(r.clamped).toBe(false);
        expect((runParametricSweep.mock.calls[0]![2] as { values: number[] }).values).toHaveLength(3);
        expect(typeof r.runtimeMs).toBe('number');
    });
});

describe('runMonteCarloBatch — per-batch wall-clock budget', () => {
    it('sets budgetHit when the deadline has already passed (shouldStop → true)', async () => {
        (config as { MC_BATCH_BUDGET_MS: number }).MC_BATCH_BUDGET_MS = -1; // deadline in the past
        runMonteCarlo.mockImplementationOnce((_c, _cr, _rv, opts: { shouldStop: () => boolean }) => {
            const stop = opts.shouldStop(); // the orchestrator polls it; here it must report the budget is blown
            return Promise.resolve({ yield: 1, evaluated: 1, ran: 1, passed: 1, failed: 0, errored: 0, _stop: stop });
        });
        const r = await runMonteCarloBatch({ ...input } as never);
        expect(r.budgetHit).toBe(true);
    });

    it('leaves budgetHit false under a generous budget', async () => {
        const r = await runMonteCarloBatch({ ...input } as never);
        expect(r.budgetHit).toBe(false);
        expect(r.evaluated).toBe(10);
    });
});

describe('runCornerBatch — passes the worst-case result through with a runtime', () => {
    it('returns passAllCorners + a measured runtimeMs', async () => {
        const r = await runCornerBatch({ ...input, corner: { components: ['R1', 'R2'] } } as never);
        expect(r.passAllCorners).toBe(true);
        expect(r.evaluated).toBe(4);
        expect(typeof r.runtimeMs).toBe('number');
    });
});

describe('every batch derives the criterion probes (branch currents) and forwards them to the job dir', () => {
    // The bug this locks: without the derivation the variant netlists never save @r1[i], so a current criterion
    // reads "probe not found" and EVERY variant fails → yield/passAllCorners collapse to ~0 on a sound design.
    const cur = { probe: 'i(R1)', metric: 'max', op: 'gt', value: 0 };
    const volt = { probe: 'v(out)', metric: 'max', op: 'gt', value: 0 };
    const probesArg = () => jobDirCalls[0]![3]; // withVariantJobDir(jobId, suffix, analysis, extraProbes, models, fn)

    it('monte-carlo unions i(R1) (and drops the voltage probe — the default sweep already saves it)', async () => {
        await runMonteCarloBatch({ ...input, criteria: [cur, volt] } as never);
        expect(probesArg()).toEqual(['i(R1)']);
    });

    it('corner forwards the current probe too', async () => {
        await runCornerBatch({ ...input, criteria: [cur], corner: { components: ['R1'] } } as never);
        expect(probesArg()).toEqual(['i(R1)']);
    });

    it('sweep forwards the current probe too', async () => {
        await runSweepBatch({ ...input, criteria: [cur], sweep: { component: 'R1', values: [1] } } as never);
        expect(probesArg()).toEqual(['i(R1)']);
    });

    it('a voltage-only criteria set derives NO extra probes (default sweep already saves node voltages)', async () => {
        await runMonteCarloBatch({ ...input, criteria: [volt] } as never);
        expect(probesArg()).toEqual([]);
    });
});
