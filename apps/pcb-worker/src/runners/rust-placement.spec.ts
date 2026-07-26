import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { PlacementInput, PlacementOutput } from '@circuit-forge/pcb-core';

import { makeRustPlacementRunner } from './rust-placement';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));

const execFileMock = execFile as unknown as jest.Mock;

const input: PlacementInput = {
    parts: [
        { id: 'R1', w: 2, h: 1, role: 'part', pads: [{ x: 0, y: 0, net: 'N1' }] },
        { id: 'U1', w: 4, h: 4, role: 'part', pads: [{ x: 1, y: 0, net: 'N1' }] },
    ],
    netWeights: { N1: 1 },
    boardW: 40,
    boardH: 30,
    gridMm: 0.5,
    marginMm: 4,
};

const output: PlacementOutput = {
    positions: {
        R1: { x: -2, y: 0, rotation: 0 },
        U1: { x: 2, y: 0, rotation: 90 },
    },
    boardW: 30,
    boardH: 20,
    hpwl: 4,
    notes: ['rust test'],
    ok: true,
};

describe('makeRustPlacementRunner', () => {
    let workDir: string;
    const oldEnv = process.env.RUST_PLACER_PATH;

    beforeEach(() => {
        jest.clearAllMocks();
        workDir = mkdtempSync(join(tmpdir(), 'rust-place-spec-'));
        delete process.env.RUST_PLACER_PATH;
    });

    afterEach(() => {
        rmSync(workDir, { recursive: true, force: true });
        if (oldEnv === undefined) delete process.env.RUST_PLACER_PATH;
        else process.env.RUST_PLACER_PATH = oldEnv;
    });

    it('uses positional JSON files, returns the validated result, and cleans up', async () => {
        let callDir = '';
        execFileMock.mockImplementation(
            (
                binary: string,
                args: string[],
                options: Record<string, unknown>,
                callback: (error: Error | null, stdout?: string, stderr?: string) => void,
            ) => {
                expect(binary).toBe('placer-for-test');
                expect(args).toHaveLength(2);
                expect(options).toMatchObject({ timeout: 1_234, maxBuffer: 8_192, windowsHide: true });
                expect(JSON.parse(readFileSync(args[0]!, 'utf8'))).toEqual(input);
                callDir = dirname(args[0]!);
                expect(dirname(args[1]!)).toBe(callDir);
                writeFileSync(args[1]!, JSON.stringify(output));
                callback(null, '', '');
            },
        );

        const run = makeRustPlacementRunner({
            binary: 'placer-for-test',
            timeoutMs: 1_234,
            maxBuffer: 8_192,
            workDir,
        });
        await expect(run(input)).resolves.toEqual(output);
        expect(execFileMock).toHaveBeenCalledTimes(1);
        expect(existsSync(callDir)).toBe(false);
    });

    it('resolves RUST_PLACER_PATH when no explicit binary is supplied', async () => {
        process.env.RUST_PLACER_PATH = 'placer-from-env';
        execFileMock.mockImplementation(
            (
                binary: string,
                args: string[],
                _options: Record<string, unknown>,
                callback: (error: Error | null, stdout?: string, stderr?: string) => void,
            ) => {
                expect(binary).toBe('placer-from-env');
                writeFileSync(args[1]!, JSON.stringify(output));
                callback(null, '', '');
            },
        );

        await makeRustPlacementRunner({ workDir })(input);
        expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it('surfaces a non-zero exit with bounded stderr and still cleans up', async () => {
        let callDir = '';
        execFileMock.mockImplementation(
            (
                _binary: string,
                args: string[],
                _options: Record<string, unknown>,
                callback: (error: Error | null) => void,
            ) => {
                callDir = dirname(args[0]!);
                callback(
                    Object.assign(new Error('command failed'), {
                        code: 7,
                        stderr: 'invalid placement graph',
                    }),
                );
            },
        );

        const run = makeRustPlacementRunner({ binary: 'bad-placer', workDir });
        await expect(run(input)).rejects.toThrow('Rust placement binary failed (exit 7): invalid placement graph');
        expect(existsSync(callDir)).toBe(false);
    });

    it('reports timeout and missing-output failures explicitly', async () => {
        execFileMock.mockImplementationOnce(
            (
                _binary: string,
                _args: string[],
                _options: Record<string, unknown>,
                callback: (error: Error | null) => void,
            ) => {
                callback(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }));
            },
        );
        await expect(makeRustPlacementRunner({ workDir, timeoutMs: 25 })(input)).rejects.toThrow(
            'Rust placement binary timed out after 25ms (signal SIGTERM)',
        );

        execFileMock.mockImplementationOnce(
            (
                _binary: string,
                _args: string[],
                _options: Record<string, unknown>,
                callback: (error: Error | null, stdout?: string, stderr?: string) => void,
            ) => {
                callback(null, '', '');
            },
        );
        await expect(makeRustPlacementRunner({ workDir })(input)).rejects.toThrow('did not create output.json');
    });

    it('rejects malformed or incomplete native output at the process boundary', async () => {
        execFileMock.mockImplementation(
            (
                _binary: string,
                args: string[],
                _options: Record<string, unknown>,
                callback: (error: Error | null, stdout?: string, stderr?: string) => void,
            ) => {
                writeFileSync(args[1]!, JSON.stringify({ ...output, positions: { R1: output.positions.R1 } }));
                callback(null, '', '');
            },
        );

        await expect(makeRustPlacementRunner({ workDir })(input)).rejects.toThrow('missing part id "U1"');
    });
});
