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
        const ev = await svc.verify({}, undefined, []);
        expect(ev.verdict).toBe('pass');
        expect(ev.summary).toMatch(/warning/i);
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
    const simulation = { createQuickSim, getStatus, getResult } as unknown as SimulationService;
    const simulateWithRemedies = jest.fn(); // must NOT be called on the worker path
    const simulator = { simulateWithRemedies } as unknown as CircuitSimulatorService;
    return { svc: new VerificationService(simulator, simulation), createQuickSim, getStatus, getResult, simulateWithRemedies };
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
