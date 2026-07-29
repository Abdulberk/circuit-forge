/**
 * Native kicad-cli runner — the ONLY implementation. Provides the four things the LayoutJob needs:
 * notaryDrc (bool accept-oracle for the margin-retry), drcReport (parsed, for airwires + categorized
 * checks), exportGlb (3D bodies via --subst-models) and exportGerbers (the DELIVERED fab gerbers,
 * exported from the DRC-verified board with the GND pour refilled in).
 *
 * It began as a port of a scripts/lib/ harness copy that has since been deleted: two implementations of
 * the manufacturability verdict's I/O is one too many, and the copy had drifted fail-OPEN where this one
 * is fail-closed — so "revert to the reference implementation" was a copy-paste away from shipping a
 * board KiCad never checked. The behaviour is pinned by kicad.spec.ts instead.
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
    /** Path to the pcbnew zone-fill helper. Baked into the runtime image; overridable for tests. */
    fillZonesScript?: string;
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

/**
 * A kicad-cli 10 DRC report ALWAYS carries both arrays (verified against real reports). One that does not
 * is not evidence of a clean board — and it would be READ as one: pcb-core's parseDrcReport defaults a
 * missing `violations`/`unconnected_items` to `[]`, which becomes clean → manufacturable → the fab bundle
 * ships. That tolerance is right for a pure normalizer taking partial fixtures and wrong here, because
 * this is the boundary where the file becomes the verdict. So the shape is asserted where it is read.
 */
const isDrcReport = (r: KicadDrcJson): boolean => Array.isArray(r.violations) && Array.isArray(r.unconnected_items);

/**
 * The layers a two-layer board cannot be manufactured without. Copper defines the circuit, Edge_Cuts
 * defines the outline the fab routes to, and the soldermask layers define where solder may go — a board
 * plotted without mask is not a cheaper board, it is an unassemblable one.
 */
const REQUIRED_LAYERS = ['F_Cu', 'B_Cu', 'Edge_Cuts', 'F_Mask', 'B_Mask'] as const;

/**
 * A Gerber with no operation code plots nothing: headers, then `M02*`. Existence ≠ content.
 *
 * D01 draw / D02 move / D03 flash are the only three commands that put anything on a layer, and they
 * terminate a coordinate block (`X0Y0D02*`) rather than standing alone — so no word boundary before the
 * `D`, and the trailing `*` is what separates them from an aperture definition (`%ADD10C,0.1*%`, whose
 * codes start at D10 by spec).
 */
const hasGeometry = (gerber: string): boolean => /D0[123]\*/.test(gerber);

/**
 * Fail-closed post-condition on the DELIVERED artifact — the same posture drcReport takes thirty lines
 * above, for the same reason: this is the boundary where files become the deliverable.
 *
 * Without it exportGerbers returned whatever `readdirSync` happened to find, and the processor uploaded
 * that as the manufacturing bundle. Nothing downstream looks inside: the manufacturability verdict is
 * computed purely from DRC violation and unconnected counts, so it is blind to what was PLOTTED. Measured
 * against the pinned production image: a board whose enabled-layer stack is reduced exports exit-0 with
 * six layers instead of twenty — no soldermask, no silkscreen, no paste — and yields a byte-identical DRC
 * verdict. The customer would download a bundle stamped manufacturable that no fab can build.
 *
 * Latent today (the pinned KiCad and the exact-pinned circuit-json-to-kicad both export a full set), but
 * the trigger is a KiCad-image or converter bump — precisely the event the PCB gate exists to catch, and
 * the one thing that gate does not check, because it verifies DRC rather than delivery.
 */
function assertDeliverable(layers: Record<string, string>): void {
    const missing = REQUIRED_LAYERS.filter((l) => layers[l] === undefined);
    if (missing.length > 0)
        throw new Error(
            `kicad-cli exported an incomplete fab bundle — missing ${missing.join(', ')} (got: ${Object.keys(layers).join(', ') || 'nothing'}). Refusing to deliver a board that cannot be manufactured.`,
        );
    // Edge_Cuts is the one layer whose emptiness is silently catastrophic: the fab has no outline to route
    // to, and every other layer still looks perfectly well-formed.
    if (!hasGeometry(layers.Edge_Cuts!))
        throw new Error(
            'kicad-cli exported an Edge_Cuts layer with no geometry — the board has no outline for the fab to route. Refusing to deliver it.',
        );
}

export function makeNativeKicad(opts: KicadOpts = {}): NativeKicad {
    const cli = opts.cli ?? process.env.KICAD_CLI ?? 'kicad-cli';
    const fillZonesScript =
        opts.fillZonesScript ?? process.env.KICAD_FILL_ZONES_SCRIPT ?? '/usr/local/bin/fill-zones.py';
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
                lastDrc = null;
                if (existsSync(out)) {
                    const report = JSON.parse(readFileSync(out, 'utf8')) as KicadDrcJson;
                    // Only memoize a report that IS one. Caching an unrecognised shape would hand drcReport a
                    // report it would otherwise have rejected, quietly routing around the guard below.
                    if (isDrcReport(report)) lastDrc = { board: kicadPcb, pro: kicadPro, report };
                }
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
            // Same reasoning one step further in: a file that exists but is not a DRC report is no more
            // evidence than no file at all. Without this, a report whose keys were renamed or emptied reads
            // downstream as zero violations and zero unconnected items — i.e. as a perfect board.
            if (!isDrcReport(report))
                throw new Error(
                    'kicad-cli DRC report is missing violations/unconnected_items — refusing to assume the board is DRC-clean',
                );
            lastDrc = { board: kicadPcb, pro: kicadPro, report };
            return report;
        });
    };

    /**
     * The 3D export is the ONLY consumer that cannot refill the copper pour itself.
     *
     * `pcb export gerbers` takes `--check-zones` and `pcb drc` takes `--refill-zones`, so both judge and
     * plot a board whose ground plane is filled. `export glb` has only `--include-zones`, which exports a
     * fill that already exists — and pcb-core emits the zone UNfilled (measured: every gallery board has
     * one zone and zero filled polygons). The result was the same checked-≠-delivered split we closed on
     * the gerber side: the bundle sent to the fab carried a ground plane and the 3D preview the customer
     * inspects did not. Filling is only available through the pcbnew Python API, hence a script rather
     * than a flag — it is a no-op on a board with no zones, so it runs unconditionally.
     */
    const fillZones = async (dir: string, boardPath: string): Promise<void> => {
        try {
            await execFileAsync('python3', [fillZonesScript, boardPath], {
                cwd: dir,
                timeout: timeoutMs,
                maxBuffer: MAX_BUFFER,
            });
        } catch (e) {
            // A pour that cannot be filled is a worse-looking preview, never a wrong verdict — DRC and the
            // gerbers refill independently. Report it and carry on rather than failing a manufacturable job
            // over its picture.
            opts.log?.info(
                { error: e instanceof Error ? e.message : String(e) },
                'Zone fill before 3D export failed — the render will show no copper pour',
            );
        }
    };

    const exportGlb = async (kicadPcb: string): Promise<Buffer> =>
        withBoard(kicadPcb, undefined, async (dir) => {
            await fillZones(dir, join(dir, 'b.kicad_pcb'));
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
            assertDeliverable(layers);
            return { layers, drill };
        });

    return { notaryDrc, drcReport, exportGlb, exportGerbers };
}
