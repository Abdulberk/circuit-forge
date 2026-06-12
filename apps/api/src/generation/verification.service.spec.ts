/**
 * VerificationService — assertion evaluation + verdict logic. CircuitSimulatorService is stubbed so
 * the suite is deterministic and ngspice-free; the assertion math and verdict rules are the contract.
 */
import { VerificationService, isCurrentProbe } from './verification.service';
import type { CircuitSimulatorService, SimSummary } from './circuit-simulator.service';
import type { AssertionDto } from './dto';

const okSim = (over: Partial<SimSummary> = {}): SimSummary => ({
    simStatus: 'ok',
    ercErrors: [],
    ercWarnings: [],
    measurements: [
        { node: 'v(out)', min: 0, max: 5.02, final: 4.98, pp: 5.02 },
        { node: 'v(ripple)', min: 4.9, max: 4.96, final: 4.93, pp: 0.06 },
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

    it('passes the analysis config through to the simulator', async () => {
        const { svc, simulate } = makeService(okSim());
        const analysis = { type: 'tran', stopTime: '5m', timeStep: '10u' } as never;
        await svc.verify({ foo: 1 }, analysis, []);
        expect(simulate).toHaveBeenCalledWith({ foo: 1 }, analysis);
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
