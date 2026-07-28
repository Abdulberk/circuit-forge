/**
 * Layout Job Processor — the durable home of the PCB quality pipeline.
 *
 * Mirrors the design worker's contract: an atomic QUEUED→RUNNING claim (optimistic concurrency against the
 * API's enqueue), then it runs pcb-core's `layoutCircuit(router:'quality')` with the NATIVE freerouting +
 * kicad-cli runners injected (proven end-to-end in M3a), shapes the clean frontend contract, uploads the
 * heavy blobs (GLB + Gerbers/BOM/PnP) to S3, and lands a terminal LayoutJob row (the client polls the row;
 * BullMQ is just transport). NEVER throws — every failure is captured onto the row.
 */
import {
    layoutCircuit,
    injectModels,
    shapeLayoutResult,
    parseDrcReport,
    drcToChecks,
    airwiresFromDrc,
    buildLayoutScope,
} from '@circuit-forge/pcb-core';
import { Prisma } from '@prisma/client';
import { Job, Worker } from 'bullmq';
import Redis from 'ioredis';

import { config } from '../config';
import { logger } from '../logger';
import { prisma } from '../prisma/client';
import { makeNativeFreeroutingRunner } from '../runners/freerouting';
import { makeNativeKicad } from '../runners/kicad';
import { makeRustPlacementRunner } from '../runners/rust-placement';
import { uploadFile } from '../storage/s3';

import { assessManufacturability } from './outcome';

/** Queue payload the API enqueues. The circuit + options live on the row (they can be large); the payload
 *  carries only the row id (and an optional W3C trace carrier for future span-linking). */
export interface LayoutJobPayload {
    jobId: string;
    otel?: Record<string, string>;
}

export function createLayoutWorker(): Worker<LayoutJobPayload> {
    const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
    const worker = new Worker<LayoutJobPayload>(
        config.PCB_QUEUE_NAME,
        async (job: Job<LayoutJobPayload>) => processLayoutJob(job),
        // The freerouting/kicad-cli calls are async (execFile) so the loop stays free and BullMQ renews the
        // lock across the multi-minute pipeline. lockDuration is still raised well above the default 30s
        // because pcb-core's tscircuit eval + DSN/SES/DRC file I/O run synchronously on this thread and can
        // block renewal for tens of seconds on dense boards; 300s (= the per-tool timeout) covers that.
        { connection, concurrency: config.PCB_CONCURRENCY, lockDuration: 300_000 },
    );
    worker.on('completed', (job) => logger.info({ jobId: job.data.jobId }, 'Layout job completed'));
    worker.on('failed', (job, err) =>
        logger.error({ jobId: job?.data.jobId, error: err.message }, 'Layout job failed'),
    );
    worker.on('error', (err) => logger.error({ error: err.message }, 'Layout worker error'));
    logger.info({ queue: config.PCB_QUEUE_NAME, concurrency: config.PCB_CONCURRENCY }, 'Layout worker started');
    return worker;
}

/** Write the terminal LayoutJob row. Best-effort: a failed DB write is logged, not thrown. */
async function finish(
    jobId: string,
    data: {
        status: 'SUCCEEDED' | 'FAILED' | 'CANCELED';
        result?: Prisma.InputJsonValue;
        glbKey?: string;
        gerbersKey?: string;
        errorMessage?: string;
    },
): Promise<void> {
    try {
        await prisma.layoutJob.update({
            where: { id: jobId },
            data: {
                status: data.status,
                finishedAt: new Date(),
                ...(data.result !== undefined ? { result: data.result } : {}),
                ...(data.glbKey ? { glbKey: data.glbKey } : {}),
                ...(data.gerbersKey ? { gerbersKey: data.gerbersKey } : {}),
                ...(data.errorMessage ? { errorMessage: data.errorMessage } : {}),
            },
        });
    } catch (e) {
        logger.error(
            { jobId, error: e instanceof Error ? e.message : String(e) },
            'Could not persist terminal layout-job row',
        );
    }
}

/** Exported for the delivery-gate spec: the withhold branch below is the only thing between a board KiCad
 *  rejected and a downloadable fab bundle, so it is tested directly rather than through BullMQ. */
export async function processLayoutJob(job: Job<LayoutJobPayload>): Promise<void> {
    const { jobId } = job.data;
    const t0 = Date.now();

    // Atomic claim QUEUED→RUNNING (same guard as the design worker): count 0 ⇒ canceled while queued or
    // the API's enqueue-failure path already marked it terminal — do not run, do not overwrite.
    const claim = await prisma.layoutJob.updateMany({
        where: { id: jobId, status: 'QUEUED' },
        data: { status: 'RUNNING', startedAt: new Date() },
    });
    if (claim.count === 0) {
        logger.info({ jobId }, 'Layout job not claimed (canceled or already terminal) — skipping');
        return;
    }

    try {
        const row = await prisma.layoutJob.findUnique({
            where: { id: jobId },
            select: { circuit: true, options: true },
        });
        if (!row) {
            await finish(jobId, { status: 'FAILED', errorMessage: 'Layout job row vanished after claim' });
            return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const circuit = row.circuit as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const options = (row.options ?? {}) as any;

        const freeroute = makeNativeFreeroutingRunner();
        const kicad = makeNativeKicad({ log: logger });
        const rustPlace =
            options.placer === 'rust'
                ? makeRustPlacementRunner({ binary: config.RUST_PLACER_PATH, timeoutMs: config.RUST_PLACER_TIMEOUT_MS })
                : undefined;

        const q = await layoutCircuit(circuit, {
            router: 'quality',
            freeroute,
            notaryDrc: kicad.notaryDrc,
            fabProfile: options.fabProfile,
            netCurrentsA: options.netCurrentsA,
            placer: options.placer,
            rustPlace,
            routingMarginMm: config.PCB_ROUTING_MARGIN_MM,
        });

        if (!q.ok || !q.outputs) {
            const errs = q.diagnostics
                .filter((d) => d.severity === 'error')
                .map((d) => `${d.code} ${d.message}`)
                .join(' | ');
            logger.warn({ jobId, errs }, 'layoutCircuit not ok');
            await finish(jobId, {
                status: 'FAILED',
                errorMessage: (errs || 'layout failed').slice(0, 500),
                result: { diagnostics: q.diagnostics } as unknown as Prisma.InputJsonValue,
            });
            return;
        }

        // Clean frontend contract + DRC-derived airwires/checks. The final DRC report is the manufacturability
        // authority (see outcome.ts): only a DRC-clean board earns the fab-ready bundle.
        const geo = shapeLayoutResult(q.evaluated, { namesById: q.namesById });
        const parsed = parseDrcReport(await kicad.drcReport(q.outputs.kicadPcb, q.outputs.kicadPro));
        const checks = drcToChecks(parsed);
        const { airwires } = airwiresFromDrc(parsed, geo);
        const verdict = assessManufacturability(parsed);

        // Inspection payload — always delivered, and with a UNIFORM shape across both outcomes so consumers
        // never special-case the blob: the 2D geometry + categorized checks + airwires are the diagnostic
        // view, and notManufacturableReason is null exactly when manufacturable is true.
        const inspection = {
            layout: geo as unknown as Prisma.InputJsonValue,
            checks: checks as unknown as Prisma.InputJsonValue,
            airwires: airwires as unknown as Prisma.InputJsonValue,
            manufacturable: verdict.manufacturable,
            notManufacturableReason: verdict.reason,
            drcClean: parsed.clean,
            stats: q.stats as unknown as Prisma.InputJsonValue,
            parity: q.parity as unknown as Prisma.InputJsonValue,
            completeness: q.completeness,
            // The rules these gerbers were BUILT and JUDGED by, after the request's overrides were completed
            // and clamped. "Which design rules produced this board" is the first question when a fab rejects
            // a panel, and re-deriving it from the request is guesswork once an override has been adjusted.
            fab: q.fab as unknown as Prisma.InputJsonValue,
            // WHICH router and WHICH placement engine actually produced this board, and why the requested
            // one was not used when that happened. Both stages fall back on purpose, but until now a board
            // routed by the local fast router — undersized vias, looser clearances, no DRC certification —
            // was indistinguishable from a freerouting board the notary certified. A caller could not tell
            // the two apart, which is precisely how a dead quality tier stays unnoticed.
            delivery: q.delivery as unknown as Prisma.InputJsonValue,
            // Scope disclosure for the layout verdict: what this endpoint checked (connectivity/DRC/
            // manufacturability) — decoupling/polarity are the electrical endpoint's concern, absent here.
            scope: buildLayoutScope({
                parityPins: { checked: q.parity.checkedPins, expected: q.parity.expectedPins },
                drcClean: parsed.clean,
                drcViolations: parsed.violations.length,
                manufacturable: verdict.manufacturable,
            }) as unknown as Prisma.InputJsonValue,
        };

        if (!verdict.manufacturable) {
            // GATE: the board failed the ordered fab rules. Do NOT spend a GLB export or ship the fab-ready
            // bundle — there must be nothing manufacturable to download. Status stays SUCCEEDED (the analysis
            // completed); the verdict is result.manufacturable=false with a reason, and the client shows the
            // violations from `checks`/`airwires`. This is the false-"verified" fix: no clean bundle escapes.
            logger.warn(
                { jobId, ms: Date.now() - t0, violations: verdict.violations, unrouted: verdict.unrouted },
                'Layout completed but board is NOT manufacturable — withholding fab bundle',
            );
            await finish(jobId, {
                status: 'SUCCEEDED',
                result: {
                    ...inspection,
                    bodies: null,
                    render: null,
                    manufacturing: null,
                } as unknown as Prisma.InputJsonValue,
            });
            return;
        }

        // Manufacturable → deliver the fab-ready bundle FIRST: it is the manufacturable deliverable and must
        // never be lost to a cosmetic 3D-render failure. Heavy blobs → S3 (keys on the row).
        //
        // The delivered gerbers are RE-EXPORTED from the DRC-verified .kicad_pcb (with the GND pour refilled
        // into the copper), NOT pcb-core's q.outputs.gerbers — those plot the routed soup, which has no zone
        // element, so they would ship a board missing the ground plane we advertise (checked ≠ delivered).
        // Exporting here makes the delivered artifact the SAME board the notary DRC'd.
        const gerbers = await kicad.exportGerbers(q.outputs.kicadPcb);
        // Evidence, not assertion: when pcb-core injected a GND pour (PCB032), the delivered B.Cu copper MUST
        // carry a filled region (a gerber G36 region). If it does not, refuse to ship rather than deliver a
        // board silently missing its advertised ground plane — fail-closed, matching drcReport's posture.
        // gndPlane is meaningful ONLY when a pour was injected: a G36 region can also come from region-based
        // pads, so `pourInjected &&` keeps the evidence honest (false when no plane was ever requested).
        const pourInjected = q.diagnostics.some((d) => d.code === 'PCB032');
        const gndPlane = pourInjected && (gerbers.layers['B_Cu'] ?? '').includes('G36');
        if (pourInjected && !gndPlane) {
            throw new Error(
                'GND pour injected but the exported B.Cu gerber has no filled copper region — refusing to ship a board missing its advertised ground plane',
            );
        }
        const gerbersKey = `layouts/${jobId}/manufacturing.json`;
        await uploadFile(
            gerbersKey,
            JSON.stringify({ gerbers, bomCsv: q.outputs.bomCsv, pnpCsv: q.outputs.pnpCsv }),
            'application/json',
        );

        // 3D render is BEST-EFFORT: a GLB export failure (missing 3D model, timeout, ENOBUFS) must not sink an
        // already-manufacturable board — deliver the gerbers with the render omitted rather than failing the job.
        let glbKey: string | undefined;
        let bodies: Prisma.InputJsonValue | null = null;
        try {
            const inj = injectModels(q.outputs.kicadPcb);
            const glb = await kicad.exportGlb(inj.kicadPcb);
            glbKey = `layouts/${jobId}/board.glb`;
            await uploadFile(glbKey, glb, 'model/gltf-binary');
            bodies = { injected: inj.injected, unmatched: inj.unmatched.map((u) => u.id) };
        } catch (e) {
            logger.warn(
                { jobId, error: e instanceof Error ? e.message : String(e) },
                'Manufacturable board: 3D GLB render failed — delivering the fab bundle without it',
            );
        }

        const result: Prisma.InputJsonValue = {
            ...inspection,
            bodies,
            render: glbKey ? { glbKey } : null,
            manufacturing: { gerbersKey, gndPlane },
        };
        await finish(jobId, { status: 'SUCCEEDED', result, glbKey, gerbersKey });
        logger.info(
            { jobId, ms: Date.now() - t0, traces: q.stats.traces, manufacturable: true, rendered: !!glbKey },
            'Layout job succeeded (manufacturable)',
        );
    } catch (e) {
        logger.error({ jobId, error: e instanceof Error ? e.message : String(e) }, 'Layout job threw');
        await finish(jobId, {
            status: 'FAILED',
            errorMessage: (e instanceof Error ? e.message : String(e)).slice(0, 500),
        });
    }
}
