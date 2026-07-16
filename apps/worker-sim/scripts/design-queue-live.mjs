// LIVE proof of the design-loop-to-worker migration (stages i–iv), end to end, NO mocks:
//   enqueue a DesignJob onto the 'design' queue  →  the REAL design worker (booted in-process here) runs the
//   REAL agentic loop (real Claude generate → real ngspice simulate → optional AI-fix round → optional MC
//   yield)  →  it persists a terminal DesignJob row  →  we poll that row and assert the outcome.
//
// This mirrors EXACTLY what DesignJobService.create does (insert QUEUED row + queue.add), so it exercises the
// queue payload contract, createDesignWorker/processDesignJob, makeLocalSim (local ngspice, no re-enqueue),
// the noop grounding, and the terminal-row write — the whole new path.
//
// Run from apps/worker-sim (so @prisma/client + bullmq + the worker dist resolve):
//   pnpm --filter "@circuitforge/worker-sim..." build && node apps/worker-sim/scripts/design-queue-live.mjs
// Requires Docker infra up (Postgres/Redis) + root .env (LLM_API_KEY, NGSPICE_PATH=ngspice_con.exe). config.ts
// auto-loads the root .env; SIM_SANDBOX auto-resolves to 'none' off Linux.
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load the monorepo root .env BEFORE constructing Prisma / reading env (the worker's own config.ts also
// loads it, but only when imported later — our top-level code runs first). Root is three dirs up from here.
const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
dotenv.config({ path: rootEnv });

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const QUEUE = process.env.DESIGN_QUEUE_NAME || 'design';
const POLL_DEADLINE_MS = 300_000;

// SMOKE mode (DESIGN_SMOKE=1): the CHEAP first-credit wiring check — N=2/K=1, scenario A only (skip the
// heavier B/C/D and the full N=4). Spend the first real credit confirming the multi-candidate fan-out is
// wired, BEFORE the full N=4 run. Must set the env BEFORE the worker dist is imported (config.ts reads it at
// module load), so it lives here at top level — the dynamic import in main() runs afterwards.
const SMOKE = process.env.DESIGN_SMOKE === '1' || process.env.DESIGN_SMOKE === 'true';
if (SMOKE) {
    process.env.DESIGN_CANDIDATES_N = process.env.DESIGN_CANDIDATES_N || '2';
    process.env.DESIGN_FINALISTS_K = process.env.DESIGN_FINALISTS_K || '1';
}
const CANDIDATES_N = Number(process.env.DESIGN_CANDIDATES_N) || 1;

/** Preflight the LLM provider with ONE trivial max_tokens=1 call so a down/misconfigured provider fails FAST
 *  with a precise reason — instead of burning the wait on a job that 300s-times-out after its first real LLM
 *  call. Spends exactly one tiny request (negligible) as liveness insurance. Aborts the whole run on failure. */
async function preflightLlm() {
    // Protocol-aware: match the wire format the worker will use (LLM_PROTOCOL). 'openai' → chat-completions
    // with x-api-key; else Anthropic /v1/messages. A hardcoded Anthropic preflight falsely aborts an
    // OpenAI-only gateway (e.g. asvae) at /v1/messages → 404.
    const protocol = (process.env.LLM_PROTOCOL || 'anthropic').toLowerCase();
    const isOpenAI = protocol === 'openai';
    const base = (process.env.LLM_BASE_URL || 'https://api.zentio.dev').replace(/\/$/, '');
    const model = process.env.LLM_MODEL || (isOpenAI ? 'gpt-5.6-sol' : 'claude-sonnet-4-6');
    const ua = process.env.LLM_USER_AGENT || 'circuit-forge/1.0';
    const key = process.env.LLM_API_KEY || '';
    const url = isOpenAI ? `${base}/chat/completions` : `${base}/v1/messages`;
    console.log(`\n  preflight: POST ${url}  (protocol=${protocol}, model=${model}) …`);
    let r;
    try {
        r = await fetch(url, {
            method: 'POST',
            headers: isOpenAI
                ? { 'content-type': 'application/json', 'x-api-key': key, authorization: `Bearer ${key}`, 'User-Agent': ua }
                : { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'User-Agent': ua },
            body: isOpenAI
                ? JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })
                : JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        });
    } catch (e) {
        console.error(`\n  ✗ provider UNREACHABLE (${e.message}). Aborting BEFORE spending the design run.\n`);
        process.exit(2);
    }
    if (!r.ok) {
        const body = await r.text().catch(() => '');
        console.error(
            `\n  ✗ provider NOT live: HTTP ${r.status}. ${body.slice(0, 300)}\n` +
            `    (401/403 = key/subscription; 400 'credit' = out of balance; 404 = model not on this plan)\n` +
            `    Fix the provider/key/model and re-run — NOT spending the design run.\n`,
        );
        process.exit(2);
    }
    console.log(`  ✓ provider live (HTTP 200) — proceeding\n`);
}

const prisma = new PrismaClient();
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗ FAIL:'} ${msg}`); if (!cond) failures++; };

/** Enqueue one design job, wait for the terminal row, and assert. `expectYield` requires the live
 *  Monte-Carlo yield pass to have run (worker-local createMonteCarloJob → runMonteCarloBatch). */
async function runScenario(label, { orgId, userId, prompt, queue, expectYield }) {
    const job = await prisma.designJob.create({
        data: { orgId, userId, status: 'QUEUED', prompt, maxRounds: 2 },
        select: { id: true },
    });
    console.log(`\n── ${label} ──\n  designJob=${job.id}\n  prompt="${prompt.slice(0, 80)}..."`);
    await queue.add('design', { jobId: job.id, userId, prompt, maxRounds: 2 }, { jobId: job.id });
    const t0 = Date.now();

    let row;
    while (Date.now() - t0 < POLL_DEADLINE_MS) {
        row = await prisma.designJob.findUnique({ where: { id: job.id } });
        if (row && ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(row.status)) break;
        await new Promise((r) => setTimeout(r, 2000));
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  final status: ${row?.status}  (${elapsed}s)`);
    if (row?.errorMessage) console.log(`  errorMessage: ${row.errorMessage}`);

    const res = row?.result;
    ok(row?.status === 'SUCCEEDED', `${label}: terminal status SUCCEEDED (got ${row?.status})`);
    ok(row?.startedAt != null, `${label}: startedAt stamped (worker set RUNNING)`);
    ok(row?.finishedAt != null, `${label}: finishedAt stamped`);
    ok(res && typeof res === 'object', `${label}: result object persisted`);
    if (res && typeof res === 'object') {
        const compCount = res.circuit?.components?.length ?? 0;
        ok(compCount >= 3, `${label}: circuit has components (${compCount})`);
        ok(Array.isArray(res.history) && res.history.length >= 1, `${label}: history ≥1 round (${res.history?.length})`);
        ok(res.simulation?.status === 'SUCCEEDED', `${label}: local-ngspice sim SUCCEEDED (${res.simulation?.status})`);
        ok(res.ok === true, `${label}: result.ok === true — VERIFIED (ok=${res.ok}, verified=${res.verified})`);
        if (Array.isArray(res.assertions)) {
            const passed = res.assertions.filter((a) => a.pass).length;
            console.log(`  [info] acceptance: ${passed}/${res.assertions.length} criteria passed`);
        }
        if (expectYield) {
            const y = res.yield;
            ok(y && typeof y.evaluated === 'number' && y.evaluated > 0,
                `${label}: live Monte-Carlo yield ran (evaluated=${y?.evaluated}, yield=${y?.yield}, ci95=${JSON.stringify(y?.ci95)})`);
        } else if (res.yield) {
            console.log(`  [info] yield (unexpected but fine): ${JSON.stringify(res.yield).slice(0, 140)}`);
        }
        // Multi-candidate fan-out proof (the headline feature): when N>1, the result MUST carry the
        // candidates envelope + series-free alternatives — otherwise N silently fell back to 1 (e.g. all
        // screens failed) and we'd be "passing" without ever exercising the fan-out. Hard-assert it here
        // rather than eyeballing the "multi-candidate design complete" log line.
        if (CANDIDATES_N > 1) {
            const c = res.candidates;
            ok(c && c.generated >= 2, `${label}: multi-candidate fan-out ran (screened=${c?.generated}, want ≥2 — NOT a silent N=1 fallback)`);
            ok(c && c.finalists >= 1, `${label}: ≥1 finalist ran the full seeded loop (finalists=${c?.finalists})`);
            ok(Array.isArray(res.alternatives), `${label}: alternatives[] present as series-free summaries (len=${res.alternatives?.length})`);
            console.log(`  [info] multi-candidate: generated=${c?.generated} finalists=${c?.finalists} llmCalls=${c?.llmCalls}`);
        } else {
            console.log(`  [info] N=1 (dark default) — single design loop; set DESIGN_CANDIDATES_N>1 to exercise the fan-out`);
        }
    }
    return row;
}

/** A hand-built toleranced 10V→5V divider (two 1k ±5% resistors) so the MC variant draw has something to
 *  perturb regardless of LLM output. */
const TOL_DIVIDER = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 10', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', tolerance: 0.05, pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '1k', tolerance: 0.05, pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: 'gnd', name: 'gnd', isGround: true }],
};

/** Drive the worker-local Monte-Carlo surface directly with REAL ngspice. `evaluated` counts variants that
 *  produced measurements (independent of whether the criterion passes), so it's a robust proof the N
 *  perturbed ngspice runs actually executed through makeLocalSim → runMonteCarloBatch. */
async function checkLocalMonteCarlo() {
    console.log(`\n── B: worker-local Monte-Carlo yield (direct, real ngspice) ──`);
    const { makeLocalSim } = await import('../dist/design/local-sim.js');
    const sim = makeLocalSim();
    const criteria = [{ probe: 'out', metric: 'final', op: 'approx', value: 5, tol: 0.5 }];
    const { jobId } = await sim.createMonteCarloJob(TOL_DIVIDER, { type: 'op' }, criteria, { n: 30, seed: 1 }, 'e2e');
    const status = await sim.getStatus(jobId, 'e2e');
    const mc = status.metrics?.monteCarlo;
    console.log(`  MC: status=${status.status} evaluated=${mc?.evaluated} yield=${mc?.yield} ci95=${JSON.stringify(mc?.ci95)}`);
    ok(status.status === 'SUCCEEDED', `B: MC job SUCCEEDED (got ${status.status})`);
    ok(mc && mc.evaluated > 0, `B: real ngspice evaluated >0 perturbed variants (got ${mc?.evaluated})`);
    ok(mc && typeof mc.yield === 'number' && mc.yield >= 0 && mc.yield <= 1, `B: yield is a valid fraction (${mc?.yield})`);
    ok(mc && mc.ci95 && typeof mc.ci95.low === 'number' && typeof mc.ci95.high === 'number', `B: Wilson 95% CI present (${JSON.stringify(mc?.ci95)})`);
}

/** Prove the LIVE cooperative-cancel path through the real worker: a job whose abortRequested is set while
 *  QUEUED is CLAIMED (QUEUED→RUNNING), then the loop's first checkAbort (before any LLM/sim call) throws
 *  DesignAbortedError → the worker lands a terminal CANCELED row with NO result and NO LLM spend. */
async function runCancelScenario({ orgId, userId, queue }) {
    console.log(`\n── C: live cooperative cancel (abort before the first LLM call) ──`);
    const prompt = 'an op-amp inverting amplifier with gain -10 (this design must be CANCELED before it runs)';
    const job = await prisma.designJob.create({
        data: { orgId, userId, status: 'QUEUED', prompt, maxRounds: 2, abortRequested: true },
        select: { id: true },
    });
    console.log(`  designJob=${job.id} (abortRequested preset)`);
    await queue.add('design', { jobId: job.id, userId, prompt, maxRounds: 2 }, { jobId: job.id });
    const t0 = Date.now();
    let row;
    while (Date.now() - t0 < 60_000) {
        row = await prisma.designJob.findUnique({ where: { id: job.id } });
        if (row && ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(row.status)) break;
        await new Promise((r) => setTimeout(r, 1000));
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  final status: ${row?.status}  (${elapsed}s)`);
    ok(row?.status === 'CANCELED', `C: terminal status CANCELED (got ${row?.status})`);
    ok(row?.result == null, `C: no result persisted (cancel fired before generation; got ${row?.result == null ? 'null' : 'a result'})`);
    ok(row?.finishedAt != null, 'C: finishedAt stamped');
}

/** Prove the LIVE orphan reaper: a QUEUED row that was never enqueued (insert↔enqueue crash gap) is found
 *  by a real sweep — queue.getJob(rowId) returns null → reconciled to FAILED. Real Prisma + real BullMQ. */
async function runReaperScenario({ orgId, userId, queue }) {
    console.log(`\n── D: live orphan reaper (QUEUED row never enqueued → swept to FAILED) ──`);
    const { reapStaleDesignJobs } = await import('../dist/design/reaper.js');
    const orphan = await prisma.designJob.create({
        data: { orgId, userId, status: 'QUEUED', prompt: 'orphaned divider (never enqueued — must be reaped)', maxRounds: 2 },
        select: { id: true },
    });
    console.log(`  orphan designJob=${orphan.id} (inserted, NOT enqueued)`);

    const res = await reapStaleDesignJobs({
        prisma,
        queue, // the same 'design' queue — getJob(orphan.id) is null (it was never added)
        nowMs: Date.now(),
        graceMs: 0, // examine immediately
        runningDeadlineMs: 1_800_000,
        log: { info: () => {}, warn: () => {} },
    });
    console.log(`  sweep: examined=${res.examined} reaped=${res.reaped}`);

    const row = await prisma.designJob.findUnique({ where: { id: orphan.id } });
    ok(row?.status === 'FAILED', `D: the orphan was reaped to FAILED (got ${row?.status})`);
    ok(/orphaned before/i.test(row?.errorMessage ?? ''), `D: failure reason explains the orphan ("${row?.errorMessage}")`);
    ok(row?.finishedAt != null, 'D: finishedAt stamped by the reaper');
    ok(res.reaped >= 1, `D: sweep reported ≥1 reaped (${res.reaped})`);
}

async function main() {
    ok(!!process.env.LLM_API_KEY, 'LLM_API_KEY present (the worker can run the loop)');
    console.log(`  ngspice: ${process.env.NGSPICE_PATH}`);
    console.log(`  model:   ${process.env.LLM_MODEL}`);
    console.log(`  queue:   ${QUEUE}`);
    console.log(`  mode:    ${SMOKE ? 'SMOKE (scenario A only)' : 'FULL (A–D)'}  N=${process.env.DESIGN_CANDIDATES_N ?? 1} K=${process.env.DESIGN_FINALISTS_K ?? 2}`);

    // Fail FAST on a down/misconfigured provider so the first real credit isn't burned on a 300s job timeout.
    await preflightLlm();

    // A valid org (DesignJob.orgId is a FK to Organization) + any userId (no FK).
    let org = await prisma.organization.findFirst({ select: { id: true } });
    if (!org) org = await prisma.organization.create({ data: { name: 'design-e2e' }, select: { id: true } });
    const userId = (await prisma.user.findFirst({ select: { id: true } }))?.id ?? 'design-e2e-user';
    console.log(`  org=${org.id}  user=${userId}`);

    // Boot the REAL design worker in-process (consumes 'design' with real ngspice + LLM) + a producer queue.
    const { createDesignWorker } = await import('../dist/design/processor.js');
    const worker = createDesignWorker();
    const queue = new Queue(QUEUE, { connection: { url: REDIS_URL } });

    // Scenario A — the full QUEUE path: a DC divider enqueued → worker → verified. With DESIGN_CANDIDATES_N>1
    // this also exercises (and now HARD-ASSERTS) the multi-candidate fan-out: screen N → selectFinalists →
    // seeded full-loop → winner-only MC, with the candidates envelope + alternatives[] on the result.
    await runScenario('A: DC divider (full queue path → verify)', {
        orgId: org.id, userId, queue,
        prompt: 'a voltage divider that outputs 5V from a 10V DC source using two equal resistors; the output node is named "out"',
    });

    // SMOKE: stop after scenario A — the cheap first-credit wiring check is done. Run the full suite (and the
    // full N=4) once the smoke run is green.
    if (SMOKE) {
        await worker.close();
        await queue.close();
        await prisma.$disconnect();
        console.log(`\n${failures === 0 ? 'SMOKE PASSED — multi-candidate wiring is live; now run FULL (drop DESIGN_SMOKE, set N=4)' : `${failures} SMOKE CHECK(S) FAILED`}`);
        process.exit(failures === 0 ? 0 : 1);
    }

    // Scenario B — the worker-local Monte-Carlo YIELD surface, the OTHER half of makeLocalSim, exercised
    // DETERMINISTICALLY with real ngspice (a hand-built toleranced divider, not an LLM that may omit the
    // tolerance field). This is exactly the call the loop makes when a verified design has toleranced parts:
    // deps.runSim.createMonteCarloJob → runMonteCarloBatch → N perturbed ngspice variants → status.metrics.
    await checkLocalMonteCarlo();

    // Scenario C — the live cooperative-cancel path: a job aborted while queued lands CANCELED, no LLM spend.
    await runCancelScenario({ orgId: org.id, userId, queue });

    // Scenario D — the live ORPHAN REAPER: insert a QUEUED row WITHOUT enqueuing (exactly the insert↔enqueue
    // crash gap), then run a real reaper sweep (real Prisma + real BullMQ getJob, which returns null for a
    // never-enqueued id) and assert the orphan is reconciled to FAILED.
    await runReaperScenario({ orgId: org.id, userId, queue });

    await worker.close();
    await queue.close();
    await prisma.$disconnect();
    console.log(`\n${failures === 0 ? 'ALL LIVE DESIGN-QUEUE CHECKS PASSED' : `${failures} LIVE CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
    console.error('design-queue live proof crashed:', e);
    try { await prisma.$disconnect(); } catch { /* ignore */ }
    process.exit(1);
});
