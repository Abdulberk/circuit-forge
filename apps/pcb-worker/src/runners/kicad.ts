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

import { parseDrcReport, type GerberOutputs } from '@circuit-forge/pcb-core';

const execFileAsync = promisify(execFile);
/** kicad-cli progress/warnings go to stdout/stderr which we never read (results are files); a chatty run can
 *  exceed execFile's 1 MiB default and die with ENOBUFS, so budget generously. */
const MAX_BUFFER = 64 * 1024 * 1024;

export interface KicadOpts {
    /** Aborts the kicad-cli child when the caller cancels — see FreeroutingOpts.signal for why a
     *  cooperative checkpoint alone is not enough. */
    signal?: AbortSignal;
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
    /** The DELIVERED pick-and-place, plotted from the same board as the gerbers so the two share a frame. */
    exportPos: (kicadPcb: string) => Promise<string>;
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
function assertDeliverable(layers: Record<string, string>, innerCopperExpected = 0): void {
    /**
     * The inner copper, when the board has any.
     *
     * `REQUIRED_LAYERS` is a two-layer literal, which was the whole truth until four-layer boards existed
     * and is now the blindest possible spot: the two layers a customer paid extra for are exactly the two
     * this gate did not look at. A four-layer board plotted without In1_Cu and In2_Cu passes every other
     * check — the copper that defines the circuit is on the surface layers, the outline is there, the mask
     * is there — and arrives as a two-layer board with a four-layer invoice.
     *
     * Derived from the board rather than hardcoded again, so six layers (if the toolchain ever builds them)
     * needs no edit here.
     */
    const required = [...REQUIRED_LAYERS, ...Array.from({ length: innerCopperExpected }, (_, i) => `In${i + 1}_Cu`)];
    const missing = required.filter((l) => layers[l] === undefined);
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
            // `--severity-all`, and the REPORT decides — not the exit code. Asking kicad for errors only made
            // the report incapable of holding anything else, so every warning it found on our boards was
            // discarded before anyone could read it. `--exit-code-violations` cannot survive that change: at
            // this severity it exits 5 on a warning too, so trusting the code would fail every board over a
            // silkscreen label. pcb-core's parseDrcReport owns which severities block; the exit code is now
            // only a crash signal.
            await execFileAsync(
                cli,
                [
                    'pcb',
                    'drc',
                    '--refill-zones',
                    '--severity-all',
                    '--format',
                    'json',
                    '--output',
                    out,
                    join(dir, 'b.kicad_pcb'),
                ],
                { timeout: timeoutMs, maxBuffer: MAX_BUFFER, signal: opts.signal },
            );
            // FAIL-CLOSED, same reasoning as drcReport: without --exit-code-violations a clean exit carries no
            // verdict at all, so a missing or unrecognisable report must throw rather than read as a board
            // with nothing wrong with it. This is the accept/reject boundary for the fab bundle.
            if (!existsSync(out))
                throw new Error('kicad-cli DRC produced no report file — refusing to assume the board is DRC-clean');
            const report = JSON.parse(readFileSync(out, 'utf8')) as KicadDrcJson;
            if (!isDrcReport(report))
                throw new Error('kicad-cli DRC report is missing violations/unconnected_items — refusing to judge');
            // Memoize so drcReport can skip a redundant run on the same board.
            lastDrc = { board: kicadPcb, pro: kicadPro, report };
            return parseDrcReport(report).clean;
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
                    '--severity-all',
                    '--format',
                    'json',
                    '--output',
                    out,
                    join(dir, 'b.kicad_pcb'),
                ],
                {
                    timeout: timeoutMs,
                    maxBuffer: MAX_BUFFER,
                    signal: opts.signal,
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
                signal: opts.signal,
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
                { timeout: timeoutMs, maxBuffer: MAX_BUFFER, signal: opts.signal },
            );
            return readFileSync(out);
        });

    // The DELIVERED fab gerbers + drill, exported from the SAME .kicad_pcb the notary DRC'd — so what ships
    // IS the verified board (checked == delivered). `--check-zones` refills the injected GND pour INTO the
    // copper before plotting: proven 18 Tem 2026 that WITHOUT it the B.Cu gerber carries 0 filled regions
    // (the advertised ground plane silently absent from delivery), WITH it the pour lands as real copper.
    // pcb-core's own generateGerbers plots the routed SOUP, which has no zone element at all — hence this
    // authoritative re-export in the worker (where kicad-cli lives) rather than shipping the pourless soup.
    /**
     * How many buried copper layers this board declares.
     *
     * Read from the .kicad_pcb the notary judged, not from the request: the gate must compare the export
     * against the board that was actually verified, or it is checking the order form instead of the goods.
     */
    const innerCopperCount = (kicadPcb: string): number =>
        new Set([...kicadPcb.matchAll(/"(Ind+).Cu"/g)].map((m) => m[1])).size;

    const exportGerbers = async (kicadPcb: string): Promise<GerberOutputs> =>
        withBoard(kicadPcb, undefined, async (dir) => {
            const out = join(dir, 'gbr');
            mkdirSync(out);
            // `--use-drill-file-origin` here and `--drill-origin plot` below make both artifacts measure
            // from the marker pcb-core stamps into the board (`injectPlacementOrigin`) — the board's own
            // lower-left corner. The position file two blocks down reads the SAME marker, which is what
            // ends the (+100, −100) mm split between the copper and the placements. All three flags are
            // one decision; changing any one alone re-opens the defect, so they are asserted together.
            await execFileAsync(
                cli,
                [
                    'pcb',
                    'export',
                    'gerbers',
                    '--check-zones',
                    '--use-drill-file-origin',
                    '--output',
                    out,
                    join(dir, 'b.kicad_pcb'),
                ],
                { timeout: timeoutMs, maxBuffer: MAX_BUFFER, signal: opts.signal },
            );
            await execFileAsync(
                cli,
                ['pcb', 'export', 'drill', '--drill-origin', 'plot', '--output', `${out}/`, join(dir, 'b.kicad_pcb')],
                {
                    timeout: timeoutMs,
                    maxBuffer: MAX_BUFFER,
                    signal: opts.signal,
                },
            );
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
            assertDeliverable(layers, innerCopperCount(kicadPcb));
            return { layers, drill };
        });

    /**
     * The pick-and-place file, plotted from the SAME board the gerbers came from.
     *
     * This replaces a CSV that pcb-core built from the design soup. Both looked correct on their own, and
     * nothing compared them to each other, so nobody noticed they were 100 mm apart — measured across
     * three boards and nineteen components with no exception. A machine loading that pair puts every part
     * 100 mm off the copper, on boards whose pads sit half a millimetre apart.
     *
     * `--units mm` is not optional decoration: kicad-cli defaults this to INCHES, and a position file
     * silently in inches next to millimetre gerbers is the same defect back with a 25.4× factor instead of
     * a 100 mm one — quieter, and therefore worse.
     *
     * `--exclude-dnp` follows from what the file MEANS: a do-not-populate part must not be handed to the
     * placement machine. Harmless today (nothing marks DNP yet), correct the day something does.
     */
    const exportPos = async (kicadPcb: string): Promise<string> =>
        withBoard(kicadPcb, undefined, async (dir) => {
            const out = join(dir, 'pos.csv');
            await execFileAsync(
                cli,
                [
                    'pcb',
                    'export',
                    'pos',
                    '--format',
                    'csv',
                    '--units',
                    'mm',
                    '--use-drill-file-origin',
                    '--exclude-dnp',
                    '--output',
                    out,
                    join(dir, 'b.kicad_pcb'),
                ],
                { timeout: timeoutMs, maxBuffer: MAX_BUFFER, signal: opts.signal },
            );
            const csv = readFileSync(out, 'utf8');
            // A header-only file is what an empty board and a broken export look like alike. The board
            // reaching this point has already passed parity and DRC, so it HAS components; a position file
            // without any is the export failing quietly, and quiet is the one thing this path may not do.
            if (csv.split(/\r?\n/).filter((l) => l.trim()).length < 2)
                throw new Error(
                    'kicad-cli exported a position file with no placements — refusing to deliver a bundle whose assembly file is empty.',
                );
            return csv;
        });

    return { notaryDrc, drcReport, exportGlb, exportGerbers, exportPos };
}
