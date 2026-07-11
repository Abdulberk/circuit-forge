/**
 * makeVariantRunner — the shared per-variant ngspice path used by the Monte-Carlo, sweep AND corner batches.
 * These lock the decision logic that turns one variant into `measurements | null`, because a bug here silently
 * corrupts the yield/passAll number the robustness feature reports: an errored variant misread as a spec
 * pass/fail, or a stale CSV read as the current variant's result. ngspice + eda-core are mocked — this is a pure
 * control-flow test of the runner's OWN branching (stale-CSV clear, the six null/errored exits, THD/gain fold).
 */
import type { SimMeasurement } from '@circuit-forge/eda-core';

// config validates env at import → stub only the field the runner reads.
jest.mock('../config', () => ({ config: { SIM_MAX_OUTPUT_BYTES: 1000 } }));

// The real ngspice spawn — mocked so no child process runs; the runner just sees the outcome object.
jest.mock('./runner', () => ({ executeNgspice: jest.fn() }));

// eda-core is pure but mocked here so this test isolates variant-runner's branching from the parsers
// (which have their own 100%-covered suites). Each function is a controllable jest.fn.
jest.mock('@circuit-forge/eda-core', () => ({
    generateNetlist: jest.fn(),
    sanitizeNetlist: jest.fn(),
    extractProbes: jest.fn(),
    parseSimulationOutput: jest.fn(),
    parseFourierLog: jest.fn(),
    attachFourierThd: jest.fn(),
    parseTransferFunction: jest.fn(),
    attachTransferFunction: jest.fn(),
    summarizeSeries: jest.fn(),
    parseSpiceValue: jest.fn(),
    assessTransientCompleteness: jest.fn(),
}));

import * as fs from 'fs/promises';
import * as path from 'path';
import * as eda from '@circuit-forge/eda-core';
import { executeNgspice } from './runner';
import { makeVariantRunner } from './variant-runner';

jest.mock('fs/promises', () => ({ rm: jest.fn(), writeFile: jest.fn(), readFile: jest.fn() }));

const mock = <T extends (...a: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;
const JOB = path.join('sim-work', 'job');
const jp = (name: string) => path.join(JOB, name);
const OK = { stdout: '', stderr: '', exitCode: 0, timedOut: false, spawnError: false as boolean | undefined };
const variant = { version: '1.0', components: [], nets: [] } as unknown as Parameters<ReturnType<typeof makeVariantRunner>>[0];

beforeEach(() => {
    jest.clearAllMocks();
    mock(eda.generateNetlist).mockReturnValue('RAW');
    mock(eda.sanitizeNetlist).mockReturnValue('SANITIZED');
    mock(eda.extractProbes).mockReturnValue(['v(out)']);
    mock(eda.parseSimulationOutput).mockReturnValue({ series: [{ name: 'out', points: [{ x: 0, y: 1 }] }], meta: {} });
    mock(eda.summarizeSeries).mockImplementation((s: { name: string }) => ({ node: s.name, max: 1 } as unknown as SimMeasurement));
    mock(eda.parseFourierLog).mockReturnValue([{ probe: 'v(out)', thd: 1.5 }]);
    mock(eda.parseTransferFunction).mockReturnValue({ outputNode: 'out', gain: 10 });
    mock(eda.parseSpiceValue).mockReturnValue({ value: 0.01, isValid: true });
    mock(eda.assessTransientCompleteness).mockReturnValue({ endedEarly: false, lastTime: 0.01 }); // complete by default
    mock(executeNgspice).mockResolvedValue(OK);
    mock(fs.rm).mockResolvedValue(undefined);
    mock(fs.writeFile).mockResolvedValue(undefined);
    mock(fs.readFile).mockImplementation((p: string) =>
        Promise.resolve(String(p).endsWith('stdout.log') ? 'LISTING' : 'csvdata'),
    );
});

describe('makeVariantRunner — happy path', () => {
    it('returns per-node scalar measurements and clears stale artifacts BEFORE writing the deck', async () => {
        const run = makeVariantRunner(JOB, { type: 'tran' } as never);
        const out = await run(variant);

        expect(out).toEqual([{ node: 'out', max: 1 }]);
        // STALE-CSV SAFETY: both prior artifacts removed with force, and before the netlist write.
        expect(fs.rm).toHaveBeenCalledWith(jp('output.csv'), { force: true });
        expect(fs.rm).toHaveBeenCalledWith(jp('stdout.log'), { force: true });
        expect(mock(fs.rm).mock.invocationCallOrder[0]).toBeLessThan(mock(fs.writeFile).mock.invocationCallOrder[0]!);
        expect(fs.writeFile).toHaveBeenCalledWith(jp('circuit.cir'), 'SANITIZED');
        expect(executeNgspice).toHaveBeenCalledWith(jp('circuit.cir'));
        expect(eda.parseSimulationOutput).toHaveBeenCalledWith('csvdata', ['v(out)'], 'tran');
        // No fourier/tf requested → no listing read, no fold.
        expect(eda.attachFourierThd).not.toHaveBeenCalled();
        expect(eda.attachTransferFunction).not.toHaveBeenCalled();
    });
});

describe('makeVariantRunner — every unrunnable variant returns null (= errored, never a spec pass/fail)', () => {
    it('sanitize/generate throws → null, and ngspice is never spawned', async () => {
        mock(eda.sanitizeNetlist).mockImplementationOnce(() => { throw new Error('bad deck'); });
        const run = makeVariantRunner(JOB, { type: 'op' } as never);
        expect(await run(variant)).toBeNull();
        expect(executeNgspice).not.toHaveBeenCalled();
    });

    it.each([
        ['spawn error', { ...OK, spawnError: true }],
        ['timed out', { ...OK, timedOut: true }],
        ['non-zero exit', { ...OK, exitCode: 1 }],
    ])('%s → null', async (_label, outcome) => {
        mock(executeNgspice).mockResolvedValueOnce(outcome);
        const run = makeVariantRunner(JOB, { type: 'op' } as never);
        expect(await run(variant)).toBeNull();
        expect(eda.parseSimulationOutput).not.toHaveBeenCalled();
    });

    it('ngspice exits 0 but writes no output.csv → null', async () => {
        mock(fs.readFile).mockRejectedValueOnce(new Error('ENOENT'));
        const run = makeVariantRunner(JOB, { type: 'op' } as never);
        expect(await run(variant)).toBeNull();
    });

    it('oversize output.csv (> SIM_MAX_OUTPUT_BYTES) → null', async () => {
        mock(fs.readFile).mockResolvedValueOnce('x'.repeat(2000)); // > 1000 byte cap
        const run = makeVariantRunner(JOB, { type: 'op' } as never);
        expect(await run(variant)).toBeNull();
    });
});

describe('makeVariantRunner — criterion probes (branch currents) unioned into EVERY variant', () => {
    it('passes extraProbes to generateNetlist so a current criterion is saved per variant (not "probe not found")', async () => {
        const run = makeVariantRunner(JOB, { type: 'op' } as never, ['i(R1)']);
        await run(variant);
        // WITHOUT this, the voltage-only default sweep never saves @r1[i] and every variant fails → yield ~0.
        expect(eda.generateNetlist).toHaveBeenCalledWith(variant, { type: 'op' }, { extraProbes: ['i(R1)'] });
    });

    it('passes {} (no extraProbes) when none are derived — the default voltage sweep is unchanged', async () => {
        const run = makeVariantRunner(JOB, { type: 'op' } as never, []);
        await run(variant);
        expect(eda.generateNetlist).toHaveBeenCalledWith(variant, { type: 'op' }, {});
    });

    it('omitting the arg entirely also passes {} (back-compat with a probe-less caller)', async () => {
        const run = makeVariantRunner(JOB, { type: 'op' } as never);
        await run(variant);
        expect(eda.generateNetlist).toHaveBeenCalledWith(variant, { type: 'op' }, {});
    });
});

describe('makeVariantRunner — a silently-truncated transient variant is ERRORED, never measured (debt #3)', () => {
    it('tran variant whose run ended early → null (excluded from the denominator), not a clipped measurement', async () => {
        mock(eda.assessTransientCompleteness).mockReturnValueOnce({ endedEarly: true, lastTime: 1e-3 });
        const run = makeVariantRunner(JOB, { type: 'tran', stopTime: '10m' } as never);
        expect(await run(variant)).toBeNull();
        // The completeness rule is consulted with the parsed stopTime, and we bail BEFORE reducing to measurements.
        expect(eda.assessTransientCompleteness).toHaveBeenCalledWith(
            [{ name: 'out', points: [{ x: 0, y: 1 }] }],
            0.01,
        );
        expect(eda.summarizeSeries).not.toHaveBeenCalled();
    });

    it('a COMPLETE tran variant proceeds to measurements (guard consulted, passes)', async () => {
        const run = makeVariantRunner(JOB, { type: 'tran', stopTime: '10m' } as never);
        expect(await run(variant)).toEqual([{ node: 'out', max: 1 }]);
        expect(eda.assessTransientCompleteness).toHaveBeenCalled();
    });

    it('a NON-tran analysis (op) never consults the transient guard', async () => {
        const run = makeVariantRunner(JOB, { type: 'op' } as never);
        await run(variant);
        expect(eda.assessTransientCompleteness).not.toHaveBeenCalled();
    });
});

describe('makeVariantRunner — robust scalar metrics folded PER VARIANT from the listing', () => {
    it('tran + fourier → reads the listing and folds THD onto the measurements', async () => {
        const run = makeVariantRunner(JOB, { type: 'tran', fourier: { probe: 'out' } } as never);
        await run(variant);
        expect(fs.readFile).toHaveBeenCalledWith(jp('stdout.log'), 'utf-8');
        expect(eda.parseFourierLog).toHaveBeenCalledWith('LISTING');
        expect(eda.attachFourierThd).toHaveBeenCalledWith([{ node: 'out', max: 1 }], [{ probe: 'v(out)', thd: 1.5 }]);
        expect(eda.attachTransferFunction).not.toHaveBeenCalled();
    });

    it('op + tf → reads the listing and folds the small-signal gain onto the measurements', async () => {
        const run = makeVariantRunner(JOB, { type: 'op', tf: { output: 'out' } } as never);
        await run(variant);
        expect(eda.parseTransferFunction).toHaveBeenCalledWith('LISTING', 'out');
        expect(eda.attachTransferFunction).toHaveBeenCalledWith([{ node: 'out', max: 1 }], { outputNode: 'out', gain: 10 });
        expect(eda.attachFourierThd).not.toHaveBeenCalled();
    });
});
