// QA: exercise the REAL worker runner (apps/worker-sim runSimulation) — NOT a reimplementation — end-to-end for
// each new analysis, against real ngspice. The jest worker suite mocks runSimulation, and edge-cases.mjs uses
// its own runCell; this is the ONLY test that drives the actual production runner.ts path (sanitize → spawn
// ngspice → read output.csv/stdout.log → the noise/sens/report-only BRANCHES → assemble SimulationResult).
//   node scripts/runner-analyses-check.mjs
// Requires real ngspice (NGSPICE_PATH or the choco console build) + eda-core & worker-sim dist builds.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config (loaded when worker-sim imports) validates these — set dummies BEFORE importing the runner.
process.env.DATABASE_URL ||= 'postgresql://x:x@localhost:5432/x';
process.env.S3_ENDPOINT ||= 'http://localhost:9000';
process.env.S3_ACCESS_KEY ||= 'x';
process.env.S3_SECRET_KEY ||= 'x';
process.env.S3_BUCKET ||= 'x';
process.env.SIM_SANDBOX ||= 'none';
process.env.SIM_TEMP_DIR ||= mkdtempSync(join(tmpdir(), 'cf-runner-'));
process.env.NGSPICE_PATH ||= 'C:/ProgramData/chocolatey/lib/ngspice/tools/Spice64/bin/ngspice_con.exe';

const eda = await import(new URL('../packages/eda-core/dist/index.js', import.meta.url));
const { generateNetlist, resolveGenericModels, summarizeSeries, evaluateAssertions, attachFourierThd, attachTransferFunction } = eda;
const { runSimulation } = await import(new URL('../apps/worker-sim/dist/simulation/runner.js', import.meta.url));
const { runMonteCarloBatch } = await import(new URL('../apps/worker-sim/dist/simulation/montecarlo-runner.js', import.meta.url));
const { runSweepBatch } = await import(new URL('../apps/worker-sim/dist/simulation/sweep-runner.js', import.meta.url));

const gnd = { id: 'gnd', name: 'GND', isGround: true };
const CJ = (comps, nets) => ({ version: '1.0', components: comps, nets });
const V = (id, des, val, a, b) => ({ id, type: 'voltage_source', designator: des, value: val, pins: [{ pinId: '+', netId: a }, { pinId: '-', netId: b }] });
const R = (id, des, val, a, b, tol) => ({ id, type: 'resistor', designator: des, value: val, ...(tol ? { tolerance: tol } : {}), pins: [{ pinId: '1', netId: a }, { pinId: '2', netId: b }] });
const Cap = (id, des, val, a, b, tol) => ({ id, type: 'capacitor', designator: des, value: val, ...(tol ? { tolerance: tol } : {}), pins: [{ pinId: '1', netId: a }, { pinId: '2', netId: b }] });

const rc = CJ([V('v1', 'V1', 'SIN(0 1 1k)', 'in', 'gnd'), R('r1', 'R1', '1k', 'in', 'out'), Cap('c1', 'C1', '1u', 'out', 'gnd')], [{ id: 'in' }, { id: 'out' }, gnd]);
const divider = CJ([V('v1', 'V1', 'DC 5', 'in', 'gnd'), R('r1', 'R1', '1k', 'in', 'out'), R('r2', 'R2', '2k', 'out', 'gnd')], [{ id: 'in' }, { id: 'out' }, gnd]);
const noiseRc = CJ([V('v1', 'V1', 'DC 0 AC 1', 'in', 'gnd'), R('r1', 'R1', '1k', 'in', 'out'), Cap('c1', 'C1', '159n', 'out', 'gnd')], [{ id: 'in' }, { id: 'out' }, gnd]);
const sineR = CJ([V('v1', 'V1', 'SIN(0 5 1k)', 'in', 'gnd'), R('r1', 'R1', '1k', 'in', 'gnd')], [{ id: 'in' }, gnd]);

const cases = [
    { name: 'fourier (tran)', circuit: rc, analysis: { type: 'tran', stopTime: '5m', stepTime: '5u', fourier: { fundamentalFreq: '1k', probes: ['v(out)'] } }, type: 'tran', ok: (r) => (r.result?.fourier?.[0]?.thd ?? -1) >= 0 },
    { name: 'meas (tran)', circuit: sineR, analysis: { type: 'tran', stopTime: '5m', stepTime: '5u', measurements: [{ name: 'vpk', type: 'max', probe: 'v(in)' }] }, type: 'tran', ok: (r) => Number.isFinite(r.result?.measurements?.find((m) => m.name === 'vpk')?.value) },
    { name: 'tf (op)', circuit: divider, analysis: { type: 'op', tf: { output: 'v(out)', inputSource: 'V1' } }, type: 'op', ok: (r) => Math.abs((r.result?.transferFunction?.gain ?? 0) - 2 / 3) < 0.02 },
    { name: 'noise', circuit: noiseRc, analysis: { type: 'noise', output: 'v(out)', inputSource: 'V1', variation: 'dec', points: 10, startFreq: '1', stopFreq: '100k' }, type: 'noise', ok: (r) => r.result?.series?.some((s) => s.name === 'onoise_spectrum') && Number.isFinite(r.result?.noise?.onoiseTotalV) },
    { name: 'sens', circuit: divider, analysis: { type: 'sens', output: 'v(out)' }, type: 'sens', ok: (r) => (r.result?.sensitivity?.entries?.length ?? 0) > 0 },
];

let fail = 0;
for (const tc of cases) {
    const c = JSON.parse(JSON.stringify(tc.circuit));
    const extra = resolveGenericModels(c);
    if (extra.length) c.models = [...(c.models ?? []), ...extra];
    const netlist = generateNetlist(c, tc.analysis);
    let r;
    try {
        r = await runSimulation({ jobId: `qa-${tc.name.replace(/\W+/g, '-')}-${process.pid}`, netlist, probeNames: [], analysisType: tc.type });
    } catch (e) {
        r = { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    const pass = r.success && tc.ok(r);
    if (!pass) fail++;
    const detail = tc.name.startsWith('fourier') ? `thd=${r.result?.fourier?.[0]?.thd}`
        : tc.name.startsWith('tf') ? `gain=${r.result?.transferFunction?.gain}`
        : tc.name.startsWith('noise') ? `onoiseTotal=${r.result?.noise?.onoiseTotalV}, series=${r.result?.series?.map((s) => s.name).join('/')}`
        : tc.name.startsWith('sens') ? `entries=${r.result?.sensitivity?.entries?.length}`
        : `vpk=${r.result?.measurements?.find((m) => m.name === 'vpk')?.value}`;
    console.log(`${pass ? '✅' : '❌'}  ${tc.name}: success=${r.success}, ${detail}${r.error ? ', err=' + r.error : ''}`);
}
// ===== THD VERDICT-GATING: the real verify path (nominal) + robustness MC (robust-THD) =====
const thd1 = { probe: 'v(out)', metric: 'thd', op: 'lt', value: 1 }; // THD < 1%
const fourTran = (stop, step) => ({ type: 'tran', stopTime: stop, stepTime: step, fourier: { fundamentalFreq: '1k', probes: ['v(out)'] } });
const square = CJ([V('v1', 'V1', 'PULSE(-1 1 0 1n 1n 0.5m 1m)', 'out', 'gnd'), R('r1', 'R1', '1k', 'out', 'gnd')], [{ id: 'out' }, gnd]);

// (a) NOMINAL gate — run the REAL sim, fold THD onto measurements, evaluate the criterion (the full verdict path).
async function nominalGate(name, circuit, ana, crit, wantPass) {
    const c = JSON.parse(JSON.stringify(circuit)); const ex = resolveGenericModels(c); if (ex.length) c.models = [...(c.models ?? []), ...ex];
    const r = await runSimulation({ jobId: `thdgate-${name.replace(/\W+/g, '-')}-${process.pid}`, netlist: generateNetlist(c, ana), probeNames: [], analysisType: 'tran' });
    const ms = (r.result?.series ?? []).map((s) => summarizeSeries(s, 'tran'));
    attachFourierThd(ms, r.result?.fourier);
    const res = evaluateAssertions(ms, [crit])[0];
    const ok = r.success && res && res.pass === wantPass;
    if (!ok) fail++;
    console.log(`${ok ? '✅' : '❌'}  nominal THD-gate [${name}]: pass=${res?.pass} (want ${wantPass}), actual=${res?.actual}%`);
}
await nominalGate('square-FAILS-thd<1%', square, fourTran('10m', '2u'), thd1, false); // THD≈42.9% → FAIL
await nominalGate('sine-PASSES-thd<1%', rc, fourTran('5m', '5u'), thd1, true);        // THD≈0.27% → PASS

// (b) ROBUST-THD — the Monte-Carlo per-variant gate. A loose spec yields high; a tight spec the SAME THD misses
//     yields low — proving THD is evaluated PER VARIANT (the composition), not just at nominal.
const tolRc = CJ([V('v1', 'V1', 'SIN(0 1 1k)', 'in', 'gnd'), R('r1', 'R1', '1k', 'in', 'out', 0.05), Cap('c1', 'C1', '1u', 'out', 'gnd', 0.05)], [{ id: 'in' }, { id: 'out' }, gnd]);
async function mcThd(name, crit, wantHighYield) {
    const c = JSON.parse(JSON.stringify(tolRc)); const ex = resolveGenericModels(c); if (ex.length) c.models = [...(c.models ?? []), ...ex];
    const mc = await runMonteCarloBatch({ jobId: `mcthd-${name.replace(/\W+/g, '-')}-${process.pid}`, circuit: c, analysis: fourTran('5m', '5u'), criteria: [crit], n: 15, seed: 1 });
    const ok = mc.evaluated > 0 && (wantHighYield ? mc.yield >= 0.9 : mc.yield <= 0.1);
    if (!ok) fail++;
    console.log(`${ok ? '✅' : '❌'}  robust-THD MC [${name}]: yield=${mc.yield}, evaluated=${mc.evaluated} (want ${wantHighYield ? 'high' : 'low'})`);
}
await mcThd('loose-thd<1%', thd1, true);                  // ~0.27% < 1% across variants → yield high
await mcThd('tight-thd<0.1%', { ...thd1, value: 0.1 }, false); // ~0.27% > 0.1% → THD gated per variant → yield low

// ===== GAIN VERDICT-GATING: a non-inverting op-amp (gain = 1+Rf/Rg = 2), nominal + robust-gain MC =====
const opAna = { type: 'op', tf: { output: 'v(out)', inputSource: 'V1' } };
const opamp = (tol) => CJ([
    V('vin', 'V1', 'DC 0.1', 'in', 'gnd'), V('vcc', 'VCC', 'DC 15', 'vcc', 'gnd'), V('vee', 'VEE', 'DC -15', 'vee', 'gnd'),
    R('rf', 'RF', '10k', 'out', 'fb', tol), R('rg', 'RG', '10k', 'fb', 'gnd', tol),
    { id: 'u1', type: 'subckt', designator: 'U1', model: 'OPAMPGEN', pins: [{ pinId: 'out', netId: 'out' }, { pinId: 'in+', netId: 'in' }, { pinId: 'in-', netId: 'fb' }, { pinId: 'vcc', netId: 'vcc' }, { pinId: 'vee', netId: 'vee' }] },
], [{ id: 'in' }, { id: 'vcc' }, { id: 'vee' }, { id: 'out' }, { id: 'fb' }, gnd]);

async function gainGate(name, crit, wantPass) {
    const c = JSON.parse(JSON.stringify(opamp())); const ex = resolveGenericModels(c); if (ex.length) c.models = [...(c.models ?? []), ...ex];
    const r = await runSimulation({ jobId: `gaingate-${name.replace(/\W+/g, '-')}-${process.pid}`, netlist: generateNetlist(c, opAna), probeNames: [], analysisType: 'op' });
    const ms = (r.result?.series ?? []).map((s) => summarizeSeries(s, 'op'));
    attachTransferFunction(ms, r.result?.transferFunction);
    const res = evaluateAssertions(ms, [crit])[0];
    const ok = r.success && res && res.pass === wantPass;
    if (!ok) fail++;
    console.log(`${ok ? '✅' : '❌'}  nominal gain-gate [${name}]: pass=${res?.pass} (want ${wantPass}), actual=${res?.actual}`);
}
await gainGate('gain>=1.5-PASS', { probe: 'v(out)', metric: 'gain', op: 'gte', value: 1.5 }, true); // ~2 ≥ 1.5
await gainGate('gain>=10-FAIL', { probe: 'v(out)', metric: 'gain', op: 'gte', value: 10 }, false);   // ~2 < 10

async function mcGain(name, crit, wantHigh) {
    const c = JSON.parse(JSON.stringify(opamp(0.05))); const ex = resolveGenericModels(c); if (ex.length) c.models = [...(c.models ?? []), ...ex];
    const mc = await runMonteCarloBatch({ jobId: `mcgain-${name.replace(/\W+/g, '-')}-${process.pid}`, circuit: c, analysis: opAna, criteria: [crit], n: 15, seed: 1 });
    const ok = mc.evaluated > 0 && (wantHigh ? mc.yield >= 0.9 : mc.yield <= 0.1);
    if (!ok) fail++;
    console.log(`${ok ? '✅' : '❌'}  robust-gain MC [${name}]: yield=${mc.yield}, evaluated=${mc.evaluated} (want ${wantHigh ? 'high' : 'low'})`);
}
await mcGain('loose-gain>=1.5', { probe: 'v(out)', metric: 'gain', op: 'gte', value: 1.5 }, true);  // ~2 across variants → high
await mcGain('tight-gain>=10', { probe: 'v(out)', metric: 'gain', op: 'gte', value: 10 }, false);    // ~2 < 10 → gated per variant → low

// ===== PARAMETRIC SWEEP (.step sibling): real ngspice, contiguous passRange over a swept R =====
// divider out = 5·R2/(R1+R2) = 5·2k/(R1+2k). Sweep R1 1k..9k (1k,3k,5k,7k,9k); out≥2V ⇔ R1≤3k → pass at 1k,3k.
{
    const sweep = { designator: 'R1', start: 1000, stop: 9000, points: 5 };
    const crit = { probe: 'v(out)', metric: 'max', op: 'gte', value: 2.0 };
    const sw = await runSweepBatch({ jobId: `sweep-${process.pid}`, circuit: divider, analysis: { type: 'op' }, criteria: [crit], sweep });
    const ok = sw.errored === 0 && sw.evaluated === 5 && sw.passed === 2 && sw.passAll === false
        && sw.passRange?.lo === 1000 && sw.passRange?.hi === 3000;
    if (!ok) fail++;
    console.log(`${ok ? '✅' : '❌'}  parametric sweep [R1 1k..9k, out≥2V]: passed=${sw.passed}/${sw.evaluated}, passRange=${sw.passRange ? `[${sw.passRange.lo},${sw.passRange.hi}]` : 'none'}, passAll=${sw.passAll}, errored=${sw.errored}`);
}

console.log(fail === 0 ? '\nRESULT: real runner path + THD/GAIN verdict-gating + parametric sweep GREEN' : `\nRESULT: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
