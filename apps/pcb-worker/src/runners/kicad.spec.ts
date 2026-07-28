/**
 * The production kicad-cli runner — until now executed by NO test and NO CI job.
 *
 * That mattered more than a coverage number. This file is the I/O half of the manufacturability verdict:
 * `drcReport` runs kicad-cli WITHOUT `--exit-code-violations` (so findings do not throw), which means the
 * exit code carries no verdict and the report FILE is the only signal. Downstream, pcb-core's
 * parseDrcReport treats a missing `violations`/`unconnected_items` as an empty one — clean — and the
 * processor ships the fab bundle on clean. So every way this function can hand back something that is not
 * a real report is a way to ship a board KiCad never actually checked.
 *
 * The repo used to carry an older fail-OPEN copy of this logic that the runner was documented as a port
 * of, which made "revert to the reference implementation" a plausible and catastrophic edit. That copy is
 * gone; these tests are what now stands in its place — they exist to make any such edit red.
 *
 * child_process is mocked (the same idiom as rust-placement.spec.ts): the point is the runner's decisions,
 * not kicad-cli itself — the real binary is exercised by the Docker gate.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeNativeKicad } from './kicad';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));

const execFileMock = execFile as unknown as jest.Mock;

type Cb = (error: (Error & { code?: number; status?: number }) | null, stdout?: string, stderr?: string) => void;

/** Drive the mocked kicad-cli: write `report` to the --output path (or nothing), then finish with `error`. */
const kicadWrites = (report: unknown, error: (Error & { code?: number }) | null = null) =>
    execFileMock.mockImplementation((_bin: string, args: string[], _opts: unknown, cb: Cb) => {
        const out = args[args.indexOf('--output') + 1]!;
        if (report !== undefined) writeFileSync(out, JSON.stringify(report));
        cb(error);
    });

const exit = (code: number) => Object.assign(new Error(`kicad-cli exited ${code}`), { code });

const CLEAN = { violations: [], unconnected_items: [] };
const DIRTY = { violations: [{ type: 'clearance' }], unconnected_items: [] };

let workDir: string;
beforeEach(() => {
    jest.clearAllMocks();
    workDir = mkdtempSync(join(tmpdir(), 'kicad-spec-'));
});
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

const kicad = () => makeNativeKicad({ cli: 'kicad-cli-for-test', workDir });

describe('drcReport — the report file is the verdict, so it must actually be a report', () => {
    it('returns a well-formed report unchanged', async () => {
        kicadWrites(DIRTY);
        await expect(kicad().drcReport('(board)', '(pro)')).resolves.toEqual(DIRTY);
    });

    it('REJECTS when kicad-cli exits 0 but writes no report at all', async () => {
        // Fail-closed. The older sibling implementation synthesizes {violations:[],unconnected_items:[]}
        // here, which reads downstream as a flawless board.
        kicadWrites(undefined);
        await expect(kicad().drcReport('(board)')).rejects.toThrow(/no report file/i);
    });

    it('REJECTS an empty JSON object — "no keys" is not "no violations"', async () => {
        kicadWrites({});
        await expect(kicad().drcReport('(board)')).rejects.toThrow(/missing violations\/unconnected_items/i);
    });

    it.each([
        ['renamed keys (a schema change on a KiCad upgrade)', { drc_violations: [], unconnected: [] }],
        ['violations present but unconnected_items absent', { violations: [] }],
        ['unconnected_items present but violations absent', { unconnected_items: [] }],
        ['the arrays replaced by counts', { violations: 0, unconnected_items: 0 }],
        ['null arrays', { violations: null, unconnected_items: null }],
    ])('REJECTS %s', async (_label, report) => {
        kicadWrites(report);
        await expect(kicad().drcReport('(board)')).rejects.toThrow(/missing violations\/unconnected_items/i);
    });

    it('REJECTS an unparseable report rather than treating it as clean', async () => {
        execFileMock.mockImplementation((_bin: string, args: string[], _opts: unknown, cb: Cb) => {
            writeFileSync(args[args.indexOf('--output') + 1]!, '{not json');
            cb(null);
        });
        await expect(kicad().drcReport('(board)')).rejects.toThrow();
    });

    it('runs WITHOUT --exit-code-violations, which is why the file has to be trusted', async () => {
        kicadWrites(DIRTY);
        await kicad().drcReport('(board)');
        const args = execFileMock.mock.calls[0]![1] as string[];
        expect(args).toContain('--refill-zones');
        expect(args).not.toContain('--exit-code-violations');
    });
});

describe('notaryDrc — the accept/reject oracle the margin ladder runs on', () => {
    it('a clean exit means clean', async () => {
        kicadWrites(CLEAN);
        await expect(kicad().notaryDrc('(board)', '(pro)')).resolves.toBe(true);
    });

    it('exit 5 means DIRTY, not broken — it must REJECT the board, never throw', async () => {
        // The margin ladder reads this as "try the next margin". If it threw instead, pcb-core would catch
        // it upstream and silently fall back to the local fast route for every board.
        kicadWrites(DIRTY, exit(5));
        await expect(kicad().notaryDrc('(board)')).resolves.toBe(false);
    });

    it("reads the exit code from the ASYNC field — `status` is execFileSync's, and is not 5 here", async () => {
        // The regression this pins: porting `e.code` to `e.status` (the sync sibling's field) would make an
        // ordinary dirty board look like an infrastructure fault.
        const wrongField = Object.assign(new Error('kicad-cli exited 5'), { status: 5 });
        kicadWrites(DIRTY, wrongField as Error & { code?: number });
        await expect(kicad().notaryDrc('(board)')).rejects.toThrow();
    });

    it('any other failure is a real fault and propagates', async () => {
        kicadWrites(undefined, exit(127)); // binary missing
        await expect(kicad().notaryDrc('(board)')).rejects.toThrow();
    });
});

describe('the notary memo — a second identical DRC is skipped, but only when it is genuinely identical', () => {
    it('serves drcReport from the notary run for the SAME board (one kicad-cli invocation)', async () => {
        kicadWrites(CLEAN);
        const k = kicad();
        await k.notaryDrc('(board)', '(pro)');
        await expect(k.drcReport('(board)', '(pro)')).resolves.toEqual(CLEAN);
        expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it('re-runs for a DIFFERENT board — a stale verdict would be the worst possible cache hit', async () => {
        kicadWrites(CLEAN);
        const k = kicad();
        await k.notaryDrc('(board A)', '(pro)');
        await k.drcReport('(board B)', '(pro)');
        expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it('re-runs when the PROJECT differs — the rules are half of the verdict', async () => {
        kicadWrites(CLEAN);
        const k = kicad();
        await k.notaryDrc('(board)', '(pro A)');
        await k.drcReport('(board)', '(pro B)');
        expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it('never memoizes an unrecognised report — the cache must not smuggle one past the guard', async () => {
        kicadWrites({ violations: 'lots' });
        const k = kicad();
        await k.notaryDrc('(board)', '(pro)'); // exit 0 → the notary itself says clean
        await expect(k.drcReport('(board)', '(pro)')).rejects.toThrow(/missing violations\/unconnected_items/i);
    });
});

describe('exportGerbers — what ships is exported from the board that was checked', () => {
    /** A plotted layer with real geometry: a Gerber carrying no D01/D02 draws nothing. */
    const PLOTTED = 'G04 plotted*\nX0Y0D02*\nX100Y0D01*\nM02*';
    /** Well-formed and completely empty — headers then end-of-file. This is what a dropped layer looks like. */
    const BLANK = 'G04 empty*\nM02*';
    /** The set kicad-cli produces for a real two-layer board (trimmed to what the assertion cares about). */
    const FULL: Record<string, string> = {
        F_Cu: PLOTTED,
        B_Cu: PLOTTED,
        Edge_Cuts: PLOTTED,
        F_Mask: PLOTTED,
        B_Mask: PLOTTED,
        F_Silkscreen: PLOTTED,
        B_Paste: PLOTTED,
    };

    /** Drive the mocked kicad-cli to plot exactly `set`, plus the drill and the CAM metadata file. */
    const plots = (set: Record<string, string>) =>
        execFileMock.mockImplementation((_bin: string, args: string[], _opts: unknown, cb: Cb) => {
            const out = args[args.indexOf('--output') + 1]!;
            if (args.includes('gerbers')) {
                for (const [layer, content] of Object.entries(set)) writeFileSync(join(out, `b-${layer}.gbr`), content);
                writeFileSync(join(out, 'b-job.gbrjob'), '{"meta":true}');
            } else {
                writeFileSync(join(out, 'b.drl'), 'M48');
            }
            cb(null);
        });

    it('refills the pour into copper and skips the CAM metadata file', async () => {
        // Without --check-zones the delivered B.Cu gerber carries zero filled regions: the advertised
        // ground plane silently absent from delivery. The .gbrjob is JSON metadata, not a layer.
        plots(FULL);
        const r = await kicad().exportGerbers('(board)');
        expect(Object.keys(r.layers).sort()).toEqual(Object.keys(FULL).sort());
        expect(r.drill).toBe('M48');
        expect(execFileMock.mock.calls[0]![1] as string[]).toContain('--check-zones');
    });

    /**
     * The delivered bundle is the ONLY artifact nothing downstream inspects: the manufacturability verdict
     * is computed from DRC violation/unconnected counts alone, so it cannot see what was plotted. Measured
     * against the pinned image, a reduced layer stack exports exit-0 with six layers instead of twenty and
     * yields a byte-identical DRC verdict — a bundle no fab can build, stamped manufacturable.
     */
    it.each(['F_Cu', 'B_Cu', 'Edge_Cuts', 'F_Mask', 'B_Mask'])(
        'REFUSES to deliver a bundle missing %s',
        async (layer) => {
            const { [layer]: _dropped, ...rest } = FULL;
            plots(rest);
            await expect(kicad().exportGerbers('(board)')).rejects.toThrow(
                new RegExp(`incomplete fab bundle.*${layer}`, 's'),
            );
        },
    );

    it('REFUSES an Edge_Cuts layer that exists but plots nothing — the fab would have no outline', async () => {
        // Existence is not content. Every other layer still looks perfectly well-formed.
        plots({ ...FULL, Edge_Cuts: BLANK });
        await expect(kicad().exportGerbers('(board)')).rejects.toThrow(/no geometry|no outline/i);
    });

    it('REFUSES an empty export outright rather than uploading nothing as a bundle', async () => {
        plots({});
        await expect(kicad().exportGerbers('(board)')).rejects.toThrow(/incomplete fab bundle/i);
    });

    it('does NOT require the optional layers — silkscreen and paste are not manufacturability gates', async () => {
        // Deliberately narrow: a board without silkscreen is ugly, a board without soldermask is unusable.
        // Over-requiring here would fail good boards on a cosmetic difference between KiCad versions.
        const { F_Silkscreen: _s, B_Paste: _p, ...required } = FULL;
        plots(required);
        await expect(kicad().exportGerbers('(board)')).resolves.toMatchObject({ drill: 'M48' });
    });
});
