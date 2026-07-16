/**
 * Layout Job Processor — the durable home of the PCB quality pipeline.
 *
 * Mirrors the design worker's contract: an atomic QUEUED→RUNNING claim (optimistic concurrency against the
 * API's enqueue), then it runs pcb-core's `layoutCircuit(router:'quality')` with the NATIVE freerouting +
 * kicad-cli runners injected (proven end-to-end in M3a), shapes the clean frontend contract, uploads the
 * heavy blobs (GLB + Gerbers/BOM/PnP) to S3, and lands a terminal LayoutJob row (the client polls the row;
 * BullMQ is just transport). NEVER throws — every failure is captured onto the row.
 */
import { Job, Worker } from 'bullmq';
import Redis from 'ioredis';
import { Prisma } from '@prisma/client';
import {
    layoutCircuit,
    injectModels,
    shapeLayoutResult,
    parseDrcReport,
    drcToChecks,
    airwiresFromDrc,
} from '@circuit-forge/pcb-core';
import { prisma } from '../prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import { makeNativeFreeroutingRunner } from '../runners/freerouting';
import { makeNativeKicad } from '../runners/kicad';
import { makeRustPlacementRunner } from '../runners/rust-placement';
import { uploadFile } from '../storage/s3';

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
    worker.on('failed', (job, err) => logger.error({ jobId: job?.data.jobId, error: err.message }, 'Layout job failed'));
    worker.on('error', (err) => logger.error({ error: err.message }, 'Layout worker error'));
    logger.info({ queue: config.PCB_QUEUE_NAME, concurrency: config.PCB_CONCURRENCY }, 'Layout worker started');
    return worker;
}

/** Write the terminal LayoutJob row. Best-effort: a failed DB write is logged, not thrown. */
async function finish(
    jobId: string,
    data: { status: 'SUCCEEDED' | 'FAILED' | 'CANCELED'; result?: Prisma.InputJsonValue; glbKey?: string; gerbersKey?: string; errorMessage?: string },
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
        logger.error({ jobId, error: e instanceof Error ? e.message : String(e) }, 'Could not persist terminal layout-job row');
    }
}

async function processLayoutJob(job: Job<LayoutJobPayload>): Promise<void> {
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
        const row = await prisma.layoutJob.findUnique({ where: { id: jobId }, select: { circuit: true, options: true } });
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
        const rustPlace = options.placer === 'rust'
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
            const errs = q.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`).join(' | ');
            logger.warn({ jobId, errs }, 'layoutCircuit not ok');
            await finish(jobId, { status: 'FAILED', errorMessage: (errs || 'layout failed').slice(0, 500), result: { diagnostics: q.diagnostics } as unknown as Prisma.InputJsonValue });
            return;
        }

        // Clean frontend contract + DRC-derived airwires/checks + 3D bodies + GLB.
        const geo = shapeLayoutResult(q.evaluated, { namesById: q.namesById });
        const parsed = parseDrcReport(await kicad.drcReport(q.outputs.kicadPcb, q.outputs.kicadPro));
        const checks = drcToChecks(parsed);
        const { airwires } = airwiresFromDrc(parsed, geo);

        const inj = injectModels(q.outputs.kicadPcb);
        const glb = await kicad.exportGlb(inj.kicadPcb);

        // Heavy blobs → S3 (keys on the row); small metadata → inline result JSON.
        const glbKey = `layouts/${jobId}/board.glb`;
        await uploadFile(glbKey, glb, 'model/gltf-binary');
        const gerbersKey = `layouts/${jobId}/manufacturing.json`;
        await uploadFile(gerbersKey, JSON.stringify({ gerbers: q.outputs.gerbers, bomCsv: q.outputs.bomCsv, pnpCsv: q.outputs.pnpCsv }), 'application/json');

        const result: Prisma.InputJsonValue = {
            layout: geo as unknown as Prisma.InputJsonValue,
            checks: checks as unknown as Prisma.InputJsonValue,
            airwires: airwires as unknown as Prisma.InputJsonValue,
            drcClean: parsed.clean,
            stats: q.stats as unknown as Prisma.InputJsonValue,
            parity: q.parity as unknown as Prisma.InputJsonValue,
            completeness: q.completeness,
            bodies: { injected: inj.injected, unmatched: inj.unmatched.map((u) => u.id) },
            render: { glbKey },
            manufacturing: { gerbersKey },
        };
        await finish(jobId, { status: 'SUCCEEDED', result, glbKey, gerbersKey });
        logger.info({ jobId, ms: Date.now() - t0, traces: q.stats.traces, drcClean: parsed.clean }, 'Layout job succeeded');
    } catch (e) {
        logger.error({ jobId, error: e instanceof Error ? e.message : String(e) }, 'Layout job threw');
        await finish(jobId, { status: 'FAILED', errorMessage: (e instanceof Error ? e.message : String(e)).slice(0, 500) });
    }
}
