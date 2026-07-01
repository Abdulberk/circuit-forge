/**
 * Full-stack e2e dry-run / staging smoke test.
 *
 * Drives the REAL public HTTP journey against a RUNNING deployment — register → org → project → version →
 * simulate → poll-to-terminal → fetch result — then exercises the verify-design worst-case robustness option.
 * This is the top of the test pyramid: it catches INTEGRATION-SEAM bugs that unit/spec suites can't (real
 * queue → worker → ngspice round-trip, real payload normalization). It was born from a dry-run that caught a
 * bare-net-id-probe bug (fix d2c517f) that every unit test missed because no test drove the full wired path.
 *
 * It does NOT start the services (that is the deploy's job) — point it at any environment and it verifies that
 * deployment end-to-end. Bring the stack up first, e.g. locally:
 *     docker compose up -d postgres redis minio          # infra (or `docker compose up -d`)
 *     pnpm --filter api build && node apps/api/dist/main.js        # API on :3001 (loads root .env)
 *     pnpm --filter worker-sim build && node apps/worker-sim/dist/main.js   # a worker to consume the queue
 * then:  BASE_URL=http://localhost:3001 node scripts/e2e-dry-run.mjs   (BASE_URL defaults to localhost:3001)
 *
 * Exit codes: 0 = all steps green · 1 = a step failed (a real defect) · 2 = the stack isn't reachable (preflight).
 * HTTP-only (no DB access): it leaves a little smoke data behind — harmless in dev/staging.
 */
const BASE = process.env.BASE_URL || 'http://localhost:3001';
let token = '';
const H = () => ({ 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) });
const body = (o) => JSON.stringify(o);
const jf = async (path, init) => { const r = await fetch(`${BASE}${path}`, init); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, d }; };
let fail = 0;
const must = (name, ok, detail) => { if (!ok) fail++; console.log(`${ok ? '✅' : '❌'}  ${name}${detail ? ' — ' + detail : ''}`); };

const rcFilter = {
    version: '1.0',
    components: [
        { id: 'V1', type: 'voltage_source', designator: 'V1', value: 'SIN(0 1 1k)', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: '0' }] },
        { id: 'R1', type: 'resistor', designator: 'R1', value: '1.6k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'C1', type: 'capacitor', designator: 'C1', value: '100n', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: '0' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: '0', name: '0', isGround: true }],
};
// A toleranced divider (±10%, out = 5·R2/(R1+R2) = 2.5V nominal) for the worst-case corner robustness checks.
const divider = {
    version: '1.0',
    components: [
        { id: 'V1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: '0' }] },
        { id: 'R1', type: 'resistor', designator: 'R1', value: '1k', tolerance: 0.1, pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'R2', type: 'resistor', designator: 'R2', value: '1k', tolerance: 0.1, pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: '0' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: '0', name: '0', isGround: true }],
};

const poll = async (path, done, timeoutMs = 60000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const { d } = await jf(path, { headers: H() });
        if (done(d)) return d;
        await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
};

// ── Preflight: is the stack reachable? (distinct exit code so CI/ops can tell "down" from "bug") ──
try {
    const h = await jf('/health');
    if (h.status !== 200) throw new Error(`/health returned ${h.status}`);
} catch (e) {
    console.error(`🔌 Stack not reachable at ${BASE} (${e instanceof Error ? e.message : e}).\n   Bring up infra + API + a worker first (see this file's header), then re-run.`);
    process.exit(2);
}
const ready = await jf('/health/ready');
must('readiness: DB+Redis+S3 reachable', ready.d?.status === 'ok', `checks=${JSON.stringify(ready.d?.checks && Object.fromEntries(Object.entries(ready.d.checks).map(([k, v]) => [k, v.status])))}`);

// ── The core journey ──
const reg = await jf('/auth/register', { method: 'POST', headers: H(), body: body({ email: `e2e-dryrun-${Date.now()}@test.com`, password: 'SecurePassword123!', name: 'E2E Dry Run' }) });
token = reg.d?.accessToken;
must('register → token', !!token, reg.d?.user?.email);

const org = await jf('/orgs', { method: 'POST', headers: H(), body: body({ name: 'E2E Dry Run Org' }) });
must('create org', !!org.d?.id);

const proj = await jf(`/orgs/${org.d?.id}/projects`, { method: 'POST', headers: H(), body: body({ name: 'RC filter', description: 'e2e dry-run' }) });
must('create project', !!proj.d?.id);

const ver = await jf(`/projects/${proj.d?.id}/versions`, { method: 'POST', headers: H(), body: body({ circuitJson: rcFilter, uiJson: { layout: 'hierarchical', positions: {} } }) });
must('save version', !!ver.d?.id, `v${ver.d?.versionNumber}`);

// EXPLICIT bare net-id probes — the exact scenario the original dry-run caught (regression guard for d2c517f).
const simq = await jf(`/versions/${ver.d?.id}/simulations`, { method: 'POST', headers: H(), body: body({ analysisConfig: { type: 'tran', stepTime: '10u', stopTime: '5m' }, probes: ['in', 'out'] }) });
must('queue simulation (explicit bare probes)', !!simq.d?.jobId, simq.d?.jobId);

const term = await poll(`/simulations/${simq.d?.jobId}`, (r) => ['SUCCEEDED', 'FAILED', 'TIMED_OUT'].includes(r?.status));
must('worker consumed the job → ngspice → terminal', term?.status === 'SUCCEEDED', `status=${term?.status} (needs a worker running)`);

const res = await jf(`/simulations/${simq.d?.jobId}/result`, { headers: H() });
const seriesCount = res.d?.result?.series?.length ?? res.d?.series?.length ?? 0;
must('sim result round-tripped with series', seriesCount > 0, `series=${seriesCount}`);

// ── verify-design worst-case robustness option (real HTTP → worker corner batch → verdict) ──
const vd = await jf('/verify-design', { method: 'POST', headers: H(), body: body({ circuit: divider, analysisConfig: { type: 'op' }, assertions: [{ probe: 'out', metric: 'final', op: 'approx', value: 2.5, tol: 0.6 }], robustness: { corner: true } }) });
must('verify-design verdict=pass', vd.d?.verdict === 'pass', `verdict=${vd.d?.verdict}`);
must('worst-case corner ran (all 4 ±tol corners)', vd.d?.robustness?.worstCase?.evaluated === 4 && vd.d?.robustness?.worstCase?.passAllCorners === true, `evaluated=${vd.d?.robustness?.worstCase?.evaluated}, passAll=${vd.d?.robustness?.worstCase?.passAllCorners}`);

const vd2 = await jf('/verify-design', { method: 'POST', headers: H(), body: body({ circuit: divider, analysisConfig: { type: 'op' }, assertions: [{ probe: 'out', metric: 'final', op: 'gte', value: 2.45 }], robustness: { corner: true } }) });
const wc2 = vd2.d?.robustness?.worstCase;
must('worst-case finds the failing corner (informational — verdict stays pass)', vd2.d?.verdict === 'pass' && wc2?.passAllCorners === false && wc2?.failed >= 1, `verdict=${vd2.d?.verdict}, passAll=${wc2?.passAllCorners}, worst=${JSON.stringify(wc2?.worstCorners)}`);

console.log(`\n${fail === 0 ? '🟢 E2E DRY-RUN GREEN — full HTTP→queue→worker→result journey + verify-design worst-case verified' : `🔴 ${fail} STEP(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
