/**
 * The delivery gate — the single point of control between a board KiCad DRC rejected and a fab bundle the
 * customer can download. Until now it had no test at any level.
 *
 * Why that was dangerous rather than merely untidy: the pure verdict helper (assessManufacturability) IS
 * tested, but nothing checked that the processor acts on what it returns. Deleting the early `return` after
 * the withhold branch, or hoisting the export/upload block above the gate — both plausible "let the user
 * download the diagnostic gerbers too" edits — are type-valid, lint-clean, and green in every other gate in
 * this repo. The API presigns whatever key the worker wrote, with no second opinion, so the result would be
 * a customer downloading a fab-ready bundle for a board KiCad already rejected.
 *
 * Everything external is mocked (DB, S3, kicad-cli, freerouting, pcb-core's pipeline) because the subject
 * here is the WIRING: which branch runs, what gets uploaded, and what lands on the row.
 */
import type { Job } from 'bullmq';

// config validates the environment and calls process.exit(1) when DATABASE_URL/S3_* are absent — which is
// why this file could not have a test before. Stub it with what the processor actually reads.
jest.mock('../config', () => ({
    config: {
        PCB_QUEUE_NAME: 'pcb-layout',
        PCB_CONCURRENCY: 1,
        PCB_ROUTING_MARGIN_MM: 6,
        RUST_PLACER_PATH: 'cf-pcb-place',
        RUST_PLACER_TIMEOUT_MS: 30_000,
    },
}));
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../logger', () => ({ logger }));

const layoutJob = { updateMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() };
jest.mock('../prisma/client', () => ({ prisma: { layoutJob } }));

const uploadFile = jest.fn();
jest.mock('../storage/s3', () => ({ uploadFile: (...a: unknown[]) => uploadFile(...a) }));

const drcReport = jest.fn();
const exportGerbers = jest.fn();
const exportGlb = jest.fn();
const exportPos = jest.fn();
jest.mock('../runners/kicad', () => ({
    makeNativeKicad: () => ({ notaryDrc: jest.fn(), drcReport, exportGerbers, exportGlb, exportPos }),
}));
jest.mock('../runners/freerouting', () => ({ makeNativeFreeroutingRunner: () => jest.fn() }));
jest.mock('../runners/rust-placement', () => ({ makeRustPlacementRunner: () => jest.fn() }));

const layoutCircuit = jest.fn();
// Keep the REAL pcb-core for parseDrcReport / assessManufacturability's inputs and the contract shapers —
// re-mocking those would test a hand-written copy of the verdict logic instead of the verdict logic.
jest.mock('@circuit-forge/pcb-core', () => ({
    ...jest.requireActual('@circuit-forge/pcb-core'),
    layoutCircuit: (...a: unknown[]) => layoutCircuit(...a),
}));

import { processLayoutJob } from './processor';

const JOB_ID = 'job-1';
const job = { data: { jobId: JOB_ID } } as Job<{ jobId: string }>;

/** A 10 × 10 mm board outline in 4.6 format, as kicad-cli plots it. */
const EDGE_CUTS_10MM = [
    '%FSLAX46Y46*%',
    '%MOMM*%',
    'D10*',
    'X0Y0D02*',
    'X10000000Y0D01*',
    'X10000000Y10000000D01*',
    'X0Y10000000D01*',
    'X0Y0D01*',
    'M02*',
].join('\n');

/** Placements that sit on that board — the agreeing pair. */
const POSITION_ON_BOARD = ['Ref,Val,Package,PosX,PosY,Rot,Side', '"R1","10k","0603",2.5,2.5,0,top'].join('\n');

/** A routed board pcb-core is happy with. Diagnostics carry no PCB032, so no pour is expected. */
const okLayout = (diagnostics: unknown[] = []) => ({
    ok: true,
    completeness: 'full',
    diagnostics,
    evaluated: [],
    parity: { ok: true, checkedPins: 4, expectedPins: 4, diagnostics: [] },
    outputs: {
        gerbers: { layers: {}, drill: '' },
        kicadPcb: '(kicad_pcb)',
        kicadPro: '(kicad_pro)',
        bomCsv: 'ref,value',
        placementPreviewCsv: 'ref,x,y',
    },
    stats: { traces: 7, vias: 1, errors: 0, durationMs: 10 },
    fab: { tier: 'economy', profile: {} },
    delivery: {
        routing: { tier: 'quality', drcCertified: true, marginMm: 6 },
        placement: { engine: 'grid', requested: 'grid' },
    },
    namesById: {},
    netNameById: {},
});

/** Real kicad-cli 10 entry shape: { type, severity, description, items:[{description, pos, uuid}] }. */
const VIOLATION = {
    type: 'clearance',
    severity: 'error',
    description: 'Clearance violation (netclass "Default" clearance 0.2mm; actual 0.11mm)',
    items: [{ description: 'Pad 1 [GND] of R1 on F.Cu', pos: { x: 10, y: 10 } }],
};
const UNCONNECTED = {
    type: 'unconnected_items',
    severity: 'error',
    description: 'Missing connection between items',
    items: [
        { description: 'Pad 1 [VCC] of U1 on F.Cu', pos: { x: 1, y: 1 } },
        { description: 'Pad 2 [VCC] of C1 on F.Cu', pos: { x: 5, y: 5 } },
    ],
};

/** The terminal write is a CONDITIONAL updateMany (see finish()); the claim is the FIRST updateMany call. */
const lastUpdate = () => layoutJob.updateMany.mock.calls.at(-1)![0].data as Record<string, unknown>;

beforeEach(() => {
    jest.clearAllMocks();
    layoutJob.updateMany.mockResolvedValue({ count: 1 }); // both the QUEUED→RUNNING claim and the terminal write
    layoutJob.findUnique.mockResolvedValue({ circuit: { components: [], nets: [] }, options: {} });
    layoutJob.update.mockResolvedValue({});
    layoutCircuit.mockResolvedValue(okLayout());
    // A real 10 × 10 mm outline, not a stub: the delivery-frame check reads this gerber and the position
    // file below against EACH OTHER, so a placeholder here would make every test in this file assert
    // against a bundle that could not be checked — the precise blindness the check exists to remove.
    exportGerbers.mockResolvedValue({
        layers: { B_Cu: 'G04*', F_Cu: 'G04*', Edge_Cuts: EDGE_CUTS_10MM },
        drill: 'M48',
    });
    exportPos.mockResolvedValue(POSITION_ON_BOARD);
    exportGlb.mockResolvedValue(Buffer.from('glb'));
    uploadFile.mockResolvedValue(undefined);
});

describe('a board KiCad REJECTED must not become a downloadable bundle', () => {
    beforeEach(() => drcReport.mockResolvedValue({ violations: [VIOLATION], unconnected_items: [] }));

    it('withholds the fab bundle: nothing exported, nothing uploaded, no gerbersKey on the row', async () => {
        await processLayoutJob(job);
        expect(exportGerbers).not.toHaveBeenCalled();
        expect(uploadFile).not.toHaveBeenCalled();
        expect(lastUpdate().gerbersKey).toBeUndefined();
        expect(lastUpdate().glbKey).toBeUndefined();
    });

    it('still SUCCEEDS with an honest verdict — the analysis completed, the board did not pass', async () => {
        await processLayoutJob(job);
        const row = lastUpdate();
        expect(row.status).toBe('SUCCEEDED');
        const result = row.result as Record<string, unknown>;
        expect(result.manufacturable).toBe(false);
        expect(result.notManufacturableReason).toEqual(expect.any(String));
        expect(result.drcClean).toBe(false);
        expect(result.manufacturing).toBeNull();
    });

    it('withholds on UNROUTED nets too, not just rule violations', async () => {
        drcReport.mockResolvedValue({ violations: [], unconnected_items: [UNCONNECTED] });
        await processLayoutJob(job);
        expect(uploadFile).not.toHaveBeenCalled();
        expect((lastUpdate().result as Record<string, unknown>).manufacturable).toBe(false);
    });
});

describe('placement default — a request that says nothing gets our best placement, not our simplest', () => {
    beforeEach(() => drcReport.mockResolvedValue({ violations: [], unconnected_items: [] }));
    const placerArg = () => (layoutCircuit.mock.calls[0]![1] as { placer?: string }).placer;

    it('defaults to the connectivity-aware engine when the request omits one', async () => {
        await processLayoutJob(job);
        expect(placerArg()).toBe('auto');
    });

    it.each(['grid', 'auto', 'rust'])(
        'honours an explicit %s — the default never overrides a choice',
        async (placer) => {
            layoutJob.findUnique.mockResolvedValue({ circuit: { components: [], nets: [] }, options: { placer } });
            await processLayoutJob(job);
            expect(placerArg()).toBe(placer);
        },
    );

    it('does NOT spin up the rust runner for the defaulted engine', async () => {
        // The default must not quietly acquire rust's out-of-process cost or its binary dependency.
        await processLayoutJob(job);
        expect((layoutCircuit.mock.calls[0]![1] as { rustPlace?: unknown }).rustPlace).toBeUndefined();
    });
});

describe('a board KiCad ACCEPTED is delivered', () => {
    beforeEach(() => drcReport.mockResolvedValue({ violations: [], unconnected_items: [] }));

    it('uploads the manufacturing bundle and records the key', async () => {
        await processLayoutJob(job);
        expect(uploadFile).toHaveBeenCalledWith(
            `layouts/${JOB_ID}/manufacturing.json`,
            expect.any(String),
            'application/json',
        );
        const row = lastUpdate();
        expect(row.status).toBe('SUCCEEDED');
        expect(row.gerbersKey).toBe(`layouts/${JOB_ID}/manufacturing.json`);
        expect((row.result as Record<string, unknown>).manufacturable).toBe(true);
    });

    it('delivers the RE-EXPORTED gerbers, not the routed soup pcb-core plotted', async () => {
        // The soup has no zone element, so shipping it would silently drop the advertised ground plane.
        await processLayoutJob(job);
        const payload = JSON.parse(uploadFile.mock.calls[0]![1] as string) as { gerbers: { drill: string } };
        expect(payload.gerbers.drill).toBe('M48'); // from exportGerbers, not outputs.gerbers (drill: '')
        expect(exportGerbers).toHaveBeenCalledWith('(kicad_pcb)');
    });

    it('delivers the placement file plotted from the SAME board, not pcb-core’s design-frame preview', async () => {
        // The defect this replaces: the bundle carried gerbers from `kicadPcb` and a CSV built from the
        // design soup, 100 mm apart on every board. Both files must now come from one board.
        await processLayoutJob(job);
        const payload = JSON.parse(uploadFile.mock.calls[0]![1] as string) as { pnpCsv: string };
        expect(exportPos).toHaveBeenCalledWith('(kicad_pcb)');
        expect(payload.pnpCsv).toBe(POSITION_ON_BOARD);
        expect(payload.pnpCsv).not.toBe('ref,x,y'); // the preview, which must never be delivered
    });

    it('REFUSES a bundle whose placements and gerbers disagree about where the board is', async () => {
        // The (+100, −100) mm bundle, reconstructed. Every artifact here is individually well-formed:
        // the outline is a real 10×10 board, the CSV is valid kicad-cli output with parseable numbers,
        // DRC is clean. Only comparing them to each other reveals it — which is exactly why it shipped.
        exportPos.mockResolvedValue(
            [
                'Ref,Val,Package,PosX,PosY,Rot,Side',
                '"R1","10k","0603",102.5,-97.5,0,top',
                '"C1","1u","0402",107,-93,0,top',
            ].join('\n'),
        );
        await processLayoutJob(job);
        const row = lastUpdate();
        expect(row.status).toBe('FAILED');
        expect(String(row.errorMessage)).toMatch(/not self-consistent/i);
        expect(String(row.errorMessage)).toMatch(/different frames/i);
        // Fail-closed all the way: no key on the row means the API has nothing to presign.
        expect(row.gerbersKey).toBeUndefined();
        expect(uploadFile).not.toHaveBeenCalled();
    });

    it('a failed 3D render must not cost a manufacturable board', async () => {
        exportGlb.mockRejectedValue(new Error('malloc(): unaligned tcache chunk detected'));
        await processLayoutJob(job);
        const row = lastUpdate();
        expect(row.status).toBe('SUCCEEDED');
        expect(row.gerbersKey).toBe(`layouts/${JOB_ID}/manufacturing.json`);
        expect((row.result as Record<string, unknown>).render).toBeNull();
    });

    it('refuses to ship a board whose injected GND pour is missing from the delivered copper', async () => {
        // Advertised-but-absent is worse than absent: fail-closed rather than deliver a board without the
        // ground plane the pipeline reported injecting.
        layoutCircuit.mockResolvedValue(okLayout([{ code: 'PCB032', severity: 'info', message: 'pour injected' }]));
        exportGerbers.mockResolvedValue({ layers: { B_Cu: 'G04 no regions*' }, drill: 'M48' });
        await processLayoutJob(job);
        const row = lastUpdate();
        expect(row.status).toBe('FAILED');
        expect(String(row.errorMessage)).toMatch(/ground plane/i);
        expect(row.gerbersKey).toBeUndefined();
    });
});

/**
 * Warnings do not affect `ok`, so a DELIVERED board can still carry things its owner must know: a net
 * routed narrower than its IPC-2221 target, a refused current, a clamped fab override. None of them are
 * visible anywhere else — the DRC checks are rule violations, and KiCad cannot flag an under-width net
 * because the board carries one global minimum width the trace meets. Persisting them only on the FAILED
 * path meant the successful case, which is the one the customer actually receives, said nothing.
 */
describe('a delivered board carries what the pipeline had to say about it', () => {
    const WARN = { code: 'PCB041', severity: 'warning', message: 'net VBUS: ignored current "2A"' };

    it('persists diagnostics on a MANUFACTURABLE board', async () => {
        layoutCircuit.mockResolvedValue(okLayout([WARN]));
        drcReport.mockResolvedValue({ violations: [], unconnected_items: [] });
        await processLayoutJob(job);
        const result = lastUpdate().result as Record<string, unknown>;
        expect(result.manufacturable).toBe(true);
        expect(result.diagnostics).toEqual([WARN]);
    });

    it('persists them on a WITHHELD board too — same key, so the shape is uniform', async () => {
        layoutCircuit.mockResolvedValue(okLayout([WARN]));
        drcReport.mockResolvedValue({ violations: [VIOLATION], unconnected_items: [] });
        await processLayoutJob(job);
        const result = lastUpdate().result as Record<string, unknown>;
        expect(result.manufacturable).toBe(false);
        expect(result.diagnostics).toEqual([WARN]);
    });
});

/**
 * The reaper terminalizes a job it believes is hung, but it cannot stop this handler or its child
 * processes. When the handler eventually finishes it must NOT resurrect the row — a long-running-operation
 * contract that reaches a terminal state and then changes its mind cannot be polled correctly, and a
 * frontend is about to poll it.
 */
describe('first terminal state wins — a late finish cannot resurrect a reaped job', () => {
    const claimThenReaped = () =>
        layoutJob.updateMany
            .mockResolvedValueOnce({ count: 1 }) // the QUEUED→RUNNING claim
            .mockResolvedValue({ count: 0 }); // the terminal write: the row is no longer RUNNING

    beforeEach(() => drcReport.mockResolvedValue({ violations: [], unconnected_items: [] }));

    it('does not overwrite a row that is already terminal, and says so', async () => {
        claimThenReaped();
        await processLayoutJob(job);
        const terminal = layoutJob.updateMany.mock.calls.at(-1)![0];
        // The write is ATTEMPTED but predicated on RUNNING, so the database refuses it rather than the
        // worker having to know the row was reaped.
        expect(terminal.where).toEqual({ id: JOB_ID, status: 'RUNNING' });
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ jobId: JOB_ID }),
            expect.stringMatching(/already finalized/i),
        );
    });

    it('a normal success CLEARS errorMessage so no reaper text can survive on it', async () => {
        await processLayoutJob(job);
        const row = lastUpdate();
        expect(row.status).toBe('SUCCEEDED');
        expect(row.errorMessage).toBeNull();
    });
});

describe('the scope manifest tells the truth about WHO failed', () => {
    /** The persisted manifest's routing entry, as a caller would read it off the result row. */
    const routingCheck = () => {
        const result = lastUpdate().result as { scope?: { checks: { id: string; status: string; detail?: string }[] } };
        return result.scope!.checks.find((c) => c.id === 'routing')!;
    };

    it('a router that timed out is disclosed as NOT-RUN, so a withheld bundle is not read as a design fault', async () => {
        // The defect: a wedged container or a blown 300s budget delivered the local fallback with
        // drcCertified:false — byte-identical to a board that genuinely cannot be routed. The user was
        // invited to fix a design nobody had found anything wrong with.
        layoutCircuit.mockResolvedValue({
            ...okLayout(),
            delivery: {
                routing: {
                    tier: 'local',
                    drcCertified: false,
                    degradedCause: 'tool-fault',
                    degradedReason: 'the quality router failed before it could judge this board',
                    marginsTried: 1,
                    marginsOffered: 6,
                },
                placement: { engine: 'grid', requested: 'grid' },
            },
        });
        await processLayoutJob(job);
        expect(routingCheck().status).toBe('not-run');
        expect(routingCheck().detail).toMatch(/not a finding about the design/i);
    });

    it('a router that judged every margin and rejected them is disclosed as RUN — that one IS about the board', async () => {
        layoutCircuit.mockResolvedValue({
            ...okLayout(),
            delivery: {
                routing: {
                    tier: 'local',
                    drcCertified: false,
                    degradedCause: 'board-rejected',
                    marginsTried: 6,
                    marginsOffered: 6,
                },
                placement: { engine: 'grid', requested: 'grid' },
            },
        });
        await processLayoutJob(job);
        expect(routingCheck().status).toBe('run');
        expect(routingCheck().detail).not.toMatch(/infrastructure/i);
    });

    it('a quality-routed board is disclosed as run', async () => {
        await processLayoutJob(job); // okLayout() routes at the quality tier
        expect(routingCheck().status).toBe('run');
    });
});

describe('the gate cannot be bypassed by an upstream failure', () => {
    it('a layout pcb-core rejected never reaches the delivery path', async () => {
        layoutCircuit.mockResolvedValue({
            ...okLayout([{ code: 'PCB001', severity: 'error', message: 'not layoutable' }]),
            ok: false,
            outputs: null,
        });
        await processLayoutJob(job);
        expect(drcReport).not.toHaveBeenCalled();
        expect(uploadFile).not.toHaveBeenCalled();
        expect(lastUpdate().status).toBe('FAILED');
    });

    it('a DRC runner that REFUSES to vouch (throws) fails the job — it never falls through to delivery', async () => {
        // This is the payoff of drcReport being fail-closed: an unreadable report must sink the job, not
        // silently read as zero violations.
        drcReport.mockRejectedValue(new Error('kicad-cli DRC produced no report file'));
        await processLayoutJob(job);
        expect(uploadFile).not.toHaveBeenCalled();
        expect(lastUpdate().status).toBe('FAILED');
    });

    it('an unclaimed job (canceled while queued) does no work at all', async () => {
        layoutJob.updateMany.mockResolvedValue({ count: 0 });
        await processLayoutJob(job);
        expect(layoutCircuit).not.toHaveBeenCalled();
        expect(layoutJob.updateMany).toHaveBeenCalledTimes(1); // the failed claim, and nothing after it
    });
});

describe('cancellation — a job the user stopped is not a job that failed', () => {
    it('records CANCELED, not FAILED, whatever the aborted work happened to throw', async () => {
        // Aborting the child makes its runner throw, and pcb-core throws its own LayoutAbortedError at a
        // checkpoint — two different messages for one intent. Recording either as FAILED would put a fault
        // in the operational record for a job the user deliberately ended, so the FLAG is the authority and
        // the error text is not consulted.
        layoutJob.findUnique.mockResolvedValue({ circuit: { components: [], nets: [] }, options: {} });
        // First read is the job row; the abort poll then reports the cancel.
        layoutJob.findUnique
            .mockResolvedValueOnce({ circuit: { components: [], nets: [] }, options: {} })
            .mockResolvedValue({ abortRequested: true });
        layoutCircuit.mockImplementation(async (_c: unknown, opts: { isAborted?: () => Promise<boolean> }) => {
            await opts.isAborted?.(); // the checkpoint pcb-core runs before each routing attempt
            throw new Error('freerouting failed (exit ?) with no output'); // what an aborted child says
        });

        await processLayoutJob(job);

        expect(lastUpdate().status).toBe('CANCELED');
        expect(lastUpdate().errorMessage ?? null).toBeNull();
        expect(uploadFile).not.toHaveBeenCalled();
    });

    it('a genuine fault is still FAILED — the cancel path must not swallow real errors', async () => {
        layoutJob.findUnique.mockResolvedValue({ circuit: { components: [], nets: [] }, options: {} });
        layoutCircuit.mockRejectedValue(new Error('kicad-cli DRC produced no report file'));

        await processLayoutJob(job);

        expect(lastUpdate().status).toBe('FAILED');
        expect(String(lastUpdate().errorMessage)).toMatch(/no report file/);
    });

    it('hands pcb-core a checkpoint AND the child processes a signal — one alone would be a lie', async () => {
        // The flag alone only fires between routing attempts, which can be five minutes away; the signal
        // alone is not durable across a worker restart. A cancel button that waits out an attempt, or one
        // that leaves freerouting burning a slot, are both broken in a way a user would notice.
        layoutJob.findUnique.mockResolvedValue({ circuit: { components: [], nets: [] }, options: {} });
        layoutCircuit.mockResolvedValue(okLayout());

        await processLayoutJob(job);

        const opts = layoutCircuit.mock.calls[0]![1] as { isAborted?: unknown };
        expect(typeof opts.isAborted).toBe('function');
    });
});
