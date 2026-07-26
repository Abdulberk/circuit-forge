/**
 * simulateWithRemedies() orchestration — the Convergence Doctor's retry ladder. simulate() is spied
 * so the ladder logic is tested deterministically without ngspice.
 */
import type { ConfigService } from '@nestjs/config';

import { CircuitSimulatorService, type SimSummary } from './circuit-simulator.service';

const cfg = { get: (k: string) => (k === 'NGSPICE_PATH' ? '/fake/ngspice' : undefined) } as unknown as ConfigService;

const failed = (runError: string, analysisType = 'op'): SimSummary => ({
    simStatus: 'failed',
    ercErrors: [],
    ercWarnings: [],
    measurements: [],
    nodeCount: 0,
    analysisType,
    runError,
});
const ok = (): SimSummary => ({
    simStatus: 'ok',
    ercErrors: [],
    ercWarnings: [],
    measurements: [{ node: 'v(nout)', min: 0, max: 5, final: 5, pp: 5, avg: 5, rms: 5 }],
    nodeCount: 1,
    analysisType: 'op',
});

function svcWithSimulate(...returns: SimSummary[]) {
    const svc = new CircuitSimulatorService(cfg);
    const spy = jest.spyOn(svc, 'simulate');
    returns.forEach((r) => spy.mockResolvedValueOnce(r));
    return { svc, spy };
}

describe('CircuitSimulatorService.simulateWithRemedies (Convergence Doctor)', () => {
    it('passes a successful first run straight through (one simulate call, no convergence report)', async () => {
        const { svc, spy } = svcWithSimulate(ok());
        const r = await svc.simulateWithRemedies({}, { type: 'op' });
        expect(r.simStatus).toBe('ok');
        expect(r.convergence).toBeUndefined();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry a non-convergence failure (bad netlist) — remedies cannot help', async () => {
        const { svc, spy } = svcWithSimulate(failed('invalid circuit: components must be an array'));
        const r = await svc.simulateWithRemedies({}, { type: 'op' });
        expect(r.simStatus).toBe('failed');
        expect(r.convergence).toBeUndefined();
        expect(spy).toHaveBeenCalledTimes(1); // no remedy attempts
    });

    it('recovers a convergence failure with the first remedy and reports what fixed it', async () => {
        const { svc, spy } = svcWithSimulate(failed('singular matrix'), ok());
        const r = await svc.simulateWithRemedies({}, { type: 'op' });
        expect(r.simStatus).toBe('ok');
        expect(r.convergence).toMatchObject({ recovered: true, kind: 'singular_matrix', attempts: 1 });
        expect(r.convergence!.remedyApplied).toMatch(/gmin/i);
        expect(spy).toHaveBeenCalledTimes(2); // base + 1 remedy
        // the remedy's options were merged into the analysis handed to the retry
        const retryAnalysis = spy.mock.calls[1]![1] as { options?: Record<string, unknown> };
        expect(retryAnalysis.options).toMatchObject({ gmin: expect.any(String) });
    });

    it('walks the full ladder and reports unrecovered + every remedy tried when none converge', async () => {
        // op ladder has 3 steps → base + 3 retries, all failing
        const { svc, spy } = svcWithSimulate(failed('no convergence'), failed('no convergence'), failed('no convergence'), failed('no convergence'));
        const r = await svc.simulateWithRemedies({}, { type: 'op' });
        expect(r.simStatus).toBe('failed');
        expect(r.convergence).toMatchObject({ recovered: false, kind: 'no_convergence' });
        expect(r.convergence!.triedRemedies!.length).toBe(3);
        expect(spy).toHaveBeenCalledTimes(4);
    });

    it('merges remedies OVER the caller’s existing solver options (caller intent preserved where not overridden)', async () => {
        const { svc, spy } = svcWithSimulate(failed('Timestep too small', 'tran'), ok());
        await svc.simulateWithRemedies({}, { type: 'tran', stopTime: '5m', stepTime: '10u', options: { abstol: '1e-7' } } as never);
        const retryAnalysis = spy.mock.calls[1]![1] as { stopTime?: string; options?: Record<string, unknown> };
        expect(retryAnalysis.stopTime).toBe('5m'); // base analysis preserved
        expect(retryAnalysis.options).toMatchObject({ abstol: '1e-7', itl4: 500 }); // caller's abstol kept + remedy added
    });

    it('stops the ladder (does not block on every remedy) when a retry is skipped for capacity', async () => {
        // base fails convergence, first remedy retry comes back 'skipped' (host saturated)
        const { svc, spy } = svcWithSimulate(failed('no convergence'), { simStatus: 'skipped', ercErrors: [], ercWarnings: [], measurements: [], nodeCount: 0 });
        const r = await svc.simulateWithRemedies({}, { type: 'op' });
        expect(r.simStatus).toBe('failed');
        expect(r.convergence).toMatchObject({ recovered: false, attempts: 0 });
        expect(r.convergence!.triedRemedies).toEqual([]); // the skipped remedy is NOT counted as tried
        expect(r.convergence!.note).toMatch(/saturated/i);
        expect(spy).toHaveBeenCalledTimes(2); // base + the one skipped retry — did NOT walk the rest
    });

    it('skipped runs (ngspice off) pass through untouched', async () => {
        const { svc, spy } = svcWithSimulate({ simStatus: 'skipped', ercErrors: [], ercWarnings: [], measurements: [], nodeCount: 0 });
        const r = await svc.simulateWithRemedies({}, { type: 'op' });
        expect(r.simStatus).toBe('skipped');
        expect(spy).toHaveBeenCalledTimes(1);
    });
});
