// Host-side enqueue + poll for the worker CONTAINER smoke test. Unlike design-queue-live.mjs this boots NO
// in-process worker — the hardened production CONTAINER is the worker. We only (1) insert a QUEUED DesignJob,
// (2) enqueue it onto the 'design' queue (BullMQ job id = row id), (3) poll the row until terminal and assert
// it was VERIFIED. So a green run proves the real production image — read-only root, non-root ngsim, dropped
// caps — actually ran the agentic loop + ngspice and persisted the result. Run from apps/worker-sim:
//   node scripts/enqueue-design.mjs
// Talks to Postgres/Redis on localhost (the published compose ports); the container talks to the same via
// service names. Root .env supplies DATABASE_URL/REDIS_URL (localhost).
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env') });
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const QUEUE = process.env.DESIGN_QUEUE_NAME || 'design';
const POLL_DEADLINE_MS = 300_000;

const prisma = new PrismaClient();
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  PASS' : '  FAIL'} ${msg}`); if (!cond) failures++; };

async function main() {
    let org = await prisma.organization.findFirst({ select: { id: true } });
    if (!org) org = await prisma.organization.create({ data: { name: 'container-smoke' }, select: { id: true } });
    const userId = (await prisma.user.findFirst({ select: { id: true } }))?.id ?? 'container-smoke-user';

    const prompt = 'a voltage divider that outputs 5V from a 10V DC source using two equal resistors; output node "out"';
    const job = await prisma.designJob.create({
        data: { orgId: org.id, userId, status: 'QUEUED', prompt, maxRounds: 2 },
        select: { id: true },
    });
    console.log(`enqueue-only: designJob=${job.id} (the CONTAINER is the worker) org=${org.id}`);

    const queue = new Queue(QUEUE, { connection: { url: REDIS_URL } });
    await queue.add('design', { jobId: job.id, userId, prompt, maxRounds: 2 }, { jobId: job.id });
    const t0 = Date.now();
    console.log('enqueued — waiting for the CONTAINERIZED worker to process it...');

    let row;
    while (Date.now() - t0 < POLL_DEADLINE_MS) {
        row = await prisma.designJob.findUnique({ where: { id: job.id } });
        if (row && ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(row.status)) break;
        await new Promise((r) => setTimeout(r, 2000));
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`final status: ${row?.status}  (${elapsed}s)`);
    if (row?.errorMessage) console.log(`errorMessage: ${row.errorMessage}`);

    const res = row?.result;
    ok(row?.status === 'SUCCEEDED', `container processed the job → SUCCEEDED (got ${row?.status})`);
    ok(row?.startedAt != null, 'startedAt stamped (container worker claimed it)');
    ok(res && typeof res === 'object', 'result persisted by the container');
    if (res && typeof res === 'object') {
        ok((res.circuit?.components?.length ?? 0) >= 3, `circuit generated (${res.circuit?.components?.length} components)`);
        ok(res.simulation?.status === 'SUCCEEDED', `ngspice ran INSIDE the hardened container (sim ${res.simulation?.status})`);
        ok(res.ok === true, `verified design (ok=${res.ok}, verified=${res.verified})`);
    }

    await queue.close();
    await prisma.$disconnect();
    console.log(`\n${failures === 0 ? 'CONTAINER SMOKE: ALL CHECKS PASSED' : `CONTAINER SMOKE: ${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error('enqueue-design crashed:', e); try { await prisma.$disconnect(); } catch { /* ignore */ } process.exit(1); });
