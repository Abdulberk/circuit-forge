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
    type LayoutOptions,
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

/**
 * Write the terminal LayoutJob row. Best-effort: a failed DB write is logged, not thrown.
 *
 * CONDITIONAL on the row still being RUNNING, mirroring the reaper's own guard. The reaper terminalizes a
 * job it believes is hung (past PCB_REAP_RUNNING_DEADLINE_MS) but cannot stop this handler or its child
 * processes — so a late finish used to overwrite that FAILED row with SUCCEEDED, complete with a
 * downloadable gerbersKey. Worse, `errorMessage` was written only when truthy, so the row landed SUCCEEDED
 * still carrying "reaped: exceeded the maximum runtime", and the API hands that to the client verbatim.
 *
 * A long-running-operation contract that reaches a terminal state and then changes its mind is one a
 * frontend cannot poll correctly — and it is about to be polled. First terminal state wins; a late writer
 * says so in the log and leaves the row alone.
 */
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
        const res = await prisma.layoutJob.updateMany({
            // Every finish() call happens after the atomic QUEUED→RUNNING claim, so RUNNING is the only
            // state this handler may legitimately overwrite.
            where: { id: jobId, status: 'RUNNING' },
            data: {
                status: data.status,
                finishedAt: new Date(),
                ...(data.result !== undefined ? { result: data.result } : {}),
                ...(data.glbKey ? { glbKey: data.glbKey } : {}),
                ...(data.gerbersKey ? { gerbersKey: data.gerbersKey } : {}),
                // Explicitly CLEAR on a non-failure outcome. Writing it only when truthy is what let a
                // reaper's message survive onto a SUCCEEDED row.
                errorMessage: data.errorMessage ?? null,
            },
        });
        if (res.count === 0) {
            // The row was already finalized — reaped, or the job row disappeared. Any S3 objects this run
            // uploaded are now unreferenced; the admin orphan sweep owns them, which is why this is a warn
            // and not a delete-on-the-way-out (deleting here would race a concurrent legitimate writer).
            logger.warn(
                { jobId, attempted: data.status },
                'Terminal write skipped — the layout job row was already finalized (reaped or removed)',
            );
        }
    } catch (e) {
        logger.error(
            { jobId, error: e instanceof Error ? e.message : String(e) },
            'Could not persist terminal layout-job row',
        );
    }
}

/** Exported for the delivery-gate spec: the withhold branch below is the only thing between a board KiCad
 *  rejected and a downloadable fab bundle, so it is tested directly rather than through BullMQ. */
/** How often the worker re-reads the cancel flag while a layout runs. */
const ABORT_POLL_MS = 3_000;

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

    // Hoisted so the catch can tell a cancel from a fault: the FLAG is the authority, not whatever the
    // aborted child happened to say on its way down.
    let abortSeen = false;
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
        // The API validated this JSON against LayoutOptionsDto before it was stored, so it is described
        // rather than re-parsed here — but described as the SUBSET this worker reads. `any` let a typo in
        // a field name compile into a silently-ignored option.
        const options = (row.options ?? {}) as Pick<LayoutOptions, 'placer' | 'fabProfile' | 'netCurrentsA'>;

        // CANCELLATION — two mechanisms, because one alone is a lie.
        //
        // The DB flag is the durable request (the API sets it; a restarted worker still sees it). pcb-core
        // checks it between routing attempts, which is where the time actually is. But between attempts can
        // be five minutes away, so the same decision ALSO aborts the in-flight child: a user who presses
        // cancel must not watch freerouting keep burning a worker slot on a job nobody wants.
        //
        // The flag is read on a short interval rather than per-check so a cancel costs at most one extra
        // query per few seconds, never one per checkpoint.
        const canceller = new AbortController();
        let lastPoll = 0;
        const isAborted = async (): Promise<boolean> => {
            if (abortSeen) return true;
            if (Date.now() - lastPoll < ABORT_POLL_MS) return false;
            lastPoll = Date.now();
            const row = await prisma.layoutJob
                .findUnique({ where: { id: jobId }, select: { abortRequested: true } })
                .catch(() => null); // a DB blip must never look like a cancel
            if (!row?.abortRequested) return false;
            abortSeen = true;
            canceller.abort();
            return true;
        };

        const freeroute = makeNativeFreeroutingRunner({ signal: canceller.signal });
        const kicad = makeNativeKicad({ log: logger, signal: canceller.signal });
        // The PRODUCT default is connectivity-aware placement; pcb-core keeps 'grid' as its library default
        // because that is a published npm contract. The two differ on purpose: a library must not change what
        // an existing caller gets on an upgrade, but a customer whose request says nothing about placement is
        // asking for our best board, not our simplest one.
        //
        // Safe by construction rather than by hope: 'auto' is floor-guaranteed — the force-directed pass must
        // beat the grid on wire length AND re-pass eval+parity AND (with a DRC oracle) route clean, or the grid
        // board is delivered unchanged. The worst case is the old behaviour plus one extra placement attempt,
        // and `delivery.placement` records which engine the shipped board actually used either way.
        const placer: 'grid' | 'auto' | 'rust' = options.placer ?? 'auto';
        const rustPlace =
            placer === 'rust'
                ? makeRustPlacementRunner({ binary: config.RUST_PLACER_PATH, timeoutMs: config.RUST_PLACER_TIMEOUT_MS })
                : undefined;

        const q = await layoutCircuit(circuit, {
            router: 'quality',
            freeroute,
            notaryDrc: kicad.notaryDrc,
            fabProfile: options.fabProfile,
            netCurrentsA: options.netCurrentsA,
            placer,
            rustPlace,
            routingMarginMm: config.PCB_ROUTING_MARGIN_MM,
            isAborted,
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
        const geo = shapeLayoutResult(q.evaluated, { namesById: q.namesById, expectations: q.expectations });
        const parsed = parseDrcReport(await kicad.drcReport(q.outputs.kicadPcb, q.outputs.kicadPro));
        const checks = drcToChecks(parsed);
        const { airwires } = airwiresFromDrc(parsed, geo);
        const verdict = assessManufacturability(parsed);

        // Inspection payload — always delivered, and with a UNIFORM shape across both outcomes so consumers
        // never special-case the blob: the 2D geometry + categorized checks + airwires are the diagnostic
        // view, and notManufacturableReason is null exactly when manufacturable is true.
        const inspection = {
            layout: geo as unknown as Prisma.InputJsonValue,
            // How the delivered copper joins to a simulation of the same circuit. LayoutGeometry names a
            // net ("VCC"); a simulation names a node ("x_vcc"); the two meet only at the net id, which
            // neither artefact carries. Shipping the pair is what lets a client show a measured value on
            // the right piece of copper instead of on a plausible one.
            netIdentity: {
                nameById: q.netNameById,
                spiceNodeById: q.spiceNodeByNetId,
            } as unknown as Prisma.InputJsonValue,
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
            // Everything the pipeline had to SAY about this board. Warnings do not affect `ok`, so until now
            // they were persisted only on the FAILED path — meaning a delivered board never told its owner
            // that a net routed narrower than its IPC-2221 target, that a stated current was refused, or
            // that a fab-profile override was raised. None of those are visible anywhere else: the DRC
            // checks are rule violations, and KiCad cannot flag an under-width net because the board carries
            // a single global minimum width that the trace meets. Same key as the FAILED path, so
            // `result.diagnostics` is uniform across all three result shapes.
            diagnostics: q.diagnostics as unknown as Prisma.InputJsonValue,
            // Scope disclosure for the layout verdict: what this endpoint checked (connectivity/DRC/
            // manufacturability) — decoupling/polarity are the electrical endpoint's concern, absent here.
            scope: buildLayoutScope({
                parityPins: { checked: q.parity.checkedPins, expected: q.parity.expectedPins },
                // Straight from the delivery record, so the manifest cannot disagree with the field beside
                // it about whether the router ever judged this board.
                routing: q.delivery.routing,
                drcClean: parsed.clean,
                drcViolations: parsed.violations.length,
                drcWarnings: parsed.warnings.length,
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
        // A CANCEL IS NOT A FAILURE. pcb-core throws LayoutAbortedError at a checkpoint, and aborting the
        // child makes its own runner throw too — both mean "you asked us to stop", and recording either as
        // FAILED would put a fault in the operational record for a job the user ended deliberately. The
        // flag is the authority, not the error text: whatever the child happened to say on the way down,
        // if we asked for the abort then this is a cancel.
        if (abortSeen) {
            logger.info({ jobId }, 'Layout job canceled on request');
            await finish(jobId, { status: 'CANCELED' });
            return;
        }
        logger.error({ jobId, error: e instanceof Error ? e.message : String(e) }, 'Layout job threw');
        await finish(jobId, {
            status: 'FAILED',
            errorMessage: (e instanceof Error ? e.message : String(e)).slice(0, 500),
        });
    }
}
