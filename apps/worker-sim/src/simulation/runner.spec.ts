/**
 * runSimulation / runOneAttempt decision logic — the largest un-covered correctness surface in the worker.
 * A bug in any of these branches persists a WRONG or misleading result (a truncated transient sold as complete,
 * an infra outage reported as a design failure, a shifted series from a dropped probe). executeNgspice lives in
 * this same module so it can't be mocked for internal callers — instead child_process.spawn is faked (a fake
 * child that emits scripted stdout/exit) and fs is mocked, so this drives the REAL runOneAttempt/runSimulation
 * control flow deterministically. eda-core parsers are stubbed (their own suites cover them); the convergence
 * DIAGNOSIS + remedy ladder + solver-option injection are kept REAL so the ladder walk is exercised truthfully.
 */
import { EventEmitter } from 'events';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('fs/promises', () => ({ mkdir: jest.fn(), writeFile: jest.fn(), readFile: jest.fn(), rm: jest.fn(), chmod: jest.fn() }));
jest.mock('../config', () => ({
    config: { SIM_TEMP_DIR: 'sim-tmp', SIM_MAX_OUTPUT_BYTES: 1000, SIM_TIMEOUT_MS: 100000, NGSPICE_PATH: 'ngspice', SIM_SANDBOX: 'none' },
}));
jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// Sandbox wrapping is Linux-only plumbing — run ngspice "directly" so the fake spawn sees the plain command.
jest.mock('./sandbox', () => ({
    resolveSandboxConfig: () => ({ mode: 'none' }),
    sandboxedCommand: (file: string, args: string[]) => ({ file, args }),
}));
// Stub only the parsers we want to control; keep diagnoseConvergence / convergenceRemedyLadder / applySolverOptions
// / parseSpiceValue REAL so the ladder + the .tran-stopTime read behave exactly as in production.
jest.mock('@circuit-forge/eda-core', () => {
    const actual = jest.requireActual('@circuit-forge/eda-core');
    return {
        ...actual,
        sanitizeNetlist: jest.fn((n: string) => n),
        parseSimulationOutput: jest.fn(),
        extractProbes: jest.fn(() => []),
        parseNoise: jest.fn(() => ({ series: [], totals: {} })),
        parseSensitivity: jest.fn(() => ({})),
    };
});

import { spawn } from 'child_process';
import * as fs from 'fs/promises';

import * as eda from '@circuit-forge/eda-core';

import { runSimulation } from './runner';

const mock = <T extends (...a: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;

type Outcome = { stdout?: string; stderr?: string; code?: number; error?: boolean };
let outcomes: Outcome[] = []; // one per spawn call; the last is reused if more spawns happen (ladder retries)
let csv: string | Error = 'CSVDATA'; // what reading output.csv yields (an Error → rejected read = "no output")
let listing = ''; // what reading stdout.log yields

const series = (lastX: number) => ({ meta: { analysisType: 'x', pointsCount: 1 }, series: [{ name: 'out', points: [{ x: lastX, y: 1 }] }] });
const mkInput = (over: Record<string, unknown> = {}) => ({ jobId: 'j1', netlist: '* deck\n.end', probeNames: ['v(out)'], analysisType: 'op', ...over });

beforeEach(() => {
    jest.clearAllMocks();
    outcomes = [];
    csv = 'CSVDATA';
    listing = '';
    mock(eda.parseSimulationOutput).mockReturnValue(series(0));
    mock(eda.extractProbes).mockReturnValue([]);
    mock(fs.mkdir).mockResolvedValue(undefined);
    mock(fs.writeFile).mockResolvedValue(undefined);
    mock(fs.rm).mockResolvedValue(undefined);
    mock(fs.readFile).mockImplementation((p: string) =>
        String(p).endsWith('output.csv')
            ? (csv instanceof Error ? Promise.reject(csv) : Promise.resolve(csv))
            : Promise.resolve(listing),
    );
    mock(spawn).mockImplementation(() => {
        const o = outcomes.length > 1 ? outcomes.shift()! : (outcomes[0] ?? { code: 0 });
        const child = new EventEmitter() as unknown as { stdout: EventEmitter; stderr: EventEmitter; pid: number; kill: jest.Mock } & EventEmitter;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 111;
        child.kill = jest.fn();
        process.nextTick(() => {
            if (o.stdout) child.stdout.emit('data', Buffer.from(o.stdout));
            if (o.stderr) child.stderr.emit('data', Buffer.from(o.stderr));
            if (o.error) (child as EventEmitter).emit('error', new Error('spawn ENOENT'));
            else (child as EventEmitter).emit('close', o.code ?? 0);
        });
        return child;
    });
});

describe('runSimulation — terminal outcomes of a single attempt', () => {
    it('happy path: exit 0 + output.csv present → success with a parsed result; job dir made and cleaned', async () => {
        const r = await runSimulation(mkInput());
        expect(r.success).toBe(true);
        expect(r.result?.series).toHaveLength(1);
        expect(fs.mkdir).toHaveBeenCalled();
        expect(fs.rm).toHaveBeenCalled(); // finally-block cleanup
    });

    it('ngspice exits non-zero (non-convergence) → failure, NOT infra', async () => {
        outcomes = [{ code: 1, stderr: 'ngspice: syntax error near token' }];
        const r = await runSimulation(mkInput());
        expect(r.success).toBe(false);
        expect(r.infra).toBeFalsy();
        expect(r.error).toMatch(/exited with code 1/);
    });

    it('spawn error (ngspice never launched) → failure flagged infra:true (API → inconclusive, not a design fail)', async () => {
        outcomes = [{ error: true }];
        const r = await runSimulation(mkInput());
        expect(r.success).toBe(false);
        expect(r.infra).toBe(true);
        expect(r.error).toMatch(/could not be launched/i);
    });

    it('exit 0 but no output.csv → failure phrased as no-output (remediable)', async () => {
        csv = new Error('ENOENT');
        const r = await runSimulation(mkInput());
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/no output file/i);
    });

    it('oversize output.csv → failure "Output too large"', async () => {
        csv = 'x'.repeat(2000); // > SIM_MAX_OUTPUT_BYTES (1000)
        const r = await runSimulation(mkInput());
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/too large/i);
        expect(r.outputSizeBytes).toBe(2000);
    });

    it('sens analysis: no output.csv is EXPECTED — reads the listing and succeeds with an empty series', async () => {
        listing = 'sensitivity table…';
        const r = await runSimulation(mkInput({ analysisType: 'sens' }));
        expect(r.success).toBe(true);
        expect(r.result?.series).toEqual([]);
        expect(eda.parseSensitivity).toHaveBeenCalled();
    });
});

describe('runSimulation — silent transient-truncation guard (.tran that stops early is a failure, not a partial)', () => {
    it('fails when the run ends before 0.9× the requested stopTime', async () => {
        mock(eda.parseSimulationOutput).mockReturnValue(series(0.001)); // ended at 1ms of a 5ms request
        const r = await runSimulation(mkInput({ analysisType: 'tran', netlist: '* d\n.tran 1u 5m\n.end' }));
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/ended early/i);
    });

    it('succeeds when the run reaches ≥ 0.9× the requested stopTime (threshold sanity)', async () => {
        mock(eda.parseSimulationOutput).mockReturnValue(series(0.005)); // reached the full 5ms
        const r = await runSimulation(mkInput({ analysisType: 'tran', netlist: '* d\n.tran 1u 5m\n.end' }));
        expect(r.success).toBe(true);
    });
});

describe('runOneAttempt — probe-count-mismatch fallback (a dropped probe must not shift every series)', () => {
    it('when the emitted wrdata columns differ in count from the caller list, parse against the EMITTED probes', async () => {
        mock(eda.extractProbes).mockReturnValue(['v(a)', 'v(b)']); // 2 emitted vs 1 requested → count mismatch
        await runSimulation(mkInput({ probeNames: ['v(out)'] }));
        expect(eda.parseSimulationOutput).toHaveBeenCalledWith('CSVDATA', ['v(a)', 'v(b)'], 'op');
    });
});

describe('runSimulation — Convergence Doctor walks the remedy ladder', () => {
    it('a convergence-class first failure that a remedy fixes → success + convergence.recovered:true', async () => {
        // First spawn: convergence failure; second (a remedy re-run): clean exit → recovered.
        outcomes = [{ code: 1, stderr: 'Timestep too small; trouble with node' }, { code: 0 }];
        mock(eda.parseSimulationOutput).mockReturnValue(series(0)); // want=0 for this deck → truncation guard skipped
        const r = await runSimulation(mkInput({ analysisType: 'tran' }));
        expect(r.success).toBe(true);
        expect(r.convergence?.recovered).toBe(true);
        expect(spawn).toHaveBeenCalledTimes(2); // original + one remedy
    });
});
