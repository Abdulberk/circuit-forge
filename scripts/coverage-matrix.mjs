// Coverage matrix: exhaustively exercise the CircuitJson -> SPICE translation layer against real ngspice.
//   node scripts/coverage-matrix.mjs            (run all cells, print the grid)
//   node scripts/coverage-matrix.mjs --json     (also dump machine-readable results)
//
// Each CELL = a minimal valid fixture + an analysis + probes + an expectation. The runner generates the
// netlist via eda-core (dist), runs `ngspice -b`, parses the output, and checks the cell's expectation.
// Cells are grouped (device-rows, name edge-cases, probe forms, interactions). Output: a ✅/❌ grid + the
// detail of every RED cell. This is the proactive "crash test" — it fills the translation-layer surface
// instead of waiting for a random circuit to hit an untested combination.
import { generateNetlist, parseSimulationOutput, resolveGenericModels, extractProbes, runErc } from '../packages/eda-core/dist/index.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NG = process.env.NGSPICE_PATH || 'C:/ProgramData/chocolatey/lib/ngspice/tools/Spice64/bin/ngspice_con.exe'; // CONSOLE build — the choco-shim ngspice.exe is the GUI build: it writes NO log in -b mode (silent empty) and zombies on hangs

// ---- core runner: one cell -> { exit, rows, series, errors } ----
function runCell(circuit, analysis, probes) {
    const c = JSON.parse(JSON.stringify(circuit));
    const extra = resolveGenericModels(c);
    if (extra.length) c.models = [...(c.models ?? []), ...extra];
    let netlist;
    try {
        netlist = generateNetlist(c, analysis, probes ? { probes } : undefined);
    } catch (e) {
        return { genError: e instanceof Error ? e.message : String(e), netlist: '', exit: null, rows: 0, series: [], errors: [] };
    }
    const dir = mkdtempSync(join(tmpdir(), 'cf-cov-'));
    try {
        writeFileSync(join(dir, 'c.cir'), netlist);
        const r = spawnSync(NG, ['-b', '-o', 'log.txt', 'c.cir'], { cwd: dir, encoding: 'utf-8', timeout: 30000 });
        const log = (() => { try { return readFileSync(join(dir, 'log.txt'), 'utf-8'); } catch { return ''; } })();
        const errs = ((r.stderr || '') + '\n' + log).split('\n').map((s) => s.trim())
            .filter((l) => /singular matrix|no convergence|Timestep too small|Unable to find|fatal|aborted|no such|no output/i.test(l));
        let csv = '';
        try { csv = readFileSync(join(dir, 'output.csv'), 'utf-8'); } catch { /* none */ }
        const names = extractProbes(netlist);
        const res = csv.trim() ? parseSimulationOutput(csv, names.length ? names : (probes || ['v(out)']), analysis.type) : { series: [], meta: { pointsCount: 0 } };
        const series = res.series.map((s) => {
            const ys = s.points.map((p) => p.y).filter(Number.isFinite);
            const min = ys.length ? Math.min(...ys) : NaN, max = ys.length ? Math.max(...ys) : NaN;
            return { name: s.name, n: s.points.length, min, max, pp: max - min, final: ys[ys.length - 1] };
        });
        return { netlist, exit: r.status, rows: res.meta.pointsCount, series, errors: errs };
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---- expectation helpers ----
const finiteAll = (rep) => rep.series.length > 0 && rep.series.every((s) => Number.isFinite(s.final));
const ran = (rep) => rep.exit === 0 && rep.rows > 0 && rep.errors.length === 0 && !rep.genError;
const ok = () => ({ pass: true });
const fail = (why) => ({ pass: false, why });
// generic: ran clean + all series finite (+ optional non-degenerate for dynamic analyses)
function baseOk(rep, { swing } = {}) {
    if (rep.genError) return fail(`generate threw: ${rep.genError}`);
    if (!ran(rep)) return fail(`ngspice: exit=${rep.exit} rows=${rep.rows} errors=${JSON.stringify(rep.errors.slice(0, 2))}`);
    if (!finiteAll(rep)) return fail(`non-finite series: ${rep.series.map((s) => s.name + '=' + s.final).join(',')}`);
    if (swing) { const s0 = rep.series[0]; if (!(Math.abs(s0.pp) > swing)) return fail(`expected swing > ${swing}, got pp=${s0?.pp}`); }
    return ok();
}
const near = (v, t, tol) => Number.isFinite(v) && Math.abs(v - t) <= tol;

// ---- circuit builders ----
const gnd = { id: '0', name: '0', isGround: true };
const N = (...ids) => [...ids.map((id) => ({ id, name: id })), gnd];
const V = (id, des, val, p, n) => ({ id, type: 'voltage_source', designator: des, value: val, pins: [{ pinId: '+', netId: p }, { pinId: '-', netId: n }] });
const R = (id, des, val, a, b) => ({ id, type: 'resistor', designator: des, value: val, pins: [{ pinId: '1', netId: a }, { pinId: '2', netId: b }] });
const C = (id, des, val, a, b) => ({ id, type: 'capacitor', designator: des, value: val, pins: [{ pinId: '1', netId: a }, { pinId: '2', netId: b }] });
const L = (id, des, val, a, b) => ({ id, type: 'inductor', designator: des, value: val, pins: [{ pinId: '1', netId: a }, { pinId: '2', netId: b }] });
const circuit = (components, nets) => ({ version: '1.0', components, nets });

const TRAN = { type: 'tran', stopTime: '2m', stepTime: '4u' };
const TRANu = { type: 'tran', stopTime: '4u', stepTime: '10n' };
const OP = { type: 'op' };
const AC = { type: 'ac', variation: 'dec', points: 10, startFreq: '1', stopFreq: '1meg' };

// ===================== CELLS =====================
const CELLS = [];
const add = (group, name, build, expect, opts = {}) => CELLS.push({ group, name, build, expect, ...opts });

// ---------- 1. PASSIVES ----------
const divider = circuit([V('v1', 'V1', 'DC 10', 'sup', '0'), R('r1', 'R1', '1k', 'sup', 'mid'), R('r2', 'R2', '1k', 'mid', '0')], N('sup', 'mid'));
add('passive', 'resistor v(op)', () => ({ circuit: divider, analysis: OP, probes: ['v(mid)'] }), (r) => near(r.series[0]?.final, 5, 0.01) ? ok() : fail(`v(mid)=${r.series[0]?.final}, want 5`));
add('passive', 'resistor i(op)', () => ({ circuit: divider, analysis: OP, probes: ['i(R1)'] }), (r) => near(Math.abs(r.series[0]?.final), 0.005, 1e-4) ? ok() : fail(`i(R1)=${r.series[0]?.final}, want ~5mA`));
const rc = circuit([V('v1', 'V1', 'PULSE(0 5 0 1u 1u 1m 2m)', 'in', '0'), R('r1', 'R1', '1k', 'in', 'out'), C('c1', 'C1', '100n', 'out', '0')], N('in', 'out'));
add('passive', 'capacitor v(tran)', () => ({ circuit: rc, analysis: TRAN, probes: ['v(out)'] }), (r) => baseOk(r, { swing: 1 }));
add('passive', 'capacitor i(tran)', () => ({ circuit: rc, analysis: TRAN, probes: ['i(C1)'] }), (r) => baseOk(r));
const rl = circuit([V('v1', 'V1', 'PULSE(0 5 0 1u 1u 1m 2m)', 'in', '0'), R('r1', 'R1', '100', 'in', 'out'), L('l1', 'L1', '1m', 'out', '0')], N('in', 'out'));
add('passive', 'inductor i(tran)', () => ({ circuit: rl, analysis: TRAN, probes: ['i(L1)'] }), (r) => baseOk(r));
add('passive', 'capacitor v(ac)', () => ({ circuit: circuit([{ id: 'v1', type: 'voltage_source', designator: 'V1', value: 'AC 1', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: '0' }] }, R('r1', 'R1', '1.6k', 'in', 'out'), C('c1', 'C1', '100n', 'out', '0')], N('in', 'out')), analysis: AC, probes: ['v(out)'] }), (r) => baseOk(r));

// ---------- 2. SOURCES ----------
add('source', 'current_source (op)', () => ({ circuit: circuit([{ id: 'i1', type: 'current_source', designator: 'I1', value: 'DC 1m', pins: [{ pinId: '+', netId: '0' }, { pinId: '-', netId: 'n1' }] }, R('r1', 'R1', '1k', 'n1', '0')], N('n1')), analysis: OP, probes: ['v(n1)'] }), (r) => near(r.series[0]?.final, 1, 0.05) ? ok() : fail(`v=${r.series[0]?.final} want ~1V (1mA*1k)`));
add('source', 'SIN source (tran)', () => ({ circuit: circuit([V('v1', 'V1', 'SIN(0 5 1k)', 'in', '0'), R('r1', 'R1', '1k', 'in', '0')], N('in')), analysis: TRAN, probes: ['v(in)'] }), (r) => baseOk(r, { swing: 8 }));

// ---------- 3. CONTROLLED SOURCES ----------
add('controlled', 'vcvs E (op)', () => ({ circuit: circuit([V('v1', 'V1', 'DC 2', 'in', '0'), { id: 'e1', type: 'vcvs', designator: 'E1', value: '3', pins: [{ pinId: '+', netId: 'out' }, { pinId: '-', netId: '0' }, { pinId: 'c+', netId: 'in' }, { pinId: 'c-', netId: '0' }] }, R('rl', 'RL', '1k', 'out', '0')], N('in', 'out')), analysis: OP, probes: ['v(out)'] }), (r) => near(r.series[0]?.final, 6, 0.05) ? ok() : fail(`v(out)=${r.series[0]?.final} want 6 (3*2)`));
add('controlled', 'vccs G (op)', () => ({ circuit: circuit([V('v1', 'V1', 'DC 2', 'in', '0'), { id: 'g1', type: 'vccs', designator: 'G1', value: '1m', pins: [{ pinId: '+', netId: '0' }, { pinId: '-', netId: 'out' }, { pinId: 'c+', netId: 'in' }, { pinId: 'c-', netId: '0' }] }, R('rl', 'RL', '1k', 'out', '0')], N('in', 'out')), analysis: OP, probes: ['v(out)'] }), (r) => near(r.series[0]?.final, 2, 0.1) ? ok() : fail(`v(out)=${r.series[0]?.final} want ~2 (1m*2*1k)`));
add('controlled', 'bsource B (tran)', () => ({ circuit: circuit([V('v1', 'V1', 'SIN(0 1 1k)', 'a', '0'), V('v2', 'V2', 'DC 2', 'b', '0'), { id: 'b1', type: 'bsource', designator: 'B1', value: 'V=v(a)*v(b)', pins: [{ pinId: '+', netId: 'out' }, { pinId: '-', netId: '0' }] }, R('rl', 'RL', '1k', 'out', '0')], N('a', 'b', 'out')), analysis: TRAN, probes: ['v(out)'] }), (r) => baseOk(r, { swing: 2 }));

// ---------- 4. DIODE / ZENER ----------
add('diode', 'diode rectifier (tran)', () => ({ circuit: circuit([V('v1', 'V1', 'SIN(0 5 1k)', 'in', '0'), { id: 'd1', type: 'diode', designator: 'D1', pins: [{ pinId: 'anode', netId: 'in' }, { pinId: 'cathode', netId: 'out' }] }, R('rl', 'RL', '1k', 'out', '0')], N('in', 'out')), analysis: TRAN, probes: ['v(out)'] }), (r) => baseOk(r) .pass && r.series[0].min > -0.5 ? ok() : fail(`rectified min=${r.series[0]?.min} should be >~0`));
add('diode', 'zener clamp (dc sweep)', () => ({ circuit: circuit([V('v1', 'V1', 'DC 0', 'in', '0'), R('r1', 'R1', '1k', 'in', 'out'), { id: 'z1', type: 'zener', designator: 'Z1', value: '5.1', pins: [{ pinId: 'cathode', netId: 'out' }, { pinId: 'anode', netId: '0' }] }], N('in', 'out')), analysis: { type: 'dc', source: 'V1', startVal: '0', stopVal: '10', increment: '0.1' }, probes: ['v(out)'] }), (r) => baseOk(r).pass && r.series[0].max < 6.5 ? ok() : fail(`zener max=${r.series[0]?.max} should clamp ~5.1`));

// ---------- 5. BJT ----------
const ceAmp = (model) => circuit([V('v1', 'V1', 'DC 10', 'vcc', '0'), R('rb1', 'RB1', '68k', 'vcc', 'b'), R('rb2', 'RB2', '12k', 'b', '0'), R('rc', 'RC', '1k', 'vcc', 'col'), R('re', 'RE', '220', 'em', '0'), { id: 'q1', type: 'bjt', designator: 'Q1', model, pins: [{ pinId: 'c', netId: 'col' }, { pinId: 'b', netId: 'b' }, { pinId: 'e', netId: 'em' }] }], N('vcc', 'b', 'col', 'em'));
add('bjt', 'npn CE (op)', () => ({ circuit: ceAmp('QGENNPN'), analysis: OP, probes: ['v(col)', 'v(b)', 'v(em)'] }), (r) => baseOk(r).pass && r.series[0].final > 1 && r.series[0].final < 9 ? ok() : fail(`Vc=${r.series[0]?.final} not in active region`));
add('bjt', 'pnp CE (op)', () => ({ circuit: circuit([V('v1', 'V1', 'DC 10', 'vcc', '0'), R('rb1', 'RB1', '68k', 'vcc', 'b'), R('rb2', 'RB2', '12k', 'b', '0'), R('rc', 'RC', '1k', 'col', '0'), R('re', 'RE', '220', 'vcc', 'em'), { id: 'q1', type: 'bjt', designator: 'Q1', model: 'QGENPNP', pins: [{ pinId: 'c', netId: 'col' }, { pinId: 'b', netId: 'b' }, { pinId: 'e', netId: 'em' }] }], N('vcc', 'b', 'col', 'em')), analysis: OP, probes: ['v(col)'] }), (r) => baseOk(r));
add('bjt', 'npn CE (ac gain)', () => ({ circuit: circuit([...ceAmp('QGENNPN').components, { id: 'vin', type: 'voltage_source', designator: 'VIN', value: 'AC 1', pins: [{ pinId: '+', netId: 'sig' }, { pinId: '-', netId: '0' }] }, C('cin', 'CIN', '10u', 'sig', 'b')], N('vcc', 'sig', 'b', 'col', 'em')), analysis: AC, probes: ['v(col)'] }), (r) => baseOk(r));

// ---------- 6. MOSFET / JFET ----------
add('mosfet', 'nmos (op)', () => ({ circuit: circuit([V('v1', 'V1', 'DC 10', 'vdd', '0'), V('vg', 'VG', 'DC 4', 'g', '0'), R('rd', 'RD', '1k', 'vdd', 'd'), { id: 'm1', type: 'mosfet', designator: 'M1', model: 'MGENNMOS', pins: [{ pinId: 'd', netId: 'd' }, { pinId: 'g', netId: 'g' }, { pinId: 's', netId: '0' }, { pinId: 'b', netId: '0' }] }], N('vdd', 'g', 'd')), analysis: OP, probes: ['v(d)'] }), (r) => baseOk(r));
add('mosfet', 'pmos (op)', () => ({ circuit: circuit([V('v1', 'V1', 'DC 10', 'vdd', '0'), V('vg', 'VG', 'DC 6', 'g', '0'), R('rd', 'RD', '1k', 'd', '0'), { id: 'm1', type: 'mosfet', designator: 'M1', model: 'MGENPMOS', pins: [{ pinId: 'd', netId: 'd' }, { pinId: 'g', netId: 'g' }, { pinId: 's', netId: 'vdd' }, { pinId: 'b', netId: 'vdd' }] }], N('vdd', 'g', 'd')), analysis: OP, probes: ['v(d)'] }), (r) => baseOk(r));
add('jfet', 'njf (op)', () => ({ circuit: circuit([V('v1', 'V1', 'DC 10', 'vdd', '0'), R('rd', 'RD', '1k', 'vdd', 'd'), R('rs', 'RS', '470', 'src', '0'), { id: 'j1', type: 'jfet', designator: 'J1', model: 'JGENNJF', pins: [{ pinId: 'd', netId: 'd' }, { pinId: 'g', netId: '0' }, { pinId: 's', netId: 'src' }] }], N('vdd', 'd', 'src')), analysis: OP, probes: ['v(d)'] }), (r) => baseOk(r));

// ---------- 7. SWITCH / SCR / IGBT ----------
add('switch', 'vswitch SWGEN (tran)', () => ({ circuit: circuit([V('v1', 'V1', 'DC 5', 'sup', '0'), V('vc', 'VC', 'PULSE(0 5 0 1u 1u 1m 2m)', 'ctl', '0'), { id: 's1', type: 'switch', designator: 'S1', model: 'SWGEN', pins: [{ pinId: '+', netId: 'sup' }, { pinId: '-', netId: 'out' }, { pinId: 'c+', netId: 'ctl' }, { pinId: 'c-', netId: '0' }] }, R('rl', 'RL', '1k', 'out', '0')], N('sup', 'ctl', 'out')), analysis: TRAN, probes: ['v(out)'] }), (r) => baseOk(r, { swing: 1 }));

// ---------- 8. OPAMP / SUBCKT ----------
add('subckt', 'opamp OPAMPGEN non-inv x2 (op)', () => ({ circuit: circuit([V('vcc', 'VCC', 'DC 15', 'vcc', '0'), V('vee', 'VEE', 'DC -15', 'vee', '0'), V('vin', 'VIN', 'DC 1', 'inp', '0'), R('rf', 'RF', '10k', 'out', 'fb'), R('rg', 'RG', '10k', 'fb', '0'), { id: 'u1', type: 'subckt', designator: 'U1', model: 'OPAMPGEN', pins: [{ pinId: 'out', netId: 'out' }, { pinId: 'in+', netId: 'inp' }, { pinId: 'in-', netId: 'fb' }, { pinId: 'vcc', netId: 'vcc' }, { pinId: 'vee', netId: 'vee' }] }], N('vcc', 'vee', 'inp', 'out', 'fb')), analysis: OP, probes: ['v(out)'] }), (r) => near(r.series[0]?.final, 2, 0.1) ? ok() : fail(`v(out)=${r.series[0]?.final} want ~2 (gain 2 * 1V)`));
add('subckt', 'opamp OPAMPGEN (ac)', () => ({ circuit: circuit([V('vcc', 'VCC', 'DC 15', 'vcc', '0'), V('vee', 'VEE', 'DC -15', 'vee', '0'), { id: 'vin', type: 'voltage_source', designator: 'VIN', value: 'AC 1', pins: [{ pinId: '+', netId: 'inp' }, { pinId: '-', netId: '0' }] }, R('rf', 'RF', '10k', 'out', 'fb'), R('rg', 'RG', '10k', 'fb', '0'), { id: 'u1', type: 'subckt', designator: 'U1', model: 'OPAMPGEN', pins: [{ pinId: 'out', netId: 'out' }, { pinId: 'in+', netId: 'inp' }, { pinId: 'in-', netId: 'fb' }, { pinId: 'vcc', netId: 'vcc' }, { pinId: 'vee', netId: 'vee' }] }], N('vcc', 'vee', 'inp', 'out', 'fb')), analysis: AC, probes: ['v(out)'] }), (r) => baseOk(r));

// ---------- 9. TRANSFORMER ----------
add('transformer', 'transformer step-down (tran)', () => ({ circuit: circuit([V('v1', 'V1', 'SIN(0 10 1k)', 'pri', '0'), { id: 't1', type: 'transformer', designator: 'T1', properties: { primaryInductance: '1', secondaryInductance: '0.25', coupling: '0.99' }, pins: [{ pinId: 'p+', netId: 'pri' }, { pinId: 'p-', netId: '0' }, { pinId: 's+', netId: 'sec' }, { pinId: 's-', netId: '0' }] }, R('rl', 'RL', '1k', 'sec', '0')], N('pri', 'sec')), analysis: TRAN, probes: ['v(sec)'] }), (r) => baseOk(r, { swing: 1 }));

// ---------- 10. TLINE ----------
add('tline', 'transmission line reflection (tran)', () => ({ circuit: circuit([V('v1', 'V1', 'PULSE(0 5 0 1n 1n 50n 200n)', 'src', '0'), R('rs', 'RS', '50', 'src', 'a'), { id: 't1', type: 'tline', designator: 'T1', properties: { z0: '50', td: '10n' }, pins: [{ pinId: 'a+', netId: 'a' }, { pinId: 'a-', netId: '0' }, { pinId: 'b+', netId: 'b' }, { pinId: 'b-', netId: '0' }] }, R('rt', 'RT', '1k', 'b', '0')], N('src', 'a', 'b')), analysis: { type: 'tran', stopTime: '200n', stepTime: '0.2n' }, probes: ['v(b)'] }), (r) => baseOk(r, { swing: 1 }));

// ---------- 11. LOGIC GATES ----------
for (const [type, des] of [['logic_and', 'XAND'], ['logic_or', 'XOR'], ['logic_nand', 'XNAND'], ['logic_nor', 'XNOR'], ['logic_xor', 'XXOR'], ['logic_xnor', 'XXNOR']]) {
    add('digital', `${type} (tran)`, () => ({
        circuit: circuit([
            V('vdd', 'VDD', 'DC 5', 'vdd', '0'),
            V('va', 'VA', 'PULSE(0 5 0 10n 10n 0.5u 1u)', 'a', '0'),
            V('vb', 'VB', 'PULSE(0 5 0 10n 10n 1u 2u)', 'b', '0'),
            { id: 'g1', type, designator: des, pins: [{ pinId: 'in1', netId: 'a' }, { pinId: 'in2', netId: 'b' }, { pinId: 'out', netId: 'y' }] },
        ], N('vdd', 'a', 'b', 'y')),
        analysis: TRANu, probes: ['v(y)'],
    }), (r) => baseOk(r, { swing: 1 }));
}
for (const [type, des] of [['logic_not', 'XNOT'], ['logic_buffer', 'XBUF']]) {
    add('digital', `${type} (tran)`, () => ({
        circuit: circuit([V('vdd', 'VDD', 'DC 5', 'vdd', '0'), V('va', 'VA', 'PULSE(0 5 0 10n 10n 0.5u 1u)', 'a', '0'), { id: 'g1', type, designator: des, pins: [{ pinId: 'in1', netId: 'a' }, { pinId: 'out', netId: 'y' }] }], N('vdd', 'a', 'y')),
        analysis: TRANu, probes: ['v(y)'],
    }), (r) => baseOk(r, { swing: 1 }));
}
add('digital', 'dff /2 divider (tran)', () => ({ circuit: circuit([V('vdd', 'VDD', 'DC 5', 'vdd', '0'), V('vclk', 'VCLK', 'PULSE(0 5 0 10n 10n 0.5u 1u)', 'clk', '0'), { id: 'ff', type: 'dff', designator: 'U1', pins: [{ pinId: 'd', netId: 'qb' }, { pinId: 'clk', netId: 'clk' }, { pinId: 'q', netId: 'q' }, { pinId: 'qb', netId: 'qb' }] }], N('vdd', 'clk', 'q', 'qb')), analysis: TRANu, probes: ['v(q)'] }), (r) => baseOk(r, { swing: 1 }));
// PR2 sequential/bus primitives (functional edge-count proofs live in the unit suite + were verified live;
// these cells lock the full-pipeline emission + convergence + liveness).
add('digital', 'jkff toggle (tran)', () => ({ circuit: circuit([V('vh', 'VH1', 'DC 5', 'hi', '0'), V('vc', 'VC1', 'PULSE(0 5 0 10n 10n 0.5u 1u)', 'clk', '0'), { id: 'u1', type: 'jkff', designator: 'U1', pins: [{ pinId: 'j', netId: 'hi' }, { pinId: 'k', netId: 'hi' }, { pinId: 'clk', netId: 'clk' }, { pinId: 'q', netId: 'q' }, { pinId: 'qb', netId: 'qb' }] }], N('hi', 'clk', 'q', 'qb')), analysis: { type: 'tran', stopTime: '8u', stepTime: '20n' }, probes: ['v(q)'] }), (r) => baseOk(r, { swing: 4 }));
add('digital', 'tff toggle (tran)', () => ({ circuit: circuit([V('vh', 'VH1', 'DC 5', 'hi', '0'), V('vc', 'VC1', 'PULSE(0 5 0 10n 10n 0.5u 1u)', 'clk', '0'), { id: 'u1', type: 'tff', designator: 'U1', pins: [{ pinId: 't', netId: 'hi' }, { pinId: 'clk', netId: 'clk' }, { pinId: 'q', netId: 'q' }, { pinId: 'qb', netId: 'qb' }] }], N('hi', 'clk', 'q', 'qb')), analysis: { type: 'tran', stopTime: '8u', stepTime: '20n' }, probes: ['v(q)'] }), (r) => baseOk(r, { swing: 4 }));
add('digital', 'dlatch transparent (tran)', () => ({ circuit: circuit([V('vd', 'VD1', 'PULSE(0 5 0 10n 10n 1u 2u)', 'd', '0'), V('ve', 'VE1', 'PULSE(5 0 3u 10n 10n 4u 8u)', 'en', '0'), { id: 'u1', type: 'dlatch', designator: 'U1', pins: [{ pinId: 'd', netId: 'd' }, { pinId: 'en', netId: 'en' }, { pinId: 'q', netId: 'q' }, { pinId: 'qb', netId: 'qb' }] }], N('d', 'en', 'q', 'qb')), analysis: { type: 'tran', stopTime: '5u', stepTime: '20n' }, probes: ['v(q)'] }), (r) => baseOk(r, { swing: 4 }));
add('digital', 'tristate shared bus (tran)', () => ({ circuit: circuit([V('vh', 'VH1', 'DC 5', 'hi', '0'), V('vl', 'VL1', 'DC 0', 'lo', '0'), V('va', 'VA1', 'PULSE(5 0 4u 10n 10n 4u 8u)', 'ena', '0'), V('vb', 'VB1', 'PULSE(0 5 4u 10n 10n 4u 8u)', 'enb', '0'), { id: 'u1', type: 'tristate', designator: 'U1', pins: [{ pinId: 'in1', netId: 'hi' }, { pinId: 'en', netId: 'ena' }, { pinId: 'out', netId: 'bus' }] }, { id: 'u2', type: 'tristate', designator: 'U2', pins: [{ pinId: 'in1', netId: 'lo' }, { pinId: 'en', netId: 'enb' }, { pinId: 'out', netId: 'bus' }] }], N('hi', 'lo', 'ena', 'enb', 'bus')), analysis: { type: 'tran', stopTime: '8u', stepTime: '20n' }, probes: ['v(bus)'] }), (r) => baseOk(r, { swing: 4 }));

// ---------- 12. NAME EDGE-CASES (sanitizer surface) ----------
// A divider whose PROBED middle net is renamed to a tricky token; expect v(mid)=5 regardless of name.
const nameDivider = (mid) => circuit([V('v1', 'V1', 'DC 10', 'sup', '0'), R('r1', 'R1', '1k', 'sup', mid), R('r2', 'R2', '1k', mid, '0')], [{ id: 'sup', name: 'sup' }, { id: mid, name: mid }, gnd]);
for (const nm of ['in', 'out', 'vcc', 'vdd', 'gnd', 'ground', 'e', 'ne', 'eq', 'and', 'or', 'not', 'gt', '1net', '2x', 'net-a', 'net.b']) {
    add('names', `net "${nm}" probes correctly`, () => ({ circuit: nameDivider(nm), analysis: OP, probes: [`v(${nm})`] }), (r) => near(r.series[0]?.final, 5, 0.01) ? ok() : fail(`v(${nm})=${r.series[0]?.final} want 5 (name not resolving)`));
}

// ---------- 13. PROBE FORMS ----------
const probeFix = circuit([V('v1', 'V1', 'DC 10', 'sup', '0'), R('r1', 'R1', '1k', 'sup', 'mid'), C('c1', 'C1', '1u', 'mid', '0'), L('l1', 'L1', '1m', 'sup', 'mid'), { id: 'd1', type: 'diode', designator: 'D1', pins: [{ pinId: 'anode', netId: 'sup' }, { pinId: 'cathode', netId: 'mid' }] }], N('sup', 'mid'));
add('probes', 'v(node)', () => ({ circuit: probeFix, analysis: OP, probes: ['v(mid)'] }), (r) => baseOk(r));
add('probes', 'v(a,b) differential', () => ({ circuit: probeFix, analysis: OP, probes: ['v(sup,mid)'] }), (r) => baseOk(r));
add('probes', 'i(V) native', () => ({ circuit: probeFix, analysis: OP, probes: ['i(V1)'] }), (r) => baseOk(r));
add('probes', 'i(L) native', () => ({ circuit: probeFix, analysis: OP, probes: ['i(L1)'] }), (r) => baseOk(r));
add('probes', 'i(R) -> @r[i]', () => ({ circuit: probeFix, analysis: OP, probes: ['i(R1)'] }), (r) => baseOk(r));
add('probes', 'i(C) -> @c[i]', () => ({ circuit: probeFix, analysis: TRAN, probes: ['i(C1)'] }), (r) => baseOk(r));
add('probes', 'v(out) + i(R) co-probe survive', () => ({ circuit: probeFix, analysis: OP, probes: ['v(mid)', 'i(R1)'] }), (r) => (baseOk(r).pass && r.series.length >= 2) ? ok() : fail(`only ${r.series.length} series — co-probe lost`));
add('probes', 'i(D) dropped, co-probe lives', () => ({ circuit: probeFix, analysis: OP, probes: ['v(mid)', 'i(D1)'] }), (r) => (ran(r) && r.series.some((s) => s.name.includes('mid'))) ? ok() : fail(`v(mid) lost when i(D1) present: ${JSON.stringify(r.errors)}`));
add('probes', 'v(0) ground dropped, co-probe lives', () => ({ circuit: probeFix, analysis: OP, probes: ['v(mid)', 'v(0)'] }), (r) => (ran(r) && r.series.some((s) => s.name.includes('mid'))) ? ok() : fail(`v(mid) lost when v(0) present`));

// ---------- 14. INTERACTIONS ----------
add('interaction', '.dc sweep source remap (BAT1->VBAT1)', () => ({ circuit: circuit([V('v1', 'BAT1', 'DC 0', 'in', '0'), R('r1', 'R1', '1k', 'in', '0')], N('in')), analysis: { type: 'dc', source: 'BAT1', startVal: '0', stopVal: '5', increment: '0.5' }, probes: ['v(in)'] }), (r) => baseOk(r, { swing: 4 }));
add('interaction', 'prefixed device i() remap (FB1->LFB1)', () => ({ circuit: circuit([V('v1', 'V1', 'PULSE(0 5 0 1u 1u 1m 2m)', 'src', '0'), R('r1', 'R1', '10', 'src', 'in'), { id: 'l1', type: 'inductor', designator: 'FB1', value: '1u', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: '0' }] }], N('src', 'in')), analysis: TRAN, probes: ['i(FB1)'] }), (r) => baseOk(r));
add('interaction', 'analog->digital->analog bridge', () => ({ circuit: circuit([V('vdd', 'VDD', 'DC 5', 'vdd', '0'), V('va', 'VA', 'PULSE(0 5 0 10n 10n 0.5u 1u)', 'a', '0'), { id: 'g1', type: 'logic_not', designator: 'XNOT', pins: [{ pinId: 'in1', netId: 'a' }, { pinId: 'out', netId: 'y' }] }, R('rl', 'RL', '10k', 'y', '0')], N('vdd', 'a', 'y')), analysis: TRANu, probes: ['v(y)'] }), (r) => baseOk(r, { swing: 1 }));
// ERC-layer cell (mixed-driver detection lives in runErc, BEFORE netlisting — not in generateNetlist).
add('interaction', 'ERC flags mixed-driver (V + vcvs on one net)', () => ({ circuit: circuit([V('v1', 'V1', 'DC 5', 'out', '0'), { id: 'e1', type: 'vcvs', designator: 'E1', value: '2', pins: [{ pinId: '+', netId: 'out' }, { pinId: '-', netId: '0' }, { pinId: 'c+', netId: 'in' }, { pinId: 'c-', netId: '0' }] }, V('vin', 'VIN', 'DC 1', 'in', '0')], N('out', 'in')) }), (erc) => erc.issues.some((i) => i.severity === 'error') ? ok() : fail(`ERC did not flag two hard drivers on 'out'; issues=${JSON.stringify(erc.issues.map((i) => i.code))}`), { erc: true });

// ---------- 15. REGRESSIONS (defects the adversarial audit found — locked so they can't come back) ----------
// A diode authored with its pin ARRAY reversed (pinIds correct) must still conduct forward, not reverse-mount.
add('regression', 'diode reversed pin-array stays canonical (forward)', () => ({ circuit: circuit([V('v1', 'V1', 'DC 5', 'in', '0'), R('r1', 'R1', '1k', 'in', 'out'), { id: 'd1', type: 'diode', designator: 'D1', pins: [{ pinId: 'cathode', netId: '0' }, { pinId: 'anode', netId: 'out' }] }], N('in', 'out')), analysis: OP, probes: ['v(out)'] }), (r) => (baseOk(r).pass && r.series[0].final < 1) ? ok() : fail(`v(out)=${r.series[0]?.final} — reversed-array diode is reverse-mounted (should forward-conduct ~0.77V, NOT ~5V)`));
// An R/C current probe in AC must be dropped (its @dev[i] is unresolvable in AC) without aborting the line.
add('regression', 'AC R/C current probe dropped, v co-probe survives', () => ({ circuit: circuit([{ id: 'v1', type: 'voltage_source', designator: 'V1', value: 'AC 1', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: '0' }] }, R('r1', 'R1', '1.6k', 'in', 'out'), C('c1', 'C1', '100n', 'out', '0')], N('in', 'out')), analysis: AC, probes: ['v(out)', 'i(R1)', 'i(C1)'] }), (r) => (baseOk(r).pass && r.series.some((s) => s.name.includes('out'))) ? ok() : fail(`AC current probe aborted the line: ok=${baseOk(r).why ?? 'ok'} series=${r.series.map((s) => s.name)}`));
// A passive value with an internal space ('1 k') must normalize and still run.
add('regression', 'passive value with whitespace (1 k) normalized', () => ({ circuit: circuit([V('v1', 'V1', 'DC 10', 'in', '0'), R('r1', 'R1', '1 k', 'in', '0')], N('in')), analysis: OP, probes: ['v(in)'] }), (r) => near(r.series[0]?.final, 10, 0.01) ? ok() : fail(`v(in)=${r.series[0]?.final} — '1 k' value broke the deck`));
// A SINGLE-POINT AC request (startFreq == stopFreq) must return data: `.ac dec N f f` runs with 0 rows and
// the wrdata fails ("no such vector") -> zero data on a valid request. Found by the monster-systems audit.
add('regression', 'single-point AC sweep returns data', () => ({
    circuit: circuit([
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'AC 1', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: '0' }] },
        R('r1', 'R1', '1.6k', 'in', 'out'), C('c1', 'C1', '100n', 'out', '0'),
    ], N('in', 'out')),
    analysis: { type: 'ac', variation: 'dec', points: 10, startFreq: '1k', stopFreq: '1k' }, probes: ['v(out)'],
}), (r) => {
    if (!baseOk(r).pass) return baseOk(r);
    // RC low-pass at fc=1/(2π·1.6k·100n)≈1kHz -> |H(1kHz)| ≈ 0.707
    return r.rows >= 1 && near(r.series[0]?.final, 0.707, 0.05) ? ok() : fail(`rows=${r.rows} |H|=${r.series[0]?.final} want 1 row ≈0.707`);
});
// LED generic models (LEDRED/LEDGRN/...) resolve by NAME like QGENNPN: a diode with model:'LEDRED' must
// auto-inject the vetted body and bias at the color's realistic forward voltage (red ~1.9V at ~9mA).
add('regression', 'LED generic model resolves + realistic Vf', () => ({
    circuit: circuit([
        V('v1', 'V1', 'DC 5', 'vcc', '0'), R('r1', 'R1', '330', 'vcc', 'led'),
        { id: 'd1', type: 'diode', designator: 'DA1', model: 'LEDRED', pins: [{ pinId: 'anode', netId: 'led' }, { pinId: 'cathode', netId: '0' }] },
    ], N('vcc', 'led')),
    analysis: OP, probes: ['v(led)', 'i(R1)'],
}), (r) => {
    if (!baseOk(r).pass) return baseOk(r);
    const vf = r.series[0]?.final, i = Math.abs(r.series[1]?.final ?? 0);
    return near(vf, 1.93, 0.15) && i > 7e-3 && i < 11e-3 ? ok() : fail(`Vf=${vf} (want ~1.9V), I=${i} (want ~9mA) — LEDRED not resolving/biasing right`);
});
// A bsource expression referencing a PURE-DIGITAL net must read the analog _p twin (raw event node would be
// singular in the analog matrix -> gmin garbage). Found by the pairwise sweep (gate-out -> bsource-expr).
add('regression', 'bsource expr on digital net reads the analog twin', () => ({
    circuit: circuit([
        V('vd', 'VD1', 'DC 5', 'vdd', '0'),
        V('va', 'VA1', 'PULSE(0 5 0 10n 10n 5u 10u)', 'a', '0'),
        { id: 'g1', type: 'logic_not', designator: 'XN1', pins: [{ pinId: 'in1', netId: 'a' }, { pinId: 'out', netId: 'q' }] },
        { id: 'b1', type: 'bsource', designator: 'B1', value: 'V=v(q)*0.5+1', pins: [{ pinId: '+', netId: 'bout' }, { pinId: '-', netId: '0' }] },
        R('rl', 'RL1', '1k', 'bout', '0'),
    ], N('vdd', 'a', 'q', 'bout')),
    analysis: { type: 'tran', stopTime: '50u', stepTime: '50n' }, probes: ['v(bout)'],
}), (r) => {
    const b = baseOk(r, { swing: 2 }); // gate q toggles 0..5 -> bout = 0.5*q+1 toggles 1..3.5 (pp 2.5)
    if (!b.pass) return b;
    const s = r.series[0];
    return s.min > 0.5 && s.max < 4 ? ok() : fail(`bout range [${s.min},${s.max}] not ~[1,3.5] — expr not reading the twin`);
});

// ===================== RUN =====================
const results = [];
for (const cell of CELLS) {
    let verdict;
    try {
        const spec = cell.build();
        if (cell.erc) {
            const c = JSON.parse(JSON.stringify(spec.circuit));
            resolveGenericModels(c);
            verdict = cell.expect(runErc(c)); // ERC-layer cell: check the issue list, not ngspice
        } else {
            verdict = cell.expect(runCell(spec.circuit, spec.analysis, spec.probes));
        }
    } catch (e) { verdict = { pass: false, why: `harness error: ${e instanceof Error ? e.message : String(e)}` }; }
    results.push({ group: cell.group, name: cell.name, pass: verdict.pass, why: verdict.why });
}

// ----- grid output -----
const groups = [...new Set(results.map((r) => r.group))];
let pass = 0, total = results.length;
console.log('\n==================== COVERAGE MATRIX ====================\n');
for (const g of groups) {
    const rows = results.filter((r) => r.group === g);
    console.log(`■ ${g.toUpperCase()}`);
    for (const r of rows) {
        if (r.pass) pass++;
        console.log(`   ${r.pass ? '✅' : '❌'}  ${r.name}${r.pass ? '' : `   →  ${r.why}`}`);
    }
    console.log('');
}
const reds = results.filter((r) => !r.pass);
console.log('========================================================');
console.log(`RESULT: ${pass}/${total} cells green  (${reds.length} red)`);
if (reds.length) {
    console.log('\nRED CELLS:');
    for (const r of reds) console.log(`  ❌ [${r.group}] ${r.name}\n       ${r.why}`);
}
if (process.argv.includes('--json')) writeFileSync('coverage-matrix-result.json', JSON.stringify(results.map(({ group, name, pass, why }) => ({ group, name, pass, why })), null, 2));
process.exit(reds.length ? 1 : 0);
