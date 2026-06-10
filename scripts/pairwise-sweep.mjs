// Pairwise interaction sweep: every DRIVER block (something that puts a signal on net `link`) crossed with
// every LOAD block (something that consumes `link`), each pair run as a real circuit through the full
// pipeline (resolveGenericModels -> generateNetlist -> ngspice -b -> parse). This attacks the residual risk
// the single-cell coverage matrix can't: cross-device code paths (auto-bridging direction, composite-device
// sub-elements, model dedup across instances, bsource expression node rewriting, probe twin redirects) and
// a hostile-name pass that renames `link` to sanitizer edge-cases ('e' operator, 'in' reserved, '2x' numeric).
//
//   node scripts/pairwise-sweep.mjs            (full sweep; prints grid + every failure's evidence)
//
// PASS = ngspice exit 0, output parsed, every series finite, link series present and (for dynamic drivers)
// genuinely live (pp >= driver.minPP). Convergence failures and dead outputs are FAILURES to triage — each
// is either an engine bug or a block-design bug; neither is ignored.
import { generateNetlist, parseSimulationOutput, resolveGenericModels, extractProbes } from '../packages/eda-core/dist/index.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NG = process.env.NGSPICE_PATH || 'C:/ProgramData/chocolatey/lib/ngspice/tools/Spice64/bin/ngspice_con.exe'; // CONSOLE build — the choco-shim ngspice.exe is the GUI build: it writes NO log in -b mode (silent empty) and zombies on hangs

// ---------- block builders (LINK = the shared net name, varies in the hostile-name pass) ----------
const V = (id, des, val, p, n) => ({ id, type: 'voltage_source', designator: des, value: val, pins: [{ pinId: '+', netId: p }, { pinId: '-', netId: n }] });
const R = (id, des, val, a, b) => ({ id, type: 'resistor', designator: des, value: val, pins: [{ pinId: '1', netId: a }, { pinId: '2', netId: b }] });
const C = (id, des, val, a, b) => ({ id, type: 'capacitor', designator: des, value: val, pins: [{ pinId: '1', netId: a }, { pinId: '2', netId: b }] });
const L = (id, des, val, a, b) => ({ id, type: 'inductor', designator: des, value: val, pins: [{ pinId: '1', netId: a }, { pinId: '2', netId: b }] });

// Each driver: { name, build(LINK) -> {components, nets}, tran:{stopTime,stepTime}, minPP } (minPP=0 -> finite-only)
const DRIVERS = [
  { name: 'vsin', tran: { stopTime: '1m', stepTime: '1u' }, minPP: 2, build: (LK) => ({
      components: [V('dv1', 'V1', 'SIN(0 2 10k)', 'dsrc', '0'), R('dr1', 'R1', '100', 'dsrc', LK)], nets: ['dsrc'] }) },
  { name: 'vpulse', tran: { stopTime: '1m', stepTime: '500n' }, minPP: 3, build: (LK) => ({
      components: [V('dv1', 'V1', 'PULSE(0 5 0 1u 1u 40u 100u)', 'dsrc', '0'), R('dr1', 'R1', '100', 'dsrc', LK)], nets: ['dsrc'] }) },
  { name: 'opamp-buf', tran: { stopTime: '1m', stepTime: '1u' }, minPP: 3, build: (LK) => ({
      components: [V('dvp', 'VP1', 'DC 12', 'vp', '0'), V('dvn', 'VN1', 'DC -12', 'vn', '0'), V('dvs', 'VS1', 'SIN(0 2 5k)', 'dsig', '0'),
        { id: 'du1', type: 'subckt', designator: 'U1', model: 'OPAMPGEN', pins: [{ pinId: 'out', netId: LK }, { pinId: 'in+', netId: 'dsig' }, { pinId: 'in-', netId: LK }, { pinId: 'vcc', netId: 'vp' }, { pinId: 'vee', netId: 'vn' }] }],
      nets: ['vp', 'vn', 'dsig'] }) },
  { name: 'gate-out', tran: { stopTime: '100u', stepTime: '50n' }, minPP: 3, build: (LK) => ({
      components: [V('dvd', 'VD1', 'DC 5', 'dvdd', '0'), V('dva', 'VA1', 'PULSE(0 5 0 10n 10n 5u 10u)', 'da', '0'), V('dvb', 'VB1', 'PULSE(0 5 0 10n 10n 10u 20u)', 'db', '0'),
        { id: 'dg1', type: 'logic_and', designator: 'XG1', pins: [{ pinId: 'in1', netId: 'da' }, { pinId: 'in2', netId: 'db' }, { pinId: 'out', netId: LK }] }],
      nets: ['dvdd', 'da', 'db'] }) },
  { name: 'dff-q', tran: { stopTime: '100u', stepTime: '50n' }, minPP: 3, build: (LK) => ({
      components: [V('dvd', 'VD1', 'DC 5', 'dvdd', '0'), V('dck', 'VC1', 'PULSE(0 5 0 10n 10n 2.5u 5u)', 'dclk', '0'),
        { id: 'dff1', type: 'dff', designator: 'U1', pins: [{ pinId: 'd', netId: 'dqb' }, { pinId: 'clk', netId: 'dclk' }, { pinId: 'q', netId: LK }, { pinId: 'qb', netId: 'dqb' }] }],
      nets: ['dvdd', 'dclk', 'dqb'] }) },
  { name: 'bjt-ce', tran: { stopTime: '1m', stepTime: '1u' }, minPP: 0.15, build: (LK) => ({
      components: [V('dvc', 'VC1', 'DC 10', 'dvcc', '0'), R('drb1', 'RB1', '68k', 'dvcc', 'dbase'), R('drb2', 'RB2', '12k', 'dbase', '0'),
        R('drc', 'RC1', '1k', 'dvcc', LK), R('dre', 'RE1', '220', 'dem', '0'),
        { id: 'dq1', type: 'bjt', designator: 'Q1', model: 'QGENNPN', pins: [{ pinId: 'c', netId: LK }, { pinId: 'b', netId: 'dbase' }, { pinId: 'e', netId: 'dem' }] },
        V('dvs', 'VS1', 'SIN(0 0.05 5k)', 'dsig', '0'), C('dci', 'CI1', '10u', 'dsig', 'dbase')],
      nets: ['dvcc', 'dbase', 'dem', 'dsig'] }) },
  { name: 'mos-inv', tran: { stopTime: '500u', stepTime: '250n' }, minPP: 3, build: (LK) => ({
      components: [V('dvd', 'VD1', 'DC 5', 'dvdd', '0'), V('dvg', 'VG1', 'PULSE(0 5 0 100n 100n 20u 50u)', 'dgate', '0'),
        R('drd', 'RD1', '100k', 'dvdd', LK),
        { id: 'dm1', type: 'mosfet', designator: 'M1', model: 'MGENNMOS', pins: [{ pinId: 'd', netId: LK }, { pinId: 'g', netId: 'dgate' }, { pinId: 's', netId: '0' }, { pinId: 'b', netId: '0' }] }],
      nets: ['dvdd', 'dgate'] }) },
  { name: 'xfmr-sec', tran: { stopTime: '5m', stepTime: '5u' }, minPP: 5, build: (LK) => ({
      components: [V('dvp', 'VP1', 'SIN(0 10 1k)', 'dpri0', '0'), R('drp', 'RP1', '10', 'dpri0', 'dpri'),
        { id: 'dt1', type: 'transformer', designator: 'T1', properties: { primaryInductance: '1', secondaryInductance: '0.25', coupling: '0.99', windingResistance: '1' }, pins: [{ pinId: 'p+', netId: 'dpri' }, { pinId: 'p-', netId: '0' }, { pinId: 's+', netId: LK }, { pinId: 's-', netId: '0' }] }],
      nets: ['dpri0', 'dpri'] }) },
  { name: 'tline-far', tran: { stopTime: '1u', stepTime: '500p' }, minPP: 1.5, build: (LK) => ({
      components: [V('dvs', 'VS1', 'PULSE(0 5 0 1n 1n 100n 300n)', 'dsrc', '0'), R('drs', 'RS1', '50', 'dsrc', 'dnear'),
        { id: 'dt1', type: 'tline', designator: 'T1', properties: { z0: '50', td: '10n' }, pins: [{ pinId: 'a+', netId: 'dnear' }, { pinId: 'a-', netId: '0' }, { pinId: 'b+', netId: LK }, { pinId: 'b-', netId: '0' }] }],
      nets: ['dsrc', 'dnear'] }) },
  { name: 'bsource', tran: { stopTime: '1m', stepTime: '1u' }, minPP: 1.5, build: (LK) => ({
      components: [V('dvm', 'VM1', 'SIN(0 2 2k)', 'dmod', '0'), R('drm', 'RM1', '10k', 'dmod', '0'),
        { id: 'db1', type: 'bsource', designator: 'B1', value: 'V=v(dmod)*v(dmod)/2', pins: [{ pinId: '+', netId: LK }, { pinId: '-', netId: '0' }] }],
      nets: ['dmod'] }) },
  { name: 'vcvs-out', tran: { stopTime: '1m', stepTime: '1u' }, minPP: 4, build: (LK) => ({
      components: [V('dvs', 'VS1', 'SIN(0 1.5 3k)', 'dsig', '0'), R('drs', 'RS1', '10k', 'dsig', '0'),
        { id: 'de1', type: 'vcvs', designator: 'E1', value: '2', pins: [{ pinId: '+', netId: LK }, { pinId: '-', netId: '0' }, { pinId: 'c+', netId: 'dsig' }, { pinId: 'c-', netId: '0' }] }],
      nets: ['dsig'] }) },
  { name: 'isource', tran: { stopTime: '1m', stepTime: '1u' }, minPP: 0, build: (LK) => ({
      components: [{ id: 'di1', type: 'current_source', designator: 'I1', value: 'DC 2m', pins: [{ pinId: '+', netId: '0' }, { pinId: '-', netId: LK }] }, R('dri', 'RI1', '1k', LK, '0')], nets: [] }) },
  { name: 'switch-out', tran: { stopTime: '1m', stepTime: '1u' }, minPP: 3, build: (LK) => ({
      components: [V('dvs', 'VS1', 'DC 5', 'dsup', '0'), V('dvc', 'VC1', 'PULSE(0 5 0 1u 1u 50u 100u)', 'dctl', '0'), R('drc', 'RC1', '100k', 'dctl', '0'),
        { id: 'ds1', type: 'switch', designator: 'S1', model: 'SWGEN', pins: [{ pinId: '+', netId: 'dsup' }, { pinId: '-', netId: LK }, { pinId: 'c+', netId: 'dctl' }, { pinId: 'c-', netId: '0' }] },
        R('drb', 'RB1', '10k', LK, '0')],
      nets: ['dsup', 'dctl'] }) },
  { name: 'zener-clamp', tran: { stopTime: '3m', stepTime: '3u' }, minPP: 1.2, build: (LK) => ({
      components: [V('dvs', 'VS1', 'SIN(0 10 1k)', 'dsrc', '0'), R('drs', 'RS1', '1k', 'dsrc', LK),
        { id: 'dz1', type: 'zener', designator: 'Z1', value: '5.1', pins: [{ pinId: 'cathode', netId: LK }, { pinId: 'anode', netId: '0' }] }],
      nets: ['dsrc'] }) },
];

// Each load: { name, build(LINK) -> {components, nets, probes} } (probes beyond v(LINK))
const LOADS = [
  { name: 'rload', build: (LK) => ({ components: [R('lr1', 'RL9', '1k', LK, '0')], nets: [], probes: [] }) },
  { name: 'cload', build: (LK) => ({ components: [C('lc1', 'CL9', '10n', LK, '0')], nets: [], probes: [] }) },
  { name: 'rc-filter', build: (LK) => ({ components: [R('lr1', 'RF9', '1k', LK, 'lout'), C('lc1', 'CF9', '10n', 'lout', '0')], nets: ['lout'], probes: ['v(lout)'] }) },
  { name: 'rl-load', build: (LK) => ({ components: [R('lr1', 'RA9', '100', LK, 'lout'), L('ll1', 'LL9', '1m', 'lout', '0')], nets: ['lout'], probes: ['v(lout)'] }) },
  { name: 'diode-peak', build: (LK) => ({ components: [{ id: 'ld1', type: 'diode', designator: 'D9', pins: [{ pinId: 'anode', netId: LK }, { pinId: 'cathode', netId: 'lout' }] }, R('lr1', 'RD9', '10k', 'lout', '0'), C('lc1', 'CD9', '100n', 'lout', '0')], nets: ['lout'], probes: ['v(lout)'] }) },
  { name: 'gate-in', build: (LK) => ({ components: [{ id: 'lg1', type: 'logic_not', designator: 'XN9', pins: [{ pinId: 'in1', netId: LK }, { pinId: 'out', netId: 'lout' }] }, R('lr1', 'RG9', '10k', 'lout', '0')], nets: ['lout'], probes: ['v(lout)'] }) },
  { name: 'dff-clk', build: (LK) => ({ components: [{ id: 'lff1', type: 'dff', designator: 'U8', pins: [{ pinId: 'd', netId: 'ldqb' }, { pinId: 'clk', netId: LK }, { pinId: 'q', netId: 'lout' }, { pinId: 'qb', netId: 'ldqb' }] }], nets: ['ldqb', 'lout'], probes: ['v(lout)'] }) },
  { name: 'opamp-in', build: (LK) => ({ components: [V('lvp', 'VP9', 'DC 12', 'lvp', '0'), V('lvn', 'VN9', 'DC -12', 'lvn', '0'),
      { id: 'lu1', type: 'subckt', designator: 'U9', model: 'OPAMPGEN', pins: [{ pinId: 'out', netId: 'lout' }, { pinId: 'in+', netId: LK }, { pinId: 'in-', netId: 'lout' }, { pinId: 'vcc', netId: 'lvp' }, { pinId: 'vee', netId: 'lvn' }] }, R('lr1', 'RO9', '10k', 'lout', '0')], nets: ['lvp', 'lvn', 'lout'], probes: ['v(lout)'] }) },
  { name: 'vcvs-sense', build: (LK) => ({ components: [{ id: 'le1', type: 'vcvs', designator: 'E9', value: '3', pins: [{ pinId: '+', netId: 'lout' }, { pinId: '-', netId: '0' }, { pinId: 'c+', netId: LK }, { pinId: 'c-', netId: '0' }] }, R('lr1', 'RE9', '1k', 'lout', '0')], nets: ['lout'], probes: ['v(lout)'] }) },
  { name: 'bsource-expr', build: (LK) => ({ components: [{ id: 'lb1', type: 'bsource', designator: 'B9', value: `V=v(${LK})*0.5+1`, pins: [{ pinId: '+', netId: 'lout' }, { pinId: '-', netId: '0' }] }, R('lr1', 'RB9', '1k', 'lout', '0')], nets: ['lout'], probes: ['v(lout)'] }) },
  { name: 'xfmr-pri', build: (LK) => ({ components: [{ id: 'lt1', type: 'transformer', designator: 'T9', properties: { primaryInductance: '0.1', secondaryInductance: '0.1', coupling: '0.99', windingResistance: '1' }, pins: [{ pinId: 'p+', netId: LK }, { pinId: 'p-', netId: '0' }, { pinId: 's+', netId: 'lout' }, { pinId: 's-', netId: '0' }] }, R('lr1', 'RX9', '1k', 'lout', '0')], nets: ['lout'], probes: ['v(lout)'] }) },
  { name: 'switch-ctl', build: (LK) => ({ components: [V('lvs', 'VS9', 'DC 5', 'lsup', '0'), { id: 'ls1', type: 'switch', designator: 'S9', model: 'SWGEN', pins: [{ pinId: '+', netId: 'lsup' }, { pinId: '-', netId: 'lout' }, { pinId: 'c+', netId: LK }, { pinId: 'c-', netId: '0' }] }, R('lr1', 'RS9', '1k', 'lout', '0')], nets: ['lsup', 'lout'], probes: ['v(lout)'] }) },
];

// Per-pair expectation overrides (minPP) where the PHYSICS legitimately yields a near-dead link — the cell
// still must run, converge, and stay finite (the engine guarantee), but a liveness floor would be asserting
// something the circuit can't do:
//   • mos-inv is a resistive-pull-up (100k) inverter on the µA-class generic MOSFET → inherently high-Z;
//     a 1k load divides the high level to ~50mV, an RC of 100k·10n (1ms) barely charges in a 20µs pulse,
//     and a transformer winding / inductor is a DC short that pins the drain.
//   • bjt-ce's collector re-biases under a heavy AC load (100Ω+L) or a DC-short winding → gain collapses.
const MINPP_OVERRIDES = {
  'mos-inv|rload': 0, 'mos-inv|cload': 0, 'mos-inv|rc-filter': 0, 'mos-inv|rl-load': 0,
  'mos-inv|diode-peak': 0, 'mos-inv|xfmr-pri': 0,
  'bjt-ce|rl-load': 0, 'bjt-ce|diode-peak': 0, 'bjt-ce|xfmr-pri': 0,
};

// ---------- runner ----------
function runPair(driver, load, linkName) {
  const d = driver.build(linkName);
  const l = load.build(linkName);
  const netIds = new Set(['0', linkName, ...d.nets, ...l.nets]);
  const circuit = {
    version: '1.0',
    components: [...d.components, ...l.components],
    nets: [...netIds].map((id) => (id === '0' ? { id: '0', name: '0', isGround: true } : { id, name: id })),
  };
  const probes = [`v(${linkName})`, ...l.probes];
  const analysis = { type: 'tran', ...driver.tran };

  const c = JSON.parse(JSON.stringify(circuit));
  const extra = resolveGenericModels(c);
  if (extra.length) c.models = [...(c.models ?? []), ...extra];
  let netlist;
  try {
    netlist = generateNetlist(c, analysis, { probes });
  } catch (e) {
    return { status: 'GEN-THROW', detail: e instanceof Error ? e.message : String(e), netlist: '' };
  }
  const dir = mkdtempSync(join(tmpdir(), 'cf-pair-'));
  try {
    writeFileSync(join(dir, 'c.cir'), netlist);
    const r = spawnSync(NG, ['-b', '-o', 'log.txt', 'c.cir'], { cwd: dir, encoding: 'utf-8', timeout: 45000 });
    const log = (() => { try { return readFileSync(join(dir, 'log.txt'), 'utf-8'); } catch { return ''; } })();
    const errs = ((r.stderr || '') + '\n' + log).split('\n').map((s) => s.trim())
      .filter((x) => /singular matrix|no convergence|Timestep too small|Unable to find|fatal|aborted|no such/i.test(x));
    let csv = '';
    try { csv = readFileSync(join(dir, 'output.csv'), 'utf-8'); } catch { /* none */ }
    if (r.status !== 0 || !csv.trim() || errs.length) {
      return { status: 'NGSPICE-FAIL', detail: `exit=${r.status} errs=${JSON.stringify(errs.slice(0, 2))} csv=${csv.trim() ? 'yes' : 'EMPTY'}`, netlist };
    }
    const names = extractProbes(netlist);
    const res = parseSimulationOutput(csv, names.length ? names : probes, 'tran');
    const linkSeries = res.series.find((s) => s.name.toLowerCase().includes('(')); // first series = link probe
    const allFinite = res.series.every((s) => s.points.every((p) => Number.isFinite(p.y)));
    if (!allFinite) return { status: 'NON-FINITE', detail: 'NaN/Inf in series', netlist };
    if (!res.series.length || !res.meta.pointsCount) return { status: 'EMPTY-PARSE', detail: 'parsed zero series/rows', netlist };
    const ys = res.series[0].points.map((p) => p.y);
    const pp = Math.max(...ys) - Math.min(...ys);
    const effMinPP = MINPP_OVERRIDES[`${driver.name}|${load.name}`] ?? driver.minPP;
    if (effMinPP > 0 && pp < effMinPP) {
      return { status: 'DEAD-LINK', detail: `link pp=${pp.toExponential(2)} < minPP=${effMinPP}`, netlist };
    }
    return { status: 'PASS', detail: `rows=${res.meta.pointsCount} linkPP=${pp.toPrecision(3)}` };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------- sweep ----------
const failures = [];
let pass = 0, total = 0;
const t0 = Date.now();

console.log('=== PASS 1: full driver x load grid (link net = "link") ===');
for (const drv of DRIVERS) {
  const row = [];
  for (const ld of LOADS) {
    total++;
    const r = runPair(drv, ld, 'link');
    if (r.status === 'PASS') { pass++; row.push('.'); }
    else { row.push('X'); failures.push({ pair: `${drv.name} -> ${ld.name}`, link: 'link', ...r }); }
  }
  console.log(row.join('') + '  ' + drv.name);
}
console.log('cols: ' + LOADS.map((l) => l.name).join(', '));

console.log('\n=== PASS 2: hostile link names ===');
// All drivers x bsource-expr with link='e' (operator token flows into a B-source EXPRESSION + probes).
// All drivers x rload with link='in' (reserved word on the shared net).
// Digital pairs with link='2x' (numeric-leading through the bridge/probe-twin path).
const hostile = [];
for (const drv of DRIVERS) hostile.push([drv, LOADS.find((l) => l.name === 'bsource-expr'), 'e']);
for (const drv of DRIVERS) hostile.push([drv, LOADS.find((l) => l.name === 'rload'), 'in']);
for (const dn of ['gate-out', 'dff-q']) for (const ln of ['gate-in', 'dff-clk']) hostile.push([DRIVERS.find((d) => d.name === dn), LOADS.find((l) => l.name === ln), '2x']);
for (const [drv, ld, nm] of hostile) {
  total++;
  const r = runPair(drv, ld, nm);
  if (r.status === 'PASS') pass++;
  else failures.push({ pair: `${drv.name} -> ${ld.name}`, link: nm, ...r });
}
console.log(`hostile-name runs: ${hostile.length}`);

console.log(`\n==================== RESULT: ${pass}/${total} pass  (${failures.length} failures, ${((Date.now() - t0) / 1000).toFixed(0)}s) ====================`);
for (const f of failures) {
  console.log(`\n--- FAIL [${f.status}] ${f.pair}  (link='${f.link}')`);
  console.log(`    ${f.detail}`);
  if (f.netlist) {
    const compLines = f.netlist.split('\n').filter((x) => x && !x.startsWith('*') && !x.startsWith('.') && !x.startsWith(' '));
    console.log('    devices: ' + compLines.slice(0, 14).join(' | '));
  }
}
process.exit(failures.length ? 1 : 0);
