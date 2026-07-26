/**
 * Native kicad-cli runner (TS port of scripts/lib/kicad-native.mjs — proven in M2/M3a). Provides the
 * four things the LayoutJob needs: notaryDrc (bool accept-oracle for the margin-retry), drcReport
 * (parsed, for airwires + categorized checks), exportGlb (3D bodies via --subst-models) and exportGerbers
 * (the DELIVERED fab gerbers, exported from the DRC-verified board with the GND pour refilled in).
 */
import { execFile } from 'node:child_process';
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { GerberOutputs } from '@circuit-forge/pcb-core';

const execFileAsync = promisify(execFile);
/** kicad-cli progress/warnings go to stdout/stderr which we never read (results are files); a chatty run can
 *  exceed execFile's 1 MiB default and die with ENOBUFS, so budget generously. */
const MAX_BUFFER = 64 * 1024 * 1024;

export interface KicadOpts {
    cli?: string;
    timeoutMs?: number;
    workDir?: string;
    keep?: boolean;
    /** Optional logger — used only to note when drcReport is served from the notary memo (ops visibility). */
    log?: { info: (obj: unknown, msg?: string) => void };
}

/** Shape of kicad-cli's DRC json, parsed by pcb-core's parseDrcReport. */
export interface KicadDrcJson {
    violations?: unknown[];
    unconnected_items?: unknown[];
    [k: string]: unknown;
}

export interface NativeKicad {
    notaryDrc: (kicadPcb: string, kicadPro?: string) => Promise<boolean>;
    drcReport: (kicadPcb: string, kicadPro?: string) => Promise<KicadDrcJson>;
    exportGlb: (kicadPcb: string) => Promise<Buffer>;
    exportGerbers: (kicadPcb: string) => Promise<GerberOutputs>;
}

export function makeNativeKicad(opts: KicadOpts = {}): NativeKicad {
    const cli = opts.cli ?? process.env.KICAD_CLI ?? 'kicad-cli';
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const baseDir = opts.workDir ?? tmpdir();

    // kicad DRC is deterministic per (board, project). notaryDrc already runs a FULL kicad-cli DRC and writes
    // the report; memoize it so drcReport on the SAME board — the happy path, where routeBestMargin accepts a
    // board via notaryDrc and the processor then reports on that byte-identical board — reuses it instead of
    // spawning a second, identical kicad-cli DRC. A miss (different board) just re-runs: always correct.
    let lastDrc: { board: string; pro: string | undefined; report: KicadDrcJson } | null = null;

    // async + `await fn(dir)` is load-bearing: without the await the finally would rmSync the temp dir while
    // kicad-cli is still writing into it (the child now runs off-thread via execFileAsync).
    const withBoard = async <T>(
        kicadPcb: string,
        kicadPro: string | undefined,
        fn: (dir: string) => Promise<T>,
    ): Promise<T> => {
        const dir = mkdtempSync(join(baseDir, 'kc-'));
        try {
            writeFileSync(join(dir, 'b.kicad_pcb'), kicadPcb);
            if (kicadPro) writeFileSync(join(dir, 'b.kicad_pro'), kicadPro);
            return await fn(dir);
        } finally {
            if (!opts.keep) rmSync(dir, { recursive: true, force: true });
        }
    };

    const notaryDrc = async (kicadPcb: string, kicadPro?: string): Promise<boolean> =>
        withBoard(kicadPcb, kicadPro, async (dir) => {
            const out = join(dir, 'd.json');
            let clean: boolean;
            try {
                await execFileAsync(
                    cli,
                    [
                        'pcb',
                        'drc',
                        '--refill-zones',
                        '--exit-code-violations',
                        '--severity-error',
                        '--format',
                        'json',
                        '--output',
                        out,
                        join(dir, 'b.kicad_pcb'),
                    ],
                    { timeout: timeoutMs, maxBuffer: MAX_BUFFER },
                );
                clean = true;
            } catch (e) {
                // `--exit-code-violations` makes kicad exit 5 on DRC violations. Async execFile surfaces the
                // exit code on `.code` (NOT `.status`, which is execFileSync's field) — 5 ⇒ dirty (accept-reject).
                if ((e as { code?: number }).code === 5) clean = false;
                else throw e;
            }
            // The DRC run wrote `out` for BOTH exit codes (0 clean / 5 violations), and the JSON is byte-identical
            // to drcReport's (only --exit-code-violations differs, which sets the exit code, not the output). Cache
            // it best-effort so drcReport can skip a redundant run — a parse failure must NEVER flip the verdict.
            try {
                if (existsSync(out))
                    lastDrc = {
                        board: kicadPcb,
                        pro: kicadPro,
                        report: JSON.parse(readFileSync(out, 'utf8')) as KicadDrcJson,
                    };
            } catch {
                lastDrc = null;
            }
            return clean;
        });

    const drcReport = async (kicadPcb: string, kicadPro?: string): Promise<KicadDrcJson> => {
        // Happy path: the notary already DRC'd this exact board → reuse its report, no second kicad-cli run.
        if (lastDrc && lastDrc.board === kicadPcb && lastDrc.pro === kicadPro) {
            opts.log?.info({}, 'DRC report served from the notary memo (skipped a redundant kicad-cli DRC)');
            return lastDrc.report;
        }
        return withBoard(kicadPcb, kicadPro, async (dir) => {
            const out = join(dir, 'd.json');
            await execFileAsync(
                cli,
                [
                    'pcb',
                    'drc',
                    '--refill-zones',
                    '--severity-error',
                    '--format',
                    'json',
                    '--output',
                    out,
                    join(dir, 'b.kicad_pcb'),
                ],
                {
                    timeout: timeoutMs,
                    maxBuffer: MAX_BUFFER,
                },
            );
            // FAIL-CLOSED: this report is the manufacturability gate's sole authority (drcReport runs WITHOUT
            // --exit-code-violations, so a clean exit carries no verdict — only the file does). If kicad-cli
            // exits 0 but writes no report, we must NOT synthesize an empty (=clean) one: that would ship the
            // fab bundle for a board DRC never actually checked. Throw so the job fails instead of over-claiming.
            if (!existsSync(out))
                throw new Error('kicad-cli DRC produced no report file — refusing to assume the board is DRC-clean');
            const report = JSON.parse(readFileSync(out, 'utf8')) as KicadDrcJson;
            lastDrc = { board: kicadPcb, pro: kicadPro, report };
            return report;
        });
    };

    const exportGlb = async (kicadPcb: string): Promise<Buffer> =>
        withBoard(kicadPcb, undefined, async (dir) => {
            const out = join(dir, 'b.glb');
            await execFileAsync(
                cli,
                [
                    'pcb',
                    'export',
                    'glb',
                    '--include-tracks',
                    '--include-pads',
                    '--include-zones',
                    '--include-silkscreen',
                    '--include-soldermask',
                    '--subst-models',
                    '--output',
                    out,
                    join(dir, 'b.kicad_pcb'),
                ],
                { timeout: timeoutMs, maxBuffer: MAX_BUFFER },
            );
            return readFileSync(out);
        });

    // The DELIVERED fab gerbers + drill, exported from the SAME .kicad_pcb the notary DRC'd — so what ships
    // IS the verified board (checked == delivered). `--check-zones` refills the injected GND pour INTO the
    // copper before plotting: proven 18 Tem 2026 that WITHOUT it the B.Cu gerber carries 0 filled regions
    // (the advertised ground plane silently absent from delivery), WITH it the pour lands as real copper.
    // pcb-core's own generateGerbers plots the routed SOUP, which has no zone element at all — hence this
    // authoritative re-export in the worker (where kicad-cli lives) rather than shipping the pourless soup.
    const exportGerbers = async (kicadPcb: string): Promise<GerberOutputs> =>
        withBoard(kicadPcb, undefined, async (dir) => {
            const out = join(dir, 'gbr');
            mkdirSync(out);
            await execFileAsync(
                cli,
                ['pcb', 'export', 'gerbers', '--check-zones', '--output', out, join(dir, 'b.kicad_pcb')],
                { timeout: timeoutMs, maxBuffer: MAX_BUFFER },
            );
            await execFileAsync(cli, ['pcb', 'export', 'drill', '--output', `${out}/`, join(dir, 'b.kicad_pcb')], {
                timeout: timeoutMs,
                maxBuffer: MAX_BUFFER,
            });
            const layers: Record<string, string> = {};
            let drill = '';
            for (const f of readdirSync(out)) {
                if (f.endsWith('.drl')) {
                    drill = readFileSync(join(out, f), 'utf8');
                    continue;
                }
                // The Gerber Job File (.gbrjob) is JSON CAM metadata, NOT a copper/technical layer — keep
                // `layers` a pure layer→gerber map (the GerberOutputs contract) and skip it rather than key
                // its JSON as a bogus 'job' layer (which a fab consumer would materialize as job.gbr).
                if (f.endsWith('.gbrjob')) continue;
                // Key by clean layer name (drop the temp board basename prefix + extension) — the same
                // Record<layer, content> shape the delivery already used from circuit-json-to-gerber.
                layers[f.replace(/^b-/, '').replace(/\.[^.]+$/, '')] = readFileSync(join(out, f), 'utf8');
            }
            return { layers, drill };
        });

    return { notaryDrc, drcReport, exportGlb, exportGerbers };
}
