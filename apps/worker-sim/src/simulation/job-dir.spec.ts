/**
 * withVariantJobDir — the job-dir lifecycle shared by the MC / sweep / corner batches (extracted from the three
 * runners so the sandbox-perms invariant lives in ONE place). Locks: the dir is created under SIM_TEMP_DIR with
 * the batch suffix, perms are loosened ONLY in legacy two-user mode, shared model files are written once, and the
 * dir is torn down in a `finally` even when the body throws. fs + variant-runner are mocked (pure lifecycle test).
 */
jest.mock('../config', () => ({ config: { SIM_TEMP_DIR: 'sim-tmp', SIM_SANDBOX_USER: undefined as string | undefined } }));
jest.mock('fs/promises', () => ({ mkdir: jest.fn(), chmod: jest.fn(), writeFile: jest.fn(), rm: jest.fn() }));
const fakeRunner = jest.fn();
jest.mock('./variant-runner', () => ({ makeVariantRunner: jest.fn(() => fakeRunner) }));

import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from '../config';
import { makeVariantRunner } from './variant-runner';
import { withVariantJobDir } from './job-dir';

const mock = <T extends (...a: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;
const analysis = { type: 'op' } as never;
const dir = (name: string) => path.join('sim-tmp', name);

beforeEach(() => {
    jest.clearAllMocks();
    (config as { SIM_SANDBOX_USER?: string }).SIM_SANDBOX_USER = undefined;
    mock(fs.mkdir).mockResolvedValue(undefined);
    mock(fs.chmod).mockResolvedValue(undefined);
    mock(fs.writeFile).mockResolvedValue(undefined);
    mock(fs.rm).mockResolvedValue(undefined);
});

it('prepares the reused dir + a bound runner, runs the body, and cleans up — no chmod in single-uid mode', async () => {
    const out = await withVariantJobDir('j1', 'mc', analysis, undefined, undefined, async (rv, jobDir) => {
        expect(rv).toBe(fakeRunner);
        expect(jobDir).toBe(dir('j1-mc'));
        return 'RESULT';
    });
    expect(out).toBe('RESULT');
    expect(fs.mkdir).toHaveBeenCalledWith(dir('j1-mc'), { recursive: true });
    expect(makeVariantRunner).toHaveBeenCalledWith(dir('j1-mc'), analysis, undefined);
    expect(fs.rm).toHaveBeenCalledWith(dir('j1-mc'), { recursive: true, force: true });
    expect(fs.chmod).not.toHaveBeenCalled();
});

it('forwards the criterion-derived extraProbes to the per-variant runner (branch-current criteria)', async () => {
    await withVariantJobDir('j5', 'corner', analysis, ['i(R1)'], undefined, async () => 0);
    // The runner must receive them so generateNetlist saves @r1[i] for every variant — see variant-runner.ts.
    expect(makeVariantRunner).toHaveBeenCalledWith(dir('j5-corner'), analysis, ['i(R1)']);
});

it('legacy two-user mode (SIM_SANDBOX_USER set) loosens the dir perms so the dropped ngspice user can write', async () => {
    (config as { SIM_SANDBOX_USER?: string }).SIM_SANDBOX_USER = 'ngspice';
    await withVariantJobDir('j2', 'sweep', analysis, undefined, undefined, async () => 0);
    expect(fs.chmod).toHaveBeenCalledWith(dir('j2-sweep'), 0o777);
});

it('writes each shared model file once into the job dir', async () => {
    const models = [
        { name: 'diode.lib', content: Buffer.from('d') },
        { name: 'npn.lib', content: Buffer.from('q') },
    ];
    await withVariantJobDir('j3', 'corner', analysis, undefined, models, async () => 0);
    expect(fs.writeFile).toHaveBeenCalledWith(path.join(dir('j3-corner'), 'diode.lib'), models[0]!.content);
    expect(fs.writeFile).toHaveBeenCalledWith(path.join(dir('j3-corner'), 'npn.lib'), models[1]!.content);
});

it('tears the dir down even when the body throws (guaranteed cleanup)', async () => {
    await expect(
        withVariantJobDir('j4', 'mc', analysis, undefined, undefined, async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    expect(fs.rm).toHaveBeenCalledWith(dir('j4-mc'), { recursive: true, force: true });
});
