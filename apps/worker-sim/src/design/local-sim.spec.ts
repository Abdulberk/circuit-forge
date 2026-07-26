/**
 * makeLocalSim — the worker's in-process simulation surface for the design loop. These lock the CONTRACT the
 * loop depends on: createQuickSim runs ngspice once and stashes a terminal outcome; the first getStatus poll
 * returns it; getResult yields the queue-shaped payload. The mapping MUST match the 'simulations' queue
 * processor (status values + metrics.failureClass + the getResult {result, metrics, error} shape) so the loop
 * sees identical evidence in the API and the worker. The real runner is mocked — this is a pure shape test.
 */
import type { MonteCarloBatchResult } from '../simulation/montecarlo-runner';
import type { SimulationJobResult } from '../simulation/runner';

// config loads dotenv + validates env at import → stub the fields local-sim + the global pools read.
jest.mock('../config', () => ({ config: { WORKER_MAX_POINTS: 20000, CONCURRENCY: 2 } }));
// local-sim now transitively imports ./pools (global semaphores), which logs at init → stub the logger.
jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const runSimulation = jest.fn<Promise<SimulationJobResult>, [unknown]>();
const runMonteCarloBatch = jest.fn<Promise<MonteCarloBatchResult>, [unknown]>();
jest.mock('../simulation/runner', () => ({ runSimulation: (i: unknown) => runSimulation(i) }));
jest.mock('../simulation/montecarlo-runner', () => ({ runMonteCarloBatch: (i: unknown) => runMonteCarloBatch(i) }));

import { makeLocalSim } from './local-sim';

const okResult: SimulationJobResult = {
    success: true,
    result: {
        meta: { pointsCount: 3 },
        series: [
            {
                name: 'out',
                points: [
                    { x: 0, y: 1 },
                    { x: 1, y: 2 },
                    { x: 2, y: 3 },
                ],
            },
        ],
    } as unknown as SimulationJobResult['result'],
    stdout: '',
    stderr: '',
    runtimeMs: 12,
};

beforeEach(() => {
    runSimulation.mockReset();
    runMonteCarloBatch.mockReset();
});

describe('makeLocalSim.createQuickSim → getStatus/getResult', () => {
    it('SUCCEEDED: status carries pointsCount; getResult exposes {result.series, metrics.pointsCount}', async () => {
        runSimulation.mockResolvedValue(okResult);
        const sim = makeLocalSim('job-a');
        const { jobId } = await sim.createQuickSim('* deck\n.end', { type: 'tran' }, 'u1');

        const status = await sim.getStatus(jobId, 'u1');
        expect(status.status).toBe('SUCCEEDED');
        expect((status.metrics as { pointsCount?: number }).pointsCount).toBe(3);

        const res = (await sim.getResult(jobId, 'u1')) as {
            result?: { series?: unknown[]; meta?: { pointsCount?: number } };
            metrics?: { pointsCount?: number };
        };
        expect(res.result?.series).toHaveLength(1);
        expect(res.result?.meta?.pointsCount).toBe(3);
        expect(res.metrics?.pointsCount).toBe(3);
        // probeNames left empty → runner derives from the netlist (matches the API's createQuickSim).
        expect(runSimulation).toHaveBeenCalledWith(expect.objectContaining({ probeNames: [], analysisType: 'tran' }));
    });

    it('infra failure → FAILED + failureClass:"infra" (the loop reports inconclusive, never a design failure)', async () => {
        runSimulation.mockResolvedValue({
            success: false,
            stdout: '',
            stderr: '',
            runtimeMs: 5,
            infra: true,
            error: 'ngspice could not be launched',
        });
        const sim = makeLocalSim('job-a');
        const { jobId } = await sim.createQuickSim('* deck', {}, 'u1');
        const status = await sim.getStatus(jobId, 'u1');
        expect(status.status).toBe('FAILED');
        expect((status.metrics as { failureClass?: string }).failureClass).toBe('infra');
        expect(((await sim.getResult(jobId, 'u1')) as { error?: string }).error).toMatch(/launched/);
    });

    it('genuine ngspice fault → FAILED + failureClass:"sim" (drives the loop\'s AI-fix path)', async () => {
        runSimulation.mockResolvedValue({
            success: false,
            stdout: '',
            stderr: '',
            runtimeMs: 5,
            error: 'ngspice exited with code 1',
        });
        const sim = makeLocalSim('job-a');
        const { jobId } = await sim.createQuickSim('* deck', {}, 'u1');
        const status = await sim.getStatus(jobId, 'u1');
        expect(status.status).toBe('FAILED');
        expect((status.metrics as { failureClass?: string }).failureClass).toBe('sim');
    });

    it('wall-clock timeout → TIMED_OUT', async () => {
        runSimulation.mockResolvedValue({
            success: false,
            stdout: '',
            stderr: '',
            runtimeMs: 10000,
            timedOut: true,
            error: 'Simulation timed out',
        });
        const sim = makeLocalSim('job-a');
        const { jobId } = await sim.createQuickSim('* deck', { type: 'tran' }, 'u1');
        expect((await sim.getStatus(jobId, 'u1')).status).toBe('TIMED_OUT');
    });

    it('carries the convergence report through to status.metrics', async () => {
        runSimulation.mockResolvedValue({
            ...okResult,
            convergence: {
                recovered: true,
                kind: 'gmin_stepping',
                diagnosis: 'timestep too small',
                remedyApplied: 'gmin',
                attempts: 2,
            } as unknown as SimulationJobResult['convergence'],
        });
        const sim = makeLocalSim('job-a');
        const { jobId } = await sim.createQuickSim('* deck', { type: 'tran' }, 'u1');
        const m = (await sim.getStatus(jobId, 'u1')).metrics as { convergence?: { recovered?: boolean } };
        expect(m.convergence?.recovered).toBe(true);
    });
});

describe('makeLocalSim.createMonteCarloJob', () => {
    it('SUCCEEDED: status.metrics.monteCarlo carries yield + evaluated for the loop to attach', async () => {
        runMonteCarloBatch.mockResolvedValue({
            yield: 0.94,
            ci95: { low: 0.9, high: 0.97 },
            total: 300,
            evaluated: 300,
            passed: 282,
            failed: 18,
            errored: 0,
            ran: 300,
            stoppedEarly: false,
            budgetHit: false,
            runtimeMs: 5000,
        } as unknown as MonteCarloBatchResult);
        const sim = makeLocalSim('job-a');
        const { jobId } = await sim.createMonteCarloJob({} as never, { type: 'op' }, [], { n: 300 }, 'u1');
        const mc = (
            (await sim.getStatus(jobId, 'u1')).metrics as { monteCarlo?: { evaluated?: number; yield?: number } }
        ).monteCarlo;
        expect(mc?.evaluated).toBe(300);
        expect(mc?.yield).toBeCloseTo(0.94);
    });

    it('batch throw → FAILED + failureClass:"infra" (loop reports "yield unavailable")', async () => {
        runMonteCarloBatch.mockRejectedValue(new Error('redis gone'));
        const sim = makeLocalSim('job-a');
        const { jobId } = await sim.createMonteCarloJob({} as never, {}, [], {}, 'u1');
        const status = await sim.getStatus(jobId, 'u1');
        expect(status.status).toBe('FAILED');
        expect((status.metrics as { failureClass?: string }).failureClass).toBe('infra');
    });
});

/**
 * REGRESSION: two concurrent design jobs must never derive the same sim id.
 *
 * The id is not cosmetic — runner.ts turns it into the working DIRECTORY
 * (`path.join(SIM_TEMP_DIR, jobId)`) and removes that directory in a `finally`. Before the scope
 * parameter existed, the counter lived per makeLocalSim instance and processor.ts built one instance
 * PER JOB, so every job's first simulation landed on `local-1-sim`: with DESIGN_CONCURRENCY=2 (the
 * default) one job overwrote the other's deck and the first to finish deleted the other's live
 * directory. The observable damage is a verdict computed from a different design's circuit.
 */
describe('makeLocalSim — job scoping (temp-dir collision regression)', () => {
    it('two instances scoped by different job ids never produce the same sim id', async () => {
        runSimulation.mockResolvedValue(okResult);
        const a = makeLocalSim('job-a');
        const b = makeLocalSim('job-b');

        const ja = (await a.createQuickSim('* deck\n.end', { type: 'tran' }, 'u1')).jobId;
        const jb = (await b.createQuickSim('* deck\n.end', { type: 'tran' }, 'u1')).jobId;

        // The FIRST id from each instance is the collision case: both counters are at 1.
        expect(ja).not.toBe(jb);
        expect(ja).toContain('job-a');
        expect(jb).toContain('job-b');
    });

    it('the scoped id is what reaches the runner — it is the temp directory name', async () => {
        runSimulation.mockResolvedValue(okResult);
        const sim = makeLocalSim('job-c');
        await sim.createQuickSim('* deck\n.end', { type: 'tran' }, 'u1');

        expect(runSimulation).toHaveBeenCalledWith(
            expect.objectContaining({ jobId: expect.stringContaining('job-c') as unknown as string }),
        );
    });

    it('Monte-Carlo ids are scoped too (same directory derivation)', async () => {
        runMonteCarloBatch.mockResolvedValue({
            yield: 1,
            evaluated: 10,
            passed: 10,
            failed: 0,
            errored: 0,
            ran: 10,
            stoppedEarly: false,
            budgetHit: false,
            runtimeMs: 10,
        } as unknown as MonteCarloBatchResult);
        const a = makeLocalSim('job-d');
        const b = makeLocalSim('job-e');

        const ja = (await a.createMonteCarloJob({} as never, {}, [], {}, 'u1')).jobId;
        const jb = (await b.createMonteCarloJob({} as never, {}, [], {}, 'u1')).jobId;

        expect(ja).not.toBe(jb);
    });
});
