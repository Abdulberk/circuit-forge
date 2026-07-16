/**
 * VerificationService — assertion evaluation + verdict logic. CircuitSimulatorService is stubbed so
 * the suite is deterministic and ngspice-free; the assertion math and verdict rules are the contract.
 */
import { VerificationService, isCurrentProbe } from './verification.service';
import type { CircuitSimulatorService, SimSummary } from './circuit-simulator.service';
import type { SimulationService } from '../simulation/simulation.service';
import { sanitizeNodeName, type CircuitJson } from '@circuit-forge/eda-core';
import type { AssertionDto } from './dto';

const okSim = (over: Partial<SimSummary> = {}): SimSummary => ({
    simStatus: 'ok',
    ercErrors: [],
    ercWarnings: [],
    measurements: [
        { node: 'v(out)', min: 0, max: 5.02, final: 4.98, pp: 5.02, avg: 4.98, rms: 4.98 },
        { node: 'v(ripple)', min: 4.9, max: 4.96, final: 4.93, pp: 0.06, avg: 4.93, rms: 4.93 },
    ],
    nodeCount: 2,
    analysisType: 'tran',
    ...over,
});

function makeService(sim: SimSummary) {
    // verify() calls simulateWithRemedies (the Convergence Doctor wrapper); stub returns the summary.
    const simulate = jest.fn(async () => sim);
    const simulator = { simulateWithRemedies: simulate } as unknown as CircuitSimulatorService;
    return { svc: new VerificationService(simulator), simulate };
}

const A = (probe: string, metric: AssertionDto['metric'], op: AssertionDto['op'], value: number, tol?: number): AssertionDto => ({
    probe,
    metric,
    op,
    value,
    ...(tol !== undefined ? { tol } : {}),
});

describe('VerificationService', () => {
    it('PASS: sim ok, no ERC errors, all assertions met', async () => {
        const { svc } = makeService(okSim());
        const ev = await svc.verify({}, undefined, [
            A('out', 'final', 'approx', 5.0, 0.1), // 4.98 within 0.1
            A('ripple', 'pp', 'lt', 0.1), // 0.06 < 0.1
            A('out', 'max', 'lte', 5.05), // 5.02 <= 5.05
        ]);
        expect(ev.verdict).toBe('pass');
        expect(ev.checks).toEqual({ total: 3, passed: 3, failed: 0 });
        expect(ev.summary).toMatch(/Verified/);
    });

    it('matches probes with or without the v()/i() wrapper, case-insensitively', async () => {
        const { svc } = makeService(okSim());
        const ev = await svc.verify({}, undefined, [A('V(OUT)', 'final', 'approx', 4.98), A('out', 'final', 'approx', 4.98)]);
        expect(ev.assertions.every((a) => a.actual === 4.98)).toBe(true);
        expect(ev.verdict).toBe('pass');
    });

    it('FAIL: a single unmet assertion fails the whole verdict, others still reported', async () => {
        const { svc } = makeService(okSim());
        const ev = await svc.verify({}, undefined, [
            A('out', 'final', 'approx', 5.0, 0.1), // pass
            A('ripple', 'pp', 'lt', 0.05), // FAIL: 0.06 not < 0.05
        ]);
        expect(ev.verdict).toBe('fail');
        expect(ev.checks).toEqual({ total: 2, passed: 1, failed: 1 });
        expect(ev.assertions[1]!.pass).toBe(false);
    });

    it('FAIL: an ERC error fails the verdict even with no assertions', async () => {
        const { svc } = makeService(okSim({ ercErrors: [{ code: 'SHORT', message: 'short to ground', relatedIds: ['R1'] }] }));
        const ev = await svc.verify({}, undefined, []);
        expect(ev.verdict).toBe('fail');
        expect(ev.summary).toMatch(/ERC error/);
    });

    it('PASS with ERC warnings noted (warnings do not fail the verdict)', async () => {
        const { svc } = makeService(okSim({ ercWarnings: [{ code: 'FLOAT_R', message: 'floating reactive node', relatedIds: ['C1'] }] }));
        const ev = await svc.verify({}, undefined, [A('out', 'final', 'approx', 4.98)]); // a met spec → genuine pass
        expect(ev.verdict).toBe('pass');
        expect(ev.summary).toMatch(/warning/i);
    });

    it('INCONCLUSIVE: a clean sim with NO acceptance criteria asserted is NOT a pass (nothing to verify)', async () => {
        const { svc } = makeService(okSim());
        const ev = await svc.verify({}, undefined, []);
        expect(ev.verdict).toBe('inconclusive'); // was a false 'pass' — a spec-less run is not "verified"
        expect(ev.checks).toEqual({ total: 0, passed: 0, failed: 0 });
        expect(ev.summary).toMatch(/no acceptance criteria|nothing was verified/i);
    });

    it('FAIL: simulation that failed to run is a fail, assertions become unmet (actual null)', async () => {
        const { svc } = makeService({ simStatus: 'failed', ercErrors: [], ercWarnings: [], measurements: [], nodeCount: 0, runError: 'timed out' });
        const ev = await svc.verify({}, undefined, [A('out', 'final', 'approx', 5)]);
        expect(ev.verdict).toBe('fail');
        expect(ev.assertions[0]!.actual).toBeNull();
        expect(ev.assertions[0]!.pass).toBe(false);
    });

    it('INCONCLUSIVE: ngspice not configured (skipped) cannot certify anything', async () => {
        const { svc } = makeService({ simStatus: 'skipped', ercErrors: [], ercWarnings: [], measurements: [], nodeCount: 0, runError: 'simulation not configured' });
        const ev = await svc.verify({}, undefined, [A('out', 'final', 'approx', 5)]);
        expect(ev.verdict).toBe('inconclusive');
        expect(ev.assertions[0]!.pass).toBe(false);
    });

    it('FAIL: an assertion against a probe absent from the output is unmet, not silently passed', async () => {
        const { svc } = makeService(okSim());
        const ev = await svc.verify({}, undefined, [A('does_not_exist', 'final', 'gt', 0)]);
        expect(ev.verdict).toBe('fail');
        expect(ev.assertions[0]!.actual).toBeNull();
        expect(ev.assertions[0]!.detail).toMatch(/not found/);
    });

    it('covers every comparison operator', async () => {
        const { svc } = makeService(okSim()); // v(out).final = 4.98
        const ev = await svc.verify({}, undefined, [
            A('out', 'final', 'gt', 4), // 4.98 > 4 ✓
            A('out', 'final', 'gte', 4.98), // ✓
            A('out', 'final', 'lt', 5), // ✓
            A('out', 'final', 'lte', 4.98), // ✓
            A('out', 'final', 'approx', 5.0), // default 5% tol of 5 = 0.25; |4.98-5|=0.02 ✓
        ]);
        expect(ev.checks.passed).toBe(5);
    });

    it('passes the analysis config through to the simulator (+ current-probe list; [] when no current assertions)', async () => {
        const { svc, simulate } = makeService(okSim());
        const analysis = { type: 'tran', stopTime: '5m', timeStep: '10u' } as never;
        await svc.verify({ foo: 1 }, analysis, []);
        expect(simulate).toHaveBeenCalledWith({ foo: 1 }, analysis, []);
    });

    it('UNIONs a current assertion probe into the simulator call so i(R1) is actually saved/measured', async () => {
        const { svc, simulate } = makeService(okSim());
        await svc.verify({ foo: 1 }, undefined, [{ probe: 'i(R1)', metric: 'final', op: 'approx', value: 0.01 }]);
        expect(simulate).toHaveBeenCalledWith({ foo: 1 }, undefined, ['i(R1)']);
    });

    it('INCONCLUSIVE: an ok run that produced no measurements cannot certify anything', async () => {
        const { svc } = makeService(okSim({ measurements: [] }));
        const ev = await svc.verify({}, undefined, []);
        expect(ev.verdict).toBe('inconclusive');
        expect(ev.summary).toMatch(/no measurable data/);
    });

    it('FAIL beats inconclusive: an ERC error on a no-data run is still a fail', async () => {
        const { svc } = makeService(okSim({ measurements: [], ercErrors: [{ code: 'X', message: 'm', relatedIds: [] }] }));
        const ev = await svc.verify({}, undefined, []);
        expect(ev.verdict).toBe('fail');
    });

    it('isCurrentProbe flags current/power probes the voltage-only sim cannot measure', () => {
        expect(isCurrentProbe('i(R1)')).toBe(true);
        expect(isCurrentProbe('I( V1 )')).toBe(true);
        expect(isCurrentProbe('@r1[i]')).toBe(true);
        expect(isCurrentProbe('out')).toBe(false);
        expect(isCurrentProbe('v(out)')).toBe(false);
    });
});

/** A real 10V/1k/1k divider (out=5V) so runErc + generateNetlist succeed in the worker path. */
const DIVIDER: CircuitJson = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 10', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '1k', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: 'gnd', name: 'gnd', isGround: true }],
};

/** The worker's SimulationResult — series names are the sanitized SPICE nodes ngspice actually emits
 *  (build them via sanitizeNodeName so they match nodeKey() regardless of the n-/x_- prefix rule). */
const workerResult = {
    meta: { analysisType: 'op', xLabel: 't', pointsCount: 1 },
    series: [
        { name: `v(${sanitizeNodeName('in')})`, points: [{ x: 0, y: 10 }] },
        { name: `v(${sanitizeNodeName('out')})`, points: [{ x: 0, y: 5 }] },
    ],
};

function makeWorkerService(opts: { status?: string; metrics?: unknown; result?: unknown; resultError?: string; createThrows?: boolean } = {}) {
    const createQuickSim = jest.fn(async (_netlist: string, _analysis: unknown, _userId: string) => {
        if (opts.createThrows) throw new Error('Redis down');
        return { jobId: 'job-1' };
    });
    const getStatus = jest.fn(async () => ({ status: opts.status ?? 'SUCCEEDED', metrics: opts.metrics }));
    const getResult = jest.fn(async () => ({
        result: 'result' in opts ? opts.result : workerResult,
        ...(opts.resultError ? { error: opts.resultError } : {}),
    }));
    const createCornerJob = jest.fn(async () => ({ jobId: 'corner-1' }));
    const simulation = { createQuickSim, getStatus, getResult, createCornerJob } as unknown as SimulationService;
    const simulateWithRemedies = jest.fn(); // must NOT be called on the worker path
    const simulator = { simulateWithRemedies } as unknown as CircuitSimulatorService;
    return { svc: new VerificationService(simulator, simulation), createQuickSim, getStatus, getResult, createCornerJob, simulateWithRemedies };
}

describe('VerificationService — worker delegation (prod path, userId present)', () => {
    it('delegates ngspice to the worker (NOT inline), polls, and builds evidence from the result', async () => {
        const { svc, createQuickSim, getStatus, getResult, simulateWithRemedies } = makeWorkerService();
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 5.0, 0.1)], 'user-1');
        expect(createQuickSim).toHaveBeenCalledTimes(1); // enqueued to the worker
        expect(createQuickSim.mock.calls[0]![2]).toBe('user-1'); // with the user's id (for org/quota)
        expect(getStatus).toHaveBeenCalled(); // server-side polled
        expect(getResult).toHaveBeenCalledTimes(1);
        expect(simulateWithRemedies).not.toHaveBeenCalled(); // inline path NOT used in prod
        expect(ev.verdict).toBe('pass'); // out≈5V meets the spec; ERC clean on the divider
        expect(ev.measurements.find((m) => m.node === `v(${sanitizeNodeName('out')})`)!.final).toBe(5);
        expect(ev.power).toBeDefined(); // power review still runs on the worker-returned measurements
    });

    it('worker path: a clean sim with NO assertions is INCONCLUSIVE, not a false pass', async () => {
        const { svc } = makeWorkerService(); // clean workerResult (has data), ERC-clean DIVIDER
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [], 'user-1');
        expect(ev.verdict).toBe('inconclusive');
        expect(ev.checks.total).toBe(0);
        expect(ev.summary).toMatch(/no acceptance criteria|nothing was verified/i);
    });

    it('a failed/timed-out worker job becomes a failed verdict (no throw)', async () => {
        const { svc } = makeWorkerService({ status: 'FAILED' });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 5)], 'user-1');
        expect(ev.verdict).toBe('fail');
        expect(ev.simStatus).toBe('failed');
        expect(ev.assertions[0]!.actual).toBeNull();
    });

    it('an unreachable queue (enqueue throws) is INCONCLUSIVE, not a design fail (infra ≠ design fault)', async () => {
        const { svc } = makeWorkerService({ createThrows: true });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 5)], 'user-1');
        expect(ev.verdict).toBe('inconclusive');
        expect(ev.simStatus).toBe('skipped');
        expect(ev.runError).toMatch(/queue|worker|unavailable/i);
        expect(ev.assertions[0]!.pass).toBe(false); // can't certify an unmeasured spec
    });

    it('a job nothing consumes (no worker → poll never reaches terminal) is INCONCLUSIVE, not a fail', async () => {
        const prev = process.env.VERIFY_POLL_TIMEOUT_MS;
        process.env.VERIFY_POLL_TIMEOUT_MS = '30'; // expire the server-side poll fast
        try {
            const { svc, getResult } = makeWorkerService({ status: 'RUNNING' }); // never reaches a terminal state
            const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 5)], 'user-1');
            expect(ev.verdict).toBe('inconclusive');
            expect(ev.simStatus).toBe('skipped');
            expect(ev.runError).toMatch(/did not start|no worker|backlog/i);
            expect(getResult).not.toHaveBeenCalled(); // never fetched a result
        } finally {
            if (prev === undefined) delete process.env.VERIFY_POLL_TIMEOUT_MS;
            else process.env.VERIFY_POLL_TIMEOUT_MS = prev;
        }
    });

    it('a terminal TIMED_OUT (ngspice ran but exceeded its limit) is a FAIL, not inconclusive', async () => {
        const { svc } = makeWorkerService({ status: 'TIMED_OUT' });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 5)], 'user-1');
        expect(ev.verdict).toBe('fail'); // ngspice executed; the circuit couldn't simulate → genuine fault
        expect(ev.simStatus).toBe('failed');
    });

    it('ERC errors beat an infra outage: a broken circuit + unreachable queue is still a FAIL', async () => {
        const noGround: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'a' }, { pinId: '-', netId: 'b' }] },
                { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'a' }, { pinId: '2', netId: 'b' }] },
            ],
            nets: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }],
        };
        const { svc } = makeWorkerService({ createThrows: true });
        const ev = await svc.verify(noGround, { type: 'op' }, [], 'user-1');
        expect(ev.erc.errors.length).toBeGreaterThan(0);
        expect(ev.verdict).toBe('fail'); // a deterministic ERC fault stands even when the sim couldn't run
    });

    it('a worker INFRA failure (FAILED + failureClass=infra: bad NGSPICE_PATH / S3 / DB) is INCONCLUSIVE', async () => {
        const { svc } = makeWorkerService({ status: 'FAILED', metrics: { failureClass: 'infra', error: 'ngspice could not be launched' } });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 5)], 'user-1');
        expect(ev.verdict).toBe('inconclusive');
        expect(ev.simStatus).toBe('skipped');
        expect(ev.runError).toMatch(/infrastructure/i);
    });

    it('a genuine ngspice failure (FAILED + failureClass=sim) is still a FAIL', async () => {
        const { svc } = makeWorkerService({ status: 'FAILED', metrics: { failureClass: 'sim', error: 'ngspice exited with code 1' } });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 5)], 'user-1');
        expect(ev.verdict).toBe('fail');
        expect(ev.simStatus).toBe('failed');
    });

    it('surfaces the worker Convergence Doctor report when a remedy rescued the run (recovered → PASS + report)', async () => {
        // The worker walked the ladder, the first remedy fixed a singular matrix, and it persisted the
        // report in metrics. verify() must surface it on the evidence even though the verdict is a clean pass.
        const convergence = { recovered: true, kind: 'singular_matrix', diagnosis: 'matrix singular', remedyApplied: 'add gmin', rationale: 'a tiny conductance to ground', attempts: 1 };
        const { svc } = makeWorkerService({ status: 'SUCCEEDED', metrics: { pointsCount: 1, convergence } });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 5.0, 0.1)], 'user-1');
        expect(ev.verdict).toBe('pass'); // the rescued run still passes the spec
        expect(ev.convergence).toMatchObject({ recovered: true, kind: 'singular_matrix', remedyApplied: 'add gmin' });
    });

    it('surfaces a recovered:false Convergence report on a remedy-resistant FAILED run (FAIL + report)', async () => {
        // ngspice ran, the ladder was fully walked, nothing converged → a genuine, remedy-resistant fault.
        const convergence = { recovered: false, kind: 'no_convergence', diagnosis: 'no solution at default accuracy', attempts: 3, triedRemedies: ['add gmin', 'relaxed tolerances + gmin', 'aggressive relaxation (last resort)'] };
        const { svc } = makeWorkerService({ status: 'FAILED', metrics: { failureClass: 'sim', error: 'no convergence', convergence } });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 5)], 'user-1');
        expect(ev.verdict).toBe('fail');
        expect(ev.convergence).toMatchObject({ recovered: false, kind: 'no_convergence' });
        expect(ev.convergence!.triedRemedies!.length).toBe(3);
    });

    it('a SUCCEEDED job whose result is unavailable from storage (S3 outage) is INCONCLUSIVE, not a fail', async () => {
        const { svc } = makeWorkerService({ status: 'SUCCEEDED', result: null, resultError: 'Result data is currently unavailable from storage.' });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 5)], 'user-1');
        expect(ev.verdict).toBe('inconclusive');
        expect(ev.simStatus).toBe('skipped');
        expect(ev.runError).toMatch(/storage|unavailable/i);
    });

    it('a SUCCEEDED job with a genuinely empty result (no storage error) is a FAIL (degenerate no-data)', async () => {
        const emptyResult = { meta: { analysisType: 'op', xLabel: 't', pointsCount: 0 }, series: [] };
        const { svc } = makeWorkerService({ status: 'SUCCEEDED', result: emptyResult });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [], 'user-1');
        expect(ev.verdict).toBe('fail');
        expect(ev.simStatus).toBe('failed');
    });

    it('ERC errors are caught API-side BEFORE enqueuing (no point simulating a broken circuit)', async () => {
        const noGround: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'a' }, { pinId: '-', netId: 'b' }] },
                { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'a' }, { pinId: '2', netId: 'b' }] },
            ],
            nets: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }],
        };
        const { svc } = makeWorkerService();
        const ev = await svc.verify(noGround, { type: 'op' }, [], 'user-1');
        expect(ev.erc.errors.length).toBeGreaterThan(0); // ERC ran API-side
        expect(ev.verdict).toBe('fail');
    });

    it('falls back to the inline simulator when there is no userId (dev / live specs)', async () => {
        const { svc, createQuickSim, simulateWithRemedies } = makeWorkerService();
        (simulateWithRemedies as jest.Mock).mockResolvedValue(okSim());
        await svc.verify(DIVIDER, { type: 'op' }, []); // no userId
        expect(simulateWithRemedies).toHaveBeenCalledTimes(1);
        expect(createQuickSim).not.toHaveBeenCalled();
    });
});

/**
 * Regression for the SILENT verdict-gating gap: the worker computes listing-derived metrics (THD from a
 * `fourier` request; small-signal gain from a `tf` request) and puts them on SimulationResult.fourier /
 * .transferFunction — but runViaWorker used to distil ONLY the wrdata series and never fold those onto the
 * measurements. A thd/gain acceptance criterion (accepted by the public AssertionDto) could therefore NEVER
 * pass on /verify-design — an always-"not determinable" false-negative on a shipped feature. These lock the
 * fix at the SERVICE SEAM (the untested boundary that let it slip; eda-core's attach helpers + the worker
 * runner + the MC batch were each already covered). ngspice-free: the worker result is injected directly.
 */
const OUT_NODE = `v(${sanitizeNodeName('out')})`;

/** A worker SimulationResult carrying the given listing-derived metrics on the output node. */
const resultWith = (extra: { thd?: number; gain?: number }) => ({
    meta: { analysisType: extra.gain !== undefined ? 'op' : 'tran', xLabel: 't', pointsCount: 2 },
    series: [
        { name: `v(${sanitizeNodeName('in')})`, points: [{ x: 0, y: 10 }, { x: 1e-3, y: 10 }] },
        { name: OUT_NODE, points: [{ x: 0, y: 5 }, { x: 1e-3, y: 5 }] },
    ],
    ...(extra.thd !== undefined ? { fourier: [{ probe: OUT_NODE, fundamentalFreq: 1000, thd: extra.thd, harmonics: [] }] } : {}),
    ...(extra.gain !== undefined ? { transferFunction: { gain: extra.gain, outputNode: OUT_NODE, inputSource: 'V1' } } : {}),
});

describe('VerificationService — THD / gain verdict-gating on the worker path (regression)', () => {
    const TRAN = { type: 'tran', stopTime: '2m', stepTime: '5u', fourier: { fundamentalFreq: '1k', probes: ['v(out)'] } } as never;
    const OP_TF = { type: 'op', tf: { output: 'v(out)', inputSource: 'V1' } } as never;

    it('a thd criterion PASSES when the worker returned fourier data (THD folded onto the measurement)', async () => {
        const { svc } = makeWorkerService({ status: 'SUCCEEDED', result: resultWith({ thd: 0.5 }) });
        const ev = await svc.verify(DIVIDER, TRAN, [A('out', 'thd', 'lt', 1)], 'user-1');
        expect(ev.assertions[0]!.actual).toBe(0.5); // was null (always-fail) before the fix
        expect(ev.assertions[0]!.pass).toBe(true); // 0.5% < 1%
        expect(ev.verdict).toBe('pass');
    });

    it('a thd criterion is a clean FAIL (measured, not "not determinable") when THD exceeds the limit', async () => {
        const { svc } = makeWorkerService({ status: 'SUCCEEDED', result: resultWith({ thd: 4.2 }) });
        const ev = await svc.verify(DIVIDER, TRAN, [A('out', 'thd', 'lt', 1)], 'user-1');
        expect(ev.assertions[0]!.actual).toBe(4.2); // a real measured value, not null
        expect(ev.assertions[0]!.pass).toBe(false); // 4.2% not < 1%
        expect(ev.verdict).toBe('fail');
    });

    it('a gain criterion PASSES when the worker returned a transfer-function result', async () => {
        const { svc } = makeWorkerService({ status: 'SUCCEEDED', result: resultWith({ gain: 10 }) });
        const ev = await svc.verify(DIVIDER, OP_TF, [A('out', 'gain', 'approx', 10, 0.5)], 'user-1');
        expect(ev.assertions[0]!.actual).toBe(10); // gain folded on (was null before the fix)
        expect(ev.assertions[0]!.pass).toBe(true);
        expect(ev.verdict).toBe('pass');
    });

    it('a thd criterion with NO fourier data stays honestly "not determinable" (never a false pass)', async () => {
        // default workerResult carries no fourier → thd undefined → the criterion cannot be certified.
        const { svc } = makeWorkerService();
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'thd', 'lt', 1)], 'user-1');
        expect(ev.assertions[0]!.actual).toBeNull();
        expect(ev.assertions[0]!.pass).toBe(false);
        expect(ev.assertions[0]!.detail).toMatch(/thd|fourier|determinable/i);
        expect(ev.verdict).toBe('fail'); // an undeterminable spec fails the verdict — honest, not silent-pass
    });

    it('a thd criterion on a DIFFERENT node than the fourier probe stays "not determinable" (no cross-node bleed)', async () => {
        // fourier is present but only for OUT_NODE; asserting thd on 'in' must NOT borrow the out-node THD.
        const { svc } = makeWorkerService({ status: 'SUCCEEDED', result: resultWith({ thd: 0.5 }) });
        const ev = await svc.verify(DIVIDER, TRAN, [A('in', 'thd', 'lt', 1)], 'user-1');
        expect(ev.assertions[0]!.actual).toBeNull(); // THD folded onto 'out', never onto 'in'
        expect(ev.assertions[0]!.pass).toBe(false);
        expect(ev.verdict).toBe('fail');
    });

    it('a gain criterion with a NON-FINITE gain in the tf result stays "not determinable" (no false value)', async () => {
        // transferFunction present but gain=NaN (unparseable ngspice value) → attachTransferFunction guards
        // Number.isFinite and skips → the criterion cannot be certified rather than reading a bogus number.
        const { svc } = makeWorkerService({ status: 'SUCCEEDED', result: resultWith({ gain: NaN }) });
        const ev = await svc.verify(DIVIDER, OP_TF, [A('out', 'gain', 'approx', 10, 0.5)], 'user-1');
        expect(ev.assertions[0]!.actual).toBeNull();
        expect(ev.assertions[0]!.pass).toBe(false);
        expect(ev.verdict).toBe('fail');
    });

    it('a gain criterion uses the DEFAULT 5% tolerance when tol is omitted (within band → pass)', async () => {
        const { svc } = makeWorkerService({ status: 'SUCCEEDED', result: resultWith({ gain: 9.6 }) });
        const ev = await svc.verify(DIVIDER, OP_TF, [A('out', 'gain', 'approx', 10)], 'user-1'); // no tol → ±5% = ±0.5
        expect(ev.assertions[0]!.actual).toBe(9.6);
        expect(ev.assertions[0]!.pass).toBe(true); // |9.6-10| = 0.4 ≤ 0.5
        expect(ev.verdict).toBe('pass');
    });

    it('a gain criterion FAILS just outside the default 5% tolerance (the band is real, not unbounded)', async () => {
        const { svc } = makeWorkerService({ status: 'SUCCEEDED', result: resultWith({ gain: 9.4 }) });
        const ev = await svc.verify(DIVIDER, OP_TF, [A('out', 'gain', 'approx', 10)], 'user-1');
        expect(ev.assertions[0]!.actual).toBe(9.4);
        expect(ev.assertions[0]!.pass).toBe(false); // |9.4-10| = 0.6 > 0.5
        expect(ev.verdict).toBe('fail');
    });
});

describe('VerificationService — worst-case (corner) robustness option (informational, never gates the verdict)', () => {
    const passing = [A('out', 'final', 'approx', 5.0, 0.1)]; // DIVIDER out≈5 → nominal PASS
    const wc = (over: Record<string, unknown> = {}) => ({
        componentsCornered: ['R1', 'R2'], omitted: [], evaluated: 4, passed: 4, failed: 0, errored: 0,
        passAllCorners: true, worstCorners: [], ...over,
    });

    it('runs the corner batch and folds passAllCorners into evidence.robustness when the nominal verdict is pass', async () => {
        const { svc, createCornerJob } = makeWorkerService({ status: 'SUCCEEDED', metrics: { pointsCount: 1, worstCase: wc() } });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, passing, 'user-1', { corner: true });
        expect(ev.verdict).toBe('pass');
        expect(createCornerJob).toHaveBeenCalledTimes(1);
        expect(ev.robustness?.worstCase?.passAllCorners).toBe(true);
        expect(ev.robustness?.worstCase?.componentsCornered).toEqual(['R1', 'R2']);
    });

    it('surfaces the failing corner (does NOT change the pass verdict — robustness is informational)', async () => {
        const failing = wc({ passed: 3, failed: 1, passAllCorners: false, worstCorners: [{ R1: 'hi', R2: 'lo' }] });
        const { svc } = makeWorkerService({ status: 'SUCCEEDED', metrics: { pointsCount: 1, worstCase: failing } });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, passing, 'user-1', { corner: true });
        expect(ev.verdict).toBe('pass'); // nominal still passes — the corner miss NEVER flips the verdict
        expect(ev.robustness?.worstCase?.passAllCorners).toBe(false);
        expect(ev.robustness?.worstCase?.worstCorners).toContainEqual({ R1: 'hi', R2: 'lo' });
    });

    it('is SKIPPED entirely when the nominal verdict is not pass (no point cornering a failing design)', async () => {
        const { svc, createCornerJob } = makeWorkerService({ status: 'SUCCEEDED', metrics: { pointsCount: 1, worstCase: wc() } });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 99)], 'user-1', { corner: true }); // 5≉99 → fail
        expect(ev.verdict).toBe('fail');
        expect(createCornerJob).not.toHaveBeenCalled();
        expect(ev.robustness).toBeUndefined();
    });

    it('is not run at all when the caller does not request it', async () => {
        const { svc, createCornerJob } = makeWorkerService({ status: 'SUCCEEDED', metrics: { pointsCount: 1, worstCase: wc() } });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, passing, 'user-1'); // no robustness arg
        expect(createCornerJob).not.toHaveBeenCalled();
        expect(ev.robustness).toBeUndefined();
    });

    it('reports "unavailable" (no toleranced components) when the corner batch evaluated nothing', async () => {
        const empty = wc({ componentsCornered: [], evaluated: 0, passed: 0, passAllCorners: false });
        const { svc } = makeWorkerService({ status: 'SUCCEEDED', metrics: { pointsCount: 1, worstCase: empty } });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, passing, 'user-1', { corner: true });
        expect(ev.verdict).toBe('pass');
        expect(ev.robustness?.worstCase).toBeUndefined();
        expect(ev.robustness?.unavailable).toMatch(/toleranced/i);
    });

    it('reports "unavailable" (never throws / never a design fail) when the corner batch enqueue fails', async () => {
        const { svc, createCornerJob } = makeWorkerService({ status: 'SUCCEEDED', metrics: { pointsCount: 1, worstCase: wc() } });
        (createCornerJob as jest.Mock).mockRejectedValueOnce(new Error('Redis down'));
        const ev = await svc.verify(DIVIDER, { type: 'op' }, passing, 'user-1', { corner: true });
        expect(ev.verdict).toBe('pass'); // infra failure of the informational check never touches the verdict
        expect(ev.robustness?.unavailable).toMatch(/worker|queue|unavailable/i);
    });
});
