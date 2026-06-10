// Generic single-circuit ngspice runner for the audit agents.
//   node scripts/sim-run.mjs <spec.json>
// spec.json: { "name": str, "circuit": CircuitJson, "analysis": AnalysisConfig, "probes"?: string[] }
// Runs resolveGenericModels -> generateNetlist -> ngspice -b -> parse. Series labels come from the EMITTED
// wrdata (extractProbes), so they stay column-aligned even when a probe is dropped/rewritten. Prints JSON:
// { name, ok, exit, rows, series:[{name,min,max,pp,final}], errors, truncated, netlist }.
import { generateNetlist, parseSimulationOutput, parseSpiceValue, resolveGenericModels, extractProbes } from '../packages/eda-core/dist/index.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NG = process.env.NGSPICE_PATH || 'C:/ProgramData/chocolatey/lib/ngspice/tools/Spice64/bin/ngspice_con.exe'; // CONSOLE build — the choco-shim ngspice.exe is the GUI build: it writes NO log in -b mode (silent empty) and zombies on hangs
const spec = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
const { name = 'unnamed', circuit, analysis, probes } = spec;
const rep = { name, ok: false, exit: null, rows: 0, series: [], errors: [], truncated: false, netlist: '' };

let netlist;
try {
    const extra = resolveGenericModels(circuit);
    if (extra.length) circuit.models = [...(circuit.models ?? []), ...extra];
    netlist = generateNetlist(circuit, analysis, probes ? { probes } : undefined);
    rep.netlist = netlist;
} catch (e) {
    rep.errors.push(`generateNetlist: ${e instanceof Error ? e.message : String(e)}`);
    console.log(JSON.stringify(rep, null, 2));
    process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'cf-sr-'));
try {
    writeFileSync(join(dir, 'c.cir'), netlist);
    const r = spawnSync(NG, ['-b', '-o', 'log.txt', 'c.cir'], { cwd: dir, encoding: 'utf-8', timeout: 30000 });
    rep.exit = r.status;
    const log = (() => { try { return readFileSync(join(dir, 'log.txt'), 'utf-8'); } catch { return ''; } })();
    for (const l of ((r.stderr || '') + '\n' + log).split('\n').map((s) => s.trim()))
        if (/singular matrix|no convergence|Timestep too small|Unable to find|fatal|aborted|no such|no output/i.test(l)) rep.errors.push(l);
    let csv = '';
    try { csv = readFileSync(join(dir, 'output.csv'), 'utf-8'); } catch { /* none */ }
    if (!csv.trim()) { rep.errors.push('no output.csv'); console.log(JSON.stringify(rep, null, 2)); process.exit(1); }
    const names = extractProbes(netlist);
    const res = parseSimulationOutput(csv, names.length ? names : (probes || ['v(out)']), analysis.type);
    rep.rows = res.meta.pointsCount;
    rep.series = res.series.map((s) => {
        const ys = s.points.map((p) => p.y).filter(Number.isFinite);
        const round = (n) => Number.isFinite(n) ? Number(n.toPrecision(5)) : null;
        const min = ys.length ? Math.min(...ys) : NaN, max = ys.length ? Math.max(...ys) : NaN;
        return { name: s.name, points: s.points.length, min: round(min), max: round(max), pp: round(max - min), final: round(ys[ys.length - 1]) };
    });
    if (analysis.type === 'tran') {
        const ps = parseSpiceValue(analysis.stopTime); const want = ps.isValid ? ps.value : 0;
        const lastT = Math.max(0, ...res.series.map((s) => (s.points.length ? s.points[s.points.length - 1].x : 0)));
        if (want > 0 && lastT > 0 && lastT < 0.9 * want) { rep.truncated = true; rep.errors.push(`truncated at t=${lastT.toExponential(2)} of ${analysis.stopTime}`); }
    }
    rep.ok = r.status === 0 && rep.rows > 0 && !rep.truncated && rep.errors.length === 0;
    console.log(JSON.stringify(rep, null, 2));
    process.exit(rep.ok ? 0 : 1);
} finally { rmSync(dir, { recursive: true, force: true }); }
