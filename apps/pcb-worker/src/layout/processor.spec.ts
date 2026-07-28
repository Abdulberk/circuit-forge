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
jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const layoutJob = { updateMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() };
jest.mock('../prisma/client', () => ({ prisma: { layoutJob } }));

const uploadFile = jest.fn();
jest.mock('../storage/s3', () => ({ uploadFile: (...a: unknown[]) => uploadFile(...a) }));

const drcReport = jest.fn();
const exportGerbers = jest.fn();
const exportGlb = jest.fn();
jest.mock('../runners/kicad', () => ({
    makeNativeKicad: () => ({ notaryDrc: jest.fn(), drcReport, exportGerbers, exportGlb }),
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
        pnpCsv: 'ref,x,y',
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

const lastUpdate = () => layoutJob.update.mock.calls.at(-1)![0].data as Record<string, unknown>;

beforeEach(() => {
    jest.clearAllMocks();
    layoutJob.updateMany.mockResolvedValue({ count: 1 }); // the QUEUED→RUNNING claim succeeds
    layoutJob.findUnique.mockResolvedValue({ circuit: { components: [], nets: [] }, options: {} });
    layoutJob.update.mockResolvedValue({});
    layoutCircuit.mockResolvedValue(okLayout());
    exportGerbers.mockResolvedValue({ layers: { B_Cu: 'G04*', F_Cu: 'G04*' }, drill: 'M48' });
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
        expect(layoutJob.update).not.toHaveBeenCalled();
    });
});
