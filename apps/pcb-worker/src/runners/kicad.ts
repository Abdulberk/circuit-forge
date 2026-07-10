/**
 * Native kicad-cli runner (TS port of scripts/lib/kicad-native.mjs — proven in M2/M3a). Provides the
 * three things the LayoutJob needs: notaryDrc (bool accept-oracle for the margin-retry), drcReport
 * (parsed, for airwires + categorized checks) and exportGlb (3D bodies via --subst-models).
 */
import { execFile } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

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
    const withBoard = async <T>(kicadPcb: string, kicadPro: string | undefined, fn: (dir: string) => Promise<T>): Promise<T> => {
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
                    ['pcb', 'drc', '--refill-zones', '--exit-code-violations', '--severity-error', '--format', 'json', '--output', out, join(dir, 'b.kicad_pcb')],
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
                if (existsSync(out)) lastDrc = { board: kicadPcb, pro: kicadPro, report: JSON.parse(readFileSync(out, 'utf8')) as KicadDrcJson };
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
            await execFileAsync(cli, ['pcb', 'drc', '--refill-zones', '--severity-error', '--format', 'json', '--output', out, join(dir, 'b.kicad_pcb')], {
                timeout: timeoutMs,
                maxBuffer: MAX_BUFFER,
            });
            const report = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as KicadDrcJson) : { violations: [], unconnected_items: [] };
            lastDrc = { board: kicadPcb, pro: kicadPro, report };
            return report;
        });
    };

    const exportGlb = async (kicadPcb: string): Promise<Buffer> =>
        withBoard(kicadPcb, undefined, async (dir) => {
            const out = join(dir, 'b.glb');
            await execFileAsync(
                cli,
                ['pcb', 'export', 'glb', '--include-tracks', '--include-pads', '--include-zones', '--include-silkscreen', '--include-soldermask', '--subst-models', '--output', out, join(dir, 'b.kicad_pcb')],
                { timeout: timeoutMs, maxBuffer: MAX_BUFFER },
            );
            return readFileSync(out);
        });

    return { notaryDrc, drcReport, exportGlb };
}
