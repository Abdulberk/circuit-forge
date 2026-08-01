/**
 * VerificationService — assertion evaluation + verdict logic. CircuitSimulatorService is stubbed so
 * the suite is deterministic and ngspice-free; the assertion math and verdict rules are the contract.
 */
import { sanitizeNodeName, type CircuitJson } from '@circuit-forge/eda-core';

import type { SimulationService } from '../simulation/simulation.service';

import type { CircuitSimulatorService, SimSummary } from './circuit-simulator.service';
import type { AssertionDto } from './dto';
import {
    VerificationService,
    isCurrentProbe,
    deriveToleranceBasis,
    robustnessManifestEntry,
} from './verification.service';

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

const A = (
    probe: string,
    metric: AssertionDto['metric'],
    op: AssertionDto['op'],
    value: number,
    tol?: number,
): AssertionDto => ({
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

    it('emits a scope manifest: run for sim/erc + the covered assertion dimension, honest not-run for the rest', async () => {
        const { svc } = makeService(okSim());
        // a voltage spec + a current spec (i() probe) → assertion.voltage + assertion.current covered
        const ev = await svc.verify({}, undefined, [
            A('out', 'final', 'approx', 4.98),
            A('i(R1)', 'final', 'gt', 0.001),
        ]);
        const s = new Map(ev.scope.checks.map((c) => [c.id, c]));
        expect(s.get('sim')!.status).toBe('run');
        expect(s.get('erc')!.status).toBe('run');
        expect(s.get('assertion.voltage')!.status).toBe('run');
        expect(s.get('assertion.current')!.status).toBe('run');
        expect(s.get('assertion.frequency')!.status).toBe('not-run');
        // the honesty contract: checks we do NOT yet run are disclosed, not omitted
        expect(s.get('decoupling')!.status).toBe('not-run');
        expect(s.get('polarity')!.status).toBe('not-run');
    });

    it('scope discloses sim as not-run when the simulation was skipped', async () => {
        const { svc } = makeService(okSim({ simStatus: 'skipped', measurements: [] }));
        const ev = await svc.verify({}, undefined, []);
        expect(new Map(ev.scope.checks.map((c) => [c.id, c])).get('sim')!.status).toBe('not-run');
    });

    it('scope discloses sim as not-run when the simulation FAILED (never a false "Simulation ran")', async () => {
        // a failed run produced no usable simulation — the manifest must not claim it ran
        const { svc } = makeService(okSim({ simStatus: 'failed', measurements: [] }));
        const ev = await svc.verify({}, undefined, [A('out', 'final', 'approx', 5)]);
        expect(new Map(ev.scope.checks.map((c) => [c.id, c])).get('sim')!.status).toBe('not-run');
    });

    it('matches probes with or without the v()/i() wrapper, case-insensitively', async () => {
        const { svc } = makeService(okSim());
        const ev = await svc.verify({}, undefined, [
            A('V(OUT)', 'final', 'approx', 4.98),
            A('out', 'final', 'approx', 4.98),
        ]);
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
        const { svc } = makeService(
            okSim({ ercErrors: [{ code: 'SHORT', message: 'short to ground', relatedIds: ['R1'] }] }),
        );
        const ev = await svc.verify({}, undefined, []);
        expect(ev.verdict).toBe('fail');
        expect(ev.summary).toMatch(/ERC error/);
    });

    it('PASS with ERC warnings noted (warnings do not fail the verdict)', async () => {
        const { svc } = makeService(
            okSim({ ercWarnings: [{ code: 'FLOAT_R', message: 'floating reactive node', relatedIds: ['C1'] }] }),
        );
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
        const { svc } = makeService({
            simStatus: 'failed',
            ercErrors: [],
            ercWarnings: [],
            measurements: [],
            nodeCount: 0,
            runError: 'timed out',
        });
        const ev = await svc.verify({}, undefined, [A('out', 'final', 'approx', 5)]);
        expect(ev.verdict).toBe('fail');
        expect(ev.assertions[0]!.actual).toBeNull();
        expect(ev.assertions[0]!.pass).toBe(false);
    });

    it('INCONCLUSIVE: ngspice not configured (skipped) cannot certify anything', async () => {
        const { svc } = makeService({
            simStatus: 'skipped',
            ercErrors: [],
            ercWarnings: [],
            measurements: [],
            nodeCount: 0,
            runError: 'simulation not configured',
        });
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
        const { svc } = makeService(
            okSim({ measurements: [], ercErrors: [{ code: 'X', message: 'm', relatedIds: [] }] }),
        );
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
        {
            id: 'v1',
            type: 'voltage_source',
            designator: 'V1',
            value: 'DC 10',
            pins: [
                { pinId: '+', netId: 'in' },
                { pinId: '-', netId: 'gnd' },
            ],
        },
        {
            id: 'r1',
            type: 'resistor',
            designator: 'R1',
            value: '1k',
            pins: [
                { pinId: '1', netId: 'in' },
                { pinId: '2', netId: 'out' },
            ],
        },
        {
            id: 'r2',
            type: 'resistor',
            designator: 'R2',
            value: '1k',
            pins: [
                { pinId: '1', netId: 'out' },
                { pinId: '2', netId: 'gnd' },
            ],
        },
        { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [
        { id: 'in', name: 'in' },
        { id: 'out', name: 'out' },
        { id: 'gnd', name: 'gnd', isGround: true },
    ],
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

function makeWorkerService(
    opts: { status?: string; metrics?: unknown; result?: unknown; resultError?: string; createThrows?: boolean } = {},
) {
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
    const createMonteCarloJob = jest.fn(async () => ({ jobId: 'mc-1' }));
    const createTempCornerJob = jest.fn(async () => ({ jobId: 'temp-1' }));
    const createSupplyCornerJob = jest.fn(async () => ({ jobId: 'supply-1' }));
    const simulation = {
        createQuickSim,
        getStatus,
        getResult,
        createCornerJob,
        createMonteCarloJob,
        createTempCornerJob,
        createSupplyCornerJob,
    } as unknown as SimulationService;
    const simulateWithRemedies = jest.fn(); // must NOT be called on the worker path
    const simulator = { simulateWithRemedies } as unknown as CircuitSimulatorService;
    return {
        svc: new VerificationService(simulator, simulation),
        createQuickSim,
        getStatus,
        getResult,
        createCornerJob,
        createMonteCarloJob,
        createTempCornerJob,
        createSupplyCornerJob,
        simulateWithRemedies,
    };
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
                {
                    id: 'v1',
                    type: 'voltage_source',
                    designator: 'V1',
                    value: 'DC 5',
                    pins: [
                        { pinId: '+', netId: 'a' },
                        { pinId: '-', netId: 'b' },
                    ],
                },
                {
                    id: 'r1',
                    type: 'resistor',
                    designator: 'R1',
                    value: '1k',
                    pins: [
                        { pinId: '1', netId: 'a' },
                        { pinId: '2', netId: 'b' },
                    ],
                },
            ],
            nets: [
                { id: 'a', name: 'a' },
                { id: 'b', name: 'b' },
            ],
        };
        const { svc } = makeWorkerService({ createThrows: true });
        const ev = await svc.verify(noGround, { type: 'op' }, [], 'user-1');
        expect(ev.erc.errors.length).toBeGreaterThan(0);
        expect(ev.verdict).toBe('fail'); // a deterministic ERC fault stands even when the sim couldn't run
    });

    it('a worker INFRA failure (FAILED + failureClass=infra: bad NGSPICE_PATH / S3 / DB) is INCONCLUSIVE', async () => {
        const { svc } = makeWorkerService({
            status: 'FAILED',
            metrics: { failureClass: 'infra', error: 'ngspice could not be launched' },
        });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 5)], 'user-1');
        expect(ev.verdict).toBe('inconclusive');
        expect(ev.simStatus).toBe('skipped');
        expect(ev.runError).toMatch(/infrastructure/i);
    });

    it('a genuine ngspice failure (FAILED + failureClass=sim) is still a FAIL', async () => {
        const { svc } = makeWorkerService({
            status: 'FAILED',
            metrics: { failureClass: 'sim', error: 'ngspice exited with code 1' },
        });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 5)], 'user-1');
        expect(ev.verdict).toBe('fail');
        expect(ev.simStatus).toBe('failed');
    });

    it('surfaces the worker Convergence Doctor report when a remedy rescued the run (recovered → PASS + report)', async () => {
        // The worker walked the ladder, the first remedy fixed a singular matrix, and it persisted the
        // report in metrics. verify() must surface it on the evidence even though the verdict is a clean pass.
        const convergence = {
            recovered: true,
            kind: 'singular_matrix',
            diagnosis: 'matrix singular',
            remedyApplied: 'add gmin',
            rationale: 'a tiny conductance to ground',
            attempts: 1,
        };
        const { svc } = makeWorkerService({ status: 'SUCCEEDED', metrics: { pointsCount: 1, convergence } });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 5.0, 0.1)], 'user-1');
        expect(ev.verdict).toBe('pass'); // the rescued run still passes the spec
        expect(ev.convergence).toMatchObject({ recovered: true, kind: 'singular_matrix', remedyApplied: 'add gmin' });
    });

    it('surfaces a recovered:false Convergence report on a remedy-resistant FAILED run (FAIL + report)', async () => {
        // ngspice ran, the ladder was fully walked, nothing converged → a genuine, remedy-resistant fault.
        const convergence = {
            recovered: false,
            kind: 'no_convergence',
            diagnosis: 'no solution at default accuracy',
            attempts: 3,
            triedRemedies: ['add gmin', 'relaxed tolerances + gmin', 'aggressive relaxation (last resort)'],
        };
        const { svc } = makeWorkerService({
            status: 'FAILED',
            metrics: { failureClass: 'sim', error: 'no convergence', convergence },
        });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 5)], 'user-1');
        expect(ev.verdict).toBe('fail');
        expect(ev.convergence).toMatchObject({ recovered: false, kind: 'no_convergence' });
        expect(ev.convergence!.triedRemedies!.length).toBe(3);
    });

    it('a SUCCEEDED job whose result is unavailable from storage (S3 outage) is INCONCLUSIVE, not a fail', async () => {
        const { svc } = makeWorkerService({
            status: 'SUCCEEDED',
            result: null,
            resultError: 'Result data is currently unavailable from storage.',
        });
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
                {
                    id: 'v1',
                    type: 'voltage_source',
                    designator: 'V1',
                    value: 'DC 5',
                    pins: [
                        { pinId: '+', netId: 'a' },
                        { pinId: '-', netId: 'b' },
                    ],
                },
                {
                    id: 'r1',
                    type: 'resistor',
                    designator: 'R1',
                    value: '1k',
                    pins: [
                        { pinId: '1', netId: 'a' },
                        { pinId: '2', netId: 'b' },
                    ],
                },
            ],
            nets: [
                { id: 'a', name: 'a' },
                { id: 'b', name: 'b' },
            ],
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
        {
            name: `v(${sanitizeNodeName('in')})`,
            points: [
                { x: 0, y: 10 },
                { x: 1e-3, y: 10 },
            ],
        },
        {
            name: OUT_NODE,
            points: [
                { x: 0, y: 5 },
                { x: 1e-3, y: 5 },
            ],
        },
    ],
    ...(extra.thd !== undefined
        ? { fourier: [{ probe: OUT_NODE, fundamentalFreq: 1000, thd: extra.thd, harmonics: [] }] }
        : {}),
    ...(extra.gain !== undefined
        ? { transferFunction: { gain: extra.gain, outputNode: OUT_NODE, inputSource: 'V1' } }
        : {}),
});

describe('VerificationService — THD / gain verdict-gating on the worker path (regression)', () => {
    const TRAN = {
        type: 'tran',
        stopTime: '2m',
        stepTime: '5u',
        fourier: { fundamentalFreq: '1k', probes: ['v(out)'] },
    } as never;
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
        componentsCornered: ['R1', 'R2'],
        omitted: [],
        evaluated: 4,
        passed: 4,
        failed: 0,
        errored: 0,
        passAllCorners: true,
        worstCorners: [],
        ...over,
    });

    it('runs the corner batch and folds passAllCorners into evidence.robustness when the nominal verdict is pass', async () => {
        const { svc, createCornerJob } = makeWorkerService({
            status: 'SUCCEEDED',
            metrics: { pointsCount: 1, worstCase: wc() },
        });
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
        const { svc, createCornerJob } = makeWorkerService({
            status: 'SUCCEEDED',
            metrics: { pointsCount: 1, worstCase: wc() },
        });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 99)], 'user-1', {
            corner: true,
        }); // 5≉99 → fail
        expect(ev.verdict).toBe('fail');
        expect(createCornerJob).not.toHaveBeenCalled();
        expect(ev.robustness).toBeUndefined();
    });

    it('is not run at all when the caller does not request it', async () => {
        const { svc, createCornerJob } = makeWorkerService({
            status: 'SUCCEEDED',
            metrics: { pointsCount: 1, worstCase: wc() },
        });
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
        const { svc, createCornerJob } = makeWorkerService({
            status: 'SUCCEEDED',
            metrics: { pointsCount: 1, worstCase: wc() },
        });
        (createCornerJob as jest.Mock).mockRejectedValueOnce(new Error('Redis down'));
        const ev = await svc.verify(DIVIDER, { type: 'op' }, passing, 'user-1', { corner: true });
        expect(ev.verdict).toBe('pass'); // infra failure of the informational check never touches the verdict
        expect(ev.robustness?.unavailable).toMatch(/worker|queue|unavailable/i);
    });
});

describe('VerificationService — Monte-Carlo robustness tier + gate', () => {
    const passSpec = [A('out', 'final', 'approx', 5.0, 0.1)]; // workerResult out=5 → nominal pass
    const withTol = (source: 'user' | 'catalog') =>
        ({
            ...DIVIDER,
            components: DIVIDER.components.map((c) =>
                c.id === 'r1' ? { ...c, tolerance: 0.01, toleranceSource: source } : c,
            ),
        }) as CircuitJson;
    const atRisk = {
        total: 100,
        evaluated: 100,
        passed: 80,
        failed: 20,
        errored: 0,
        yield: 0.8,
        ci95: { low: 0.71, high: 0.87 },
    };
    const robust = {
        total: 500,
        evaluated: 500,
        passed: 500,
        failed: 0,
        errored: 0,
        yield: 1,
        ci95: { low: 0.994, high: 1 },
    };

    it('at-risk tier on USER-specified tolerances GATES: the nominal pass flips to fail, disclosed', async () => {
        const { svc, createMonteCarloJob } = makeWorkerService({ metrics: { monteCarlo: atRisk } });
        const ev = await svc.verify(withTol('user'), { type: 'op' }, passSpec, 'user-1', { montecarlo: true });
        expect(createMonteCarloJob).toHaveBeenCalledTimes(1);
        expect(ev.montecarlo?.tier).toBe('at-risk');
        expect(ev.montecarlo?.toleranceBasis).toBe('user-specified');
        expect(ev.montecarlo?.gated).toBe(true);
        expect(ev.verdict).toBe('fail'); // the gate flipped the nominal pass
        // the top-level summary must EXPLAIN the robustness gate (never the malformed "Not verified: .")
        expect(ev.summary).toMatch(/production-robust/i);
        expect(ev.summary).not.toBe('Not verified: .');
        const rob = ev.scope.checks.find((c) => c.id === 'robustness');
        expect(rob?.status).toBe('run');
        expect(rob?.detail).toMatch(/at-risk/);
        expect(rob?.detail).toMatch(/GATED/);
    });

    it('at-risk on a MIXED (user + catalog) circuit does NOT gate — the at-risk is not purely user-caused', async () => {
        // r1 user-toleranced, r2 catalog-toleranced → basis 'mixed'. The worker perturbs both, so an at-risk
        // could be driven by the catalog spread; we must NOT auto-fail on tolerances the user didn't fully own.
        const mixed = {
            ...DIVIDER,
            components: DIVIDER.components.map((c) =>
                c.id === 'r1'
                    ? { ...c, tolerance: 0.01, toleranceSource: 'user' }
                    : c.id === 'r2'
                      ? { ...c, tolerance: 0.05, toleranceSource: 'catalog' }
                      : c,
            ),
        } as CircuitJson;
        const { svc } = makeWorkerService({ metrics: { monteCarlo: atRisk } });
        const ev = await svc.verify(mixed, { type: 'op' }, passSpec, 'user-1', { montecarlo: true });
        expect(ev.montecarlo?.tier).toBe('at-risk');
        expect(ev.montecarlo?.toleranceBasis).toBe('mixed');
        expect(ev.montecarlo?.gated).toBeFalsy();
        expect(ev.verdict).toBe('pass'); // informational — disclosed at-risk, but not a user-owned gate
    });

    it('at-risk on CATALOG-derived tolerances is INFORMATIONAL: verdict stays pass, not gated', async () => {
        const { svc } = makeWorkerService({ metrics: { monteCarlo: atRisk } });
        const ev = await svc.verify(withTol('catalog'), { type: 'op' }, passSpec, 'user-1', { montecarlo: true });
        expect(ev.montecarlo?.tier).toBe('at-risk');
        expect(ev.montecarlo?.toleranceBasis).toBe('catalog');
        expect(ev.montecarlo?.gated).toBeFalsy();
        expect(ev.verdict).toBe('pass'); // a catalog-derived at-risk never auto-fails a design the user didn't gate on
    });

    it('a robust tier never gates (verdict stays pass) and discloses N + basis', async () => {
        const { svc } = makeWorkerService({ metrics: { monteCarlo: robust } });
        const ev = await svc.verify(withTol('user'), { type: 'op' }, passSpec, 'user-1', { montecarlo: true });
        expect(ev.montecarlo?.tier).toBe('robust');
        expect(ev.montecarlo?.gated).toBeFalsy();
        expect(ev.verdict).toBe('pass');
        expect(ev.scope.checks.find((c) => c.id === 'robustness')?.detail).toMatch(/robust/);
    });

    it('does NOT run Monte-Carlo when the nominal verdict is not pass (no point)', async () => {
        const { svc, createMonteCarloJob } = makeWorkerService({ metrics: { monteCarlo: atRisk } });
        const ev = await svc.verify(withTol('user'), { type: 'op' }, [A('out', 'final', 'approx', 99)], 'user-1', {
            montecarlo: true,
        });
        expect(ev.verdict).toBe('fail'); // nominal spec unmet
        expect(createMonteCarloJob).not.toHaveBeenCalled();
    });

    it('a BUDGET-truncated at-risk run does NOT gate (a small-sample low bound is not a robustness failure)', async () => {
        const { svc } = makeWorkerService({ metrics: { monteCarlo: { ...atRisk, budgetHit: true } } });
        const ev = await svc.verify(withTol('user'), { type: 'op' }, passSpec, 'user-1', { montecarlo: true });
        expect(ev.montecarlo?.budgetHit).toBe(true);
        expect(ev.montecarlo?.gated).toBeFalsy();
        expect(ev.verdict).toBe('pass'); // never auto-fail on a run cut short by the wall-clock budget
        expect(ev.montecarlo?.note).toMatch(/INCOMPLETE/i);
    });

    it('a REQUESTED-but-unavailable Monte-Carlo discloses "requested but unavailable" (not "not requested")', async () => {
        const { svc } = makeWorkerService({ metrics: { monteCarlo: { ...atRisk, evaluated: 0 } } });
        const ev = await svc.verify(withTol('user'), { type: 'op' }, passSpec, 'user-1', { montecarlo: true });
        expect(ev.montecarlo?.unavailable).toBeTruthy();
        const rob = ev.scope.checks.find((c) => c.id === 'robustness');
        expect(rob?.detail).toMatch(/requested but unavailable/i);
        expect(rob?.detail).not.toMatch(/not requested/i);
    });

    it('SKIPS Monte-Carlo on a circuit with no toleranced parts (no wasted sims, honest disclosure)', async () => {
        const { svc, createMonteCarloJob } = makeWorkerService({ metrics: { monteCarlo: robust } });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, passSpec, 'user-1', { montecarlo: true }); // DIVIDER has no tolerances
        expect(createMonteCarloJob).not.toHaveBeenCalled(); // no ~500 identical sims burned
        expect(ev.montecarlo?.unavailable).toMatch(/no toleranced parts/i);
        expect(ev.verdict).toBe('pass');
    });
});

describe('deriveToleranceBasis — the honest provenance the tier discloses + the gate keys on', () => {
    const comp = (over: Record<string, unknown> = {}) => ({
        id: 'r1',
        type: 'resistor',
        designator: 'R1',
        value: '1k',
        pins: [
            { pinId: '1', netId: 'a' },
            { pinId: '2', netId: 'b' },
        ],
        ...over,
    });
    const circ = (comps: unknown[]) =>
        ({
            version: '1.0',
            components: comps,
            nets: [
                { id: 'a', name: 'a' },
                { id: 'b', name: 'b' },
            ],
        }) as CircuitJson;

    it("'none' when nothing is toleranced", () => expect(deriveToleranceBasis(circ([comp()]))).toBe('none'));
    it("'catalog' when EVERY toleranced part is catalog-sourced", () =>
        expect(deriveToleranceBasis(circ([comp({ tolerance: 0.01, toleranceSource: 'catalog' })]))).toBe('catalog'));
    it("'user-specified' only when EVERY toleranced part is user-stated (the whole spread is user-owned)", () =>
        expect(
            deriveToleranceBasis(
                circ([
                    comp({ tolerance: 0.01, toleranceSource: 'user' }),
                    comp({ id: 'r2', tolerance: 0.05, toleranceSource: 'user' }),
                ]),
            ),
        ).toBe('user-specified'));
    it("'mixed' when user + catalog tolerances coexist (NOT user-specified — the at-risk isn't purely user-caused)", () =>
        expect(
            deriveToleranceBasis(
                circ([
                    comp({ tolerance: 0.05, toleranceSource: 'catalog' }),
                    comp({ id: 'r2', tolerance: 0.01, toleranceSource: 'user' }),
                ]),
            ),
        ).toBe('mixed'));
    it("'unspecified' when a tolerance carries no recorded source", () =>
        expect(deriveToleranceBasis(circ([comp({ tolerance: 0.05 })]))).toBe('unspecified'));
});

describe('robustnessManifestEntry — composes every robustness sub-analysis (no early-return drop)', () => {
    const MC = { tier: 'robust', yieldLowerBound: 0.995, evaluated: 500, toleranceBasis: 'user-specified' } as never;
    const CORNER = {
        worstCase: {
            componentsCornered: ['R1'],
            omitted: [],
            evaluated: 2,
            passed: 2,
            failed: 0,
            errored: 0,
            passAllCorners: true,
            worstCorners: [],
        },
    } as never;
    const tempRun = (over: Record<string, unknown> = {}) =>
        ({
            tempCorner: {
                applicable: true,
                temperaturesC: [0, 25, 70],
                rangeLabel: 'consumer 0 / 25 / 70 C',
                evaluated: 3,
                passed: 3,
                failed: 0,
                errored: 0,
                hasLimits: true,
                passAllTemps: true,
                drift: [],
                ...over,
            },
        }) as never;

    it('MC-only detail is BYTE-IDENTICAL to the pre-compose format (zero regression)', () => {
        const e = robustnessManifestEntry(MC);
        expect(e.status).toBe('run');
        expect(e.detail).toBe(
            'robust — 99.5% yield (95% CI lower bound), 500 Monte-Carlo runs; tolerances: user-specified — informational (does not gate)',
        );
        expect(e.gradation).toBeUndefined();
        expect(e.detail).not.toContain(' | '); // a single clause never joins
    });

    it('corner-only detail is BYTE-IDENTICAL to the pre-compose format', () => {
        const e = robustnessManifestEntry(undefined, CORNER);
        expect(e.status).toBe('run');
        expect(e.detail).toBe('worst-case corner robustness — informational (does not gate the verdict)');
        expect(e.detail).not.toContain(' | ');
    });

    it('all THREE ran → none is dropped (MC + corner + temp all present), joined by " | "', () => {
        const e = robustnessManifestEntry(MC, CORNER, tempRun());
        const clauses = e.detail!.split(' | ');
        expect(clauses).toHaveLength(3);
        expect(e.detail).toContain('Monte-Carlo runs'); // MC survived (the early-return bug would have hidden the rest)
        expect(e.detail).toContain('worst-case corner robustness'); // corner survived
        expect(e.detail).toContain('temperature corners'); // temp survived
        expect(e.detail).toContain('self-heating'); // the ambient-only ceiling is disclosed
        expect(e.gradation).toBe('presence'); // a temperature corner ran → presence-depth marker
    });

    it('a temperature corner that is NOT-APPLICABLE is disclosed but does not count as "run" on its own', () => {
        const e = robustnessManifestEntry(
            undefined,
            undefined,
            tempRun({
                applicable: false,
                notApplicableReason: 'not-applicable — no temperature-responsive device (passive-only)',
                hasLimits: false,
                passAllTemps: false,
            }),
        );
        expect(e.status).toBe('not-run'); // not-applicable alone is not a run
        expect(e.detail).toContain('not-applicable');
        expect(e.gradation).toBeUndefined();
    });

    it('nothing requested → "not requested" (unchanged)', () => {
        expect(robustnessManifestEntry()).toEqual({ status: 'not-run', detail: 'tolerance robustness not requested' });
    });
});

describe('VerificationService — temperature corner is INFORMATIONAL (never gates)', () => {
    it('a FAILED temperature corner does NOT flip the verdict; the result is surfaced', async () => {
        const tempCorner = {
            applicable: true,
            temperaturesC: [0, 25, 70],
            rangeLabel: 'consumer 0 / 25 / 70 C',
            evaluated: 3,
            passed: 2,
            failed: 1,
            errored: 0,
            hasLimits: true,
            passAllTemps: false,
            drift: [],
        };
        const { svc, createTempCornerJob } = makeWorkerService({ metrics: { tempCorner } });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 5.0, 0.1)], 'user-1', {
            temperature: true,
        });
        expect(createTempCornerJob).toHaveBeenCalledTimes(1);
        expect(ev.verdict).toBe('pass'); // nominal passed; a failing AMBIENT-only temperature corner NEVER gates
        expect(ev.tempcorner?.tempCorner?.failed).toBe(1);
        expect(ev.tempcorner?.tempCorner?.passAllTemps).toBe(false);
        // and the scope manifest discloses it with the ambient-only ceiling
        const rob = ev.scope.checks.find((c) => c.id === 'robustness');
        expect(rob?.detail).toContain('self-heating');
        expect(rob?.gradation).toBe('presence');
    });
});

describe('robustnessManifestEntry — supply corner is a COMPOSED clause with an honest 3-way not-run', () => {
    const MC = { tier: 'robust', yieldLowerBound: 0.995, evaluated: 500, toleranceBasis: 'user-specified' } as never;
    const supply = () =>
        ({
            supplyCorner: {
                applicable: true,
                rails: [{ netId: 'vcc', status: 'trusted', driverDesignator: 'V1' }],
                omitted: [],
                tolerance: 0.05,
                rangeLabel: '±5%',
                evaluated: 2,
                passed: 2,
                failed: 0,
                errored: 0,
                hasLimits: true,
                passAllCorners: true,
                drift: [],
            },
        }) as never;

    it('a RAN supply corner joins as its own clause (does not overwrite MC — the early-return bug stays dead)', () => {
        const e = robustnessManifestEntry(MC, undefined, undefined, supply());
        expect(e.status).toBe('run');
        expect(e.detail).toContain('Monte-Carlo runs'); // MC survives
        expect(e.detail).toContain('supply corners (±5%)'); // supply is its OWN clause
        expect(e.detail!.split(' | ')).toHaveLength(2);
    });

    it('not-run (c): NO power rail marked reads as "not yet marked", not broken (the common freeze-era case)', () => {
        const e = robustnessManifestEntry(undefined, undefined, undefined, {
            supplyCorner: {
                applicable: false,
                rails: [],
                omitted: [],
                tolerance: 0.05,
                evaluated: 0,
                passed: 0,
                failed: 0,
                errored: 0,
                hasLimits: false,
                passAllCorners: false,
                drift: [],
            },
        } as never);
        expect(e.status).toBe('not-run');
        expect(e.detail).toMatch(/no power rail marked/i);
    });

    it('not-run (b): a marked rail that could not be validated surfaces the DEFERRAL reason (not silent)', () => {
        const e = robustnessManifestEntry(undefined, undefined, undefined, {
            supplyCorner: {
                applicable: false,
                rails: [{ netId: 'vref', status: 'deferred', reason: 'no DC power source drives this net' }],
                omitted: [],
                tolerance: 0.05,
                evaluated: 0,
                passed: 0,
                failed: 0,
                errored: 0,
                hasLimits: false,
                passAllCorners: false,
                drift: [],
            },
        } as never);
        expect(e.status).toBe('not-run');
        expect(e.detail).toMatch(/could not be validated: no DC power source/i);
    });
});

describe('VerificationService — supply corner is INFORMATIONAL (never gates)', () => {
    it('a FAILED supply corner does NOT flip the verdict; the result is surfaced', async () => {
        const supplyCorner = {
            applicable: true,
            rails: [{ netId: 'rail', status: 'trusted', driverDesignator: 'V1' }],
            omitted: [],
            tolerance: 0.05,
            rangeLabel: '±5%',
            evaluated: 2,
            passed: 1,
            failed: 1,
            errored: 0,
            hasLimits: true,
            passAllCorners: false,
            drift: [],
        };
        const { svc, createSupplyCornerJob } = makeWorkerService({ metrics: { supplyCorner } });
        const ev = await svc.verify(DIVIDER, { type: 'op' }, [A('out', 'final', 'approx', 5.0, 0.1)], 'user-1', {
            supply: true,
        });
        expect(createSupplyCornerJob).toHaveBeenCalledTimes(1);
        expect(ev.verdict).toBe('pass'); // nominal passed; a failing supply corner NEVER gates (informational)
        expect(ev.supplycorner?.supplyCorner?.failed).toBe(1);
        const rob = ev.scope.checks.find((c) => c.id === 'robustness');
        expect(rob?.detail).toContain('supply corners');
    });
});

describe('VerificationService — the component-stress gate', () => {
    /** A divider whose R1 is run past whatever rating the test gives it: 10V in, 5V out, R1 = 1k → 25mW. */
    const stressedCircuit = (r1: Record<string, unknown>): CircuitJson =>
        ({
            version: '1.0',
            components: [
                {
                    id: 'v1',
                    type: 'voltage_source',
                    designator: 'V1',
                    value: 'DC 10',
                    pins: [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: 'gnd' },
                    ],
                },
                {
                    id: 'r1',
                    type: 'resistor',
                    designator: 'R1',
                    value: '1k',
                    pins: [
                        { pinId: '1', netId: 'in' },
                        { pinId: '2', netId: 'out' },
                    ],
                    ...r1,
                },
                { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
            ],
            nets: [
                { id: 'in', name: 'in' },
                { id: 'out', name: 'out' },
                { id: 'gnd', name: 'gnd', isGround: true },
            ],
        }) as unknown as CircuitJson;

    /** op analysis so the dissipation basis is 'operating-point' — the gate-eligible one. */
    const opSim = okSim({
        analysisType: 'op',
        measurements: [
            { node: `v(${sanitizeNodeName('in')})`, min: 10, max: 10, final: 10, pp: 0, avg: 10, rms: 10 },
            { node: `v(${sanitizeNodeName('out')})`, min: 5, max: 5, final: 5, pp: 0, avg: 5, rms: 5 },
        ],
    });

    it('a part run past the limit its OWN datasheet declares is not a verified design', () => {
        // Every assertion below passes and the sim is clean — and the board would still cook R1. A verdict
        // that says "verified" here is the one the whole evidence pack exists to prevent.
        const { svc } = makeService(opSim);
        return svc
            .verify(stressedCircuit({ properties: { powerRating: 0.01 } }), { type: 'op' }, [
                A('out', 'final', 'approx', 5),
            ])
            .then((ev) => {
                expect(ev.verdict).toBe('fail');
                expect(ev.checks.failed).toBe(0); // NOT an assertion failure — the specs were all met
                expect(ev.summary).toMatch(/R1 dissipates/);
                expect(ev.summary).toMatch(/declared 0\.01W rating/);
                const drc = ev.scope.checks.find((c) => c.id === 'stress.resistor-power')!;
                expect(drc.detail).toMatch(/withheld the verdict/);
            });
    });

    it('the SAME overload against a rating we merely assumed is reported, and passes', async () => {
        // A 100Ω 01005 dropping 5V dissipates 250mW against the package's 31mW — eight times over, and
        // still not a gate, because WE chose that 31mW from a package code, not the designer. Refusing to
        // certify a board over our own guess would be a verdict about us. It is reported all the same.
        const { svc } = makeService(opSim);
        const ev = await svc.verify(stressedCircuit({ value: '100', footprint: '01005' }), { type: 'op' }, [
            A('out', 'final', 'approx', 5),
        ]);
        expect(ev.power!.components[0]).toMatchObject({ ratingSource: 'footprint', overRating: true });
        expect(ev.verdict).toBe('pass'); // surfaced in `power`, never withheld
    });

    it('a declared overload measured only as a SNAPSHOT is reported, and passes', async () => {
        // AC sweep → basis 'last-timestep', which is whatever the waveform was doing at the final point.
        // Failing a board on the sample we happened to stop at would be luck, not verification.
        const { svc } = makeService(okSim({ analysisType: 'ac', measurements: opSim.measurements }));
        const ev = await svc.verify(
            stressedCircuit({ properties: { powerRating: 0.01 } }),
            { type: 'ac', variation: 'dec', points: 10, startFreq: '1', stopFreq: '1meg' },
            [A('out', 'final', 'approx', 5)],
        );
        expect(ev.power!.components[0]).toMatchObject({ basis: 'last-timestep', overRating: true });
        expect(ev.verdict).toBe('pass');
    });

    it('a part inside its declared rating does not gate, and the manifest says the check ran', async () => {
        const { svc } = makeService(opSim);
        const ev = await svc.verify(stressedCircuit({ properties: { powerRating: 1 } }), { type: 'op' }, [
            A('out', 'final', 'approx', 5),
        ]);
        expect(ev.verdict).toBe('pass');
        const entry = ev.scope.checks.find((c) => c.id === 'stress.resistor-power')!;
        expect(entry.status).toBe('run');
        expect(entry.detail).toMatch(/only a declared-rating overload gates/);
    });
});

describe('VerificationService — the deck ↔ schematic disclosure', () => {
    /** An inverting amplifier whose op-amp is a catalog-only part: real footprint and pins, no SPICE model.
     *  The generator omits it, ERC passes it, and the simulation returns numbers for the resistors alone. */
    const opampAmp = (): CircuitJson =>
        ({
            version: '1.0',
            components: [
                { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 9', pins: [{ pinId: '+', netId: 'vcc' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'r1', type: 'resistor', designator: 'R1', value: '10k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'inm' }] },
                { id: 'r2', type: 'resistor', designator: 'R2', value: '100k', pins: [{ pinId: '1', netId: 'inm' }, { pinId: '2', netId: 'out' }] },
                { id: 'u1', type: 'generic', designator: 'U1', footprint: 'soic8', pins: [{ pinId: '1', netId: 'inm' }, { pinId: '2', netId: 'out' }, { pinId: '3', netId: 'vcc' }, { pinId: '4', netId: 'gnd' }] },
            ],
            nets: [
                { id: 'vcc', name: 'VCC' },
                { id: 'gnd', name: 'GND' },
                { id: 'in', name: 'IN' },
                { id: 'inm', name: 'INM' },
                { id: 'out', name: 'OUT' },
            ],
        }) as unknown as CircuitJson;

    it('names the omitted part in the manifest instead of certifying a measurement of a different circuit', async () => {
        const { svc } = makeService(okSim());
        const ev = await svc.verify(opampAmp(), { type: 'op' }, [A('out', 'final', 'approx', 5.0, 0.1)]);

        const entry = ev.scope.checks.find((c) => c.id === 'sim.coverage')!;
        expect(entry.status).toBe('run');
        expect(entry.detail).toContain('U1 (generic)');
        expect(entry.detail).toMatch(/do not describe the schematic as drawn/);

        // …and the structured fact, for anything that needs to branch rather than read.
        expect(ev.coverage!.complete).toBe(false);
        expect(ev.coverage!.loadBearing.map((o) => o.designator)).toEqual(['U1']);
    });

    it('a fully simulatable circuit says so — a silent field would make "complete" and "never looked" identical', async () => {
        const { svc } = makeService(okSim());
        const ev = await svc.verify(
            {
                version: '1.0',
                components: [
                    { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'vcc' }, { pinId: '-', netId: 'gnd' }] },
                    { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'gnd' }] },
                ],
                nets: [{ id: 'vcc', name: 'VCC' }, { id: 'gnd', name: 'GND' }],
            } as unknown as CircuitJson,
            { type: 'op' },
            [A('out', 'final', 'approx', 5.0, 0.1)],
        );

        const entry = ev.scope.checks.find((c) => c.id === 'sim.coverage')!;
        expect(entry.status).toBe('run');
        expect(entry.detail).toMatch(/every component with an electrical model was emitted/);
        expect(ev.coverage!.complete).toBe(true);
    });

    it('an UNVALIDATABLE circuit discloses not-run — never a coverage claim we could not make', async () => {
        const { svc } = makeService(okSim());
        const ev = await svc.verify({ nonsense: true }, { type: 'op' }, [A('out', 'final', 'approx', 5.0, 0.1)]);

        const entry = ev.scope.checks.find((c) => c.id === 'sim.coverage')!;
        expect(entry.status).toBe('not-run');
        expect(ev.coverage).toBeUndefined();
    });
});
