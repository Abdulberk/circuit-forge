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
const { generateNetlist, resolveGenericModels } = eda;
const { runSimulation } = await import(new URL('../apps/worker-sim/dist/simulation/runner.js', import.meta.url));

const gnd = { id: 'gnd', name: 'GND', isGround: true };
const CJ = (comps, nets) => ({ version: '1.0', components: comps, nets });
const V = (id, des, val, a, b) => ({ id, type: 'voltage_source', designator: des, value: val, pins: [{ pinId: '+', netId: a }, { pinId: '-', netId: b }] });
const R = (id, des, val, a, b) => ({ id, type: 'resistor', designator: des, value: val, pins: [{ pinId: '1', netId: a }, { pinId: '2', netId: b }] });
const Cap = (id, des, val, a, b) => ({ id, type: 'capacitor', designator: des, value: val, pins: [{ pinId: '1', netId: a }, { pinId: '2', netId: b }] });

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
console.log(fail === 0 ? '\nRESULT: real runner.ts path GREEN for all 5 analyses' : `\nRESULT: ${fail} FAILED through the real runner`);
process.exit(fail === 0 ? 0 : 1);
