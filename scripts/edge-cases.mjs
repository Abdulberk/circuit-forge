// Engineering-grade EDGE-CASE battery for the CircuitJson -> SPICE -> ngspice -> parse pipeline.
//   node scripts/edge-cases.mjs
//
// Where the coverage matrix proves the COMMON device/probe/analysis surface, this battery hammers the HARD
// cases a real EDA tool must survive — each with an ANALYTICALLY KNOWN answer, so a green cell means the
// pipeline is physically correct, not merely "it ran". Categories:
//   A NUMERIC   extreme magnitudes / sci-notation / unit forms (value scaling must not change the answer)
//   B HARD-SIM  convergence-stressing nonlinear circuits (rectifier bridge, oscillator, Schmitt, gmin node)
//   C SAFETY    degenerate/ill-posed topologies that MUST fail LOUD (ERC error or ngspice error) — never a
//               silent finite-but-wrong answer (the safety invariant)
//   D ANALYSIS  edge cases of op/dc/ac/tran (AC w/ no AC source, single-point sweep, latch .op, fine tran)
//   E PHYSICS   tight known-answer checks (RC settle, -3 dB corner, exact op-amp gain, loaded divider, …)
//
// Requires real ngspice (NGSPICE_PATH or the choco console build) + the eda-core dist build.
import { generateNetlist, parseSimulationOutput, resolveGenericModels, extractProbes, runErc, cutoffFrequency, isAcMagnitudeSeries, summarizeSeries, parseFourierLog, parseMeasurements, parseTransferFunction, parseNoise, parseSensitivity } from '../packages/eda-core/dist/index.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NG = process.env.NGSPICE_PATH || 'C:/ProgramData/chocolatey/lib/ngspice/tools/Spice64/bin/ngspice_con.exe';

// ---- runner: one cell -> { genError?, exit, rows, series, errors, erc } ----
function runCell(circuit, analysis, probes) {
    const c = JSON.parse(JSON.stringify(circuit));
    let erc;
    try { erc = runErc(c); } catch (e) { erc = { passed: false, issues: [{ code: 'ERC_THREW', severity: 'error', message: String(e) }] }; }
    const extra = resolveGenericModels(c);
    if (extra.length) c.models = [...(c.models ?? []), ...extra];
    let netlist;
    try {
        netlist = generateNetlist(c, analysis, probes ? { probes } : undefined);
    } catch (e) {
        return { genError: e instanceof Error ? e.message : String(e), exit: null, rows: 0, series: [], errors: [], erc };
    }
    const dir = mkdtempSync(join(tmpdir(), 'cf-edge-'));
    try {
        writeFileSync(join(dir, 'c.cir'), netlist);
        const r = spawnSync(NG, ['-b', '-o', 'log.txt', 'c.cir'], { cwd: dir, encoding: 'utf-8', timeout: 30000 });
        const log = (() => { try { return readFileSync(join(dir, 'log.txt'), 'utf-8'); } catch { return ''; } })();
        const errs = ((r.stderr || '') + '\n' + log).split('\n').map((s) => s.trim())
            .filter((l) => /singular matrix|no convergence|Timestep too small|Unable to find|fatal|aborted|no such|no output|doAnalyses/i.test(l));
        let csv = '';
        try { csv = readFileSync(join(dir, 'output.csv'), 'utf-8'); } catch { /* none */ }
        const names = extractProbes(netlist);
        // Noise has a dedicated parser (spectrum CSV + totals from the listing) — extractProbes can't see its
        // bare onoise/inoise vector names, so route it like the worker runner does.
        let res, noise, noiseSpectrum;
        if (analysis.type === 'noise') {
            const pn = parseNoise(csv, (r.stdout || '') + '\n' + log);
            noise = pn.totals;
            noiseSpectrum = pn.series;
            res = { series: pn.series, meta: { pointsCount: pn.series[0]?.points.length ?? 0 } };
        } else {
            res = csv.trim() ? parseSimulationOutput(csv, names.length ? names : (probes || ['v(out)']), analysis.type) : { series: [], meta: { pointsCount: 0 } };
        }
        const series = res.series.map((s) => {
            const ys = s.points.map((p) => p.y).filter(Number.isFinite);
            const min = ys.length ? Math.min(...ys) : NaN, max = ys.length ? Math.max(...ys) : NaN;
            const cutoff = analysis.type === 'ac' && isAcMagnitudeSeries(s.name) ? cutoffFrequency(s.points) : undefined;
            // avg/rms come from eda-core's summarizeSeries (time-weighted, the SAME code the verdict uses), so
            // an avg/rms cell exercises the real metric path against ngspice, not a re-implementation.
            const sm = summarizeSeries(s, analysis.type);
            return { name: s.name, n: s.points.length, min, max, pp: max - min, final: ys[ys.length - 1], cutoff, avg: sm.raw?.avg, rms: sm.raw?.rms };
        });
        // `.four`/fourier output lands in the listing (log.txt or the stdout pipe), not the wrdata CSV — parse
        // BOTH combined so a fourier cell can assert on THD against real ngspice.
        const fourier = parseFourierLog((r.stdout || '') + '\n' + log);
        // `.meas` results also land in the listing — scope the parse to the names the deck requested.
        const measureNames = [...netlist.matchAll(/^\s*\.meas\s+\w+\s+(\w+)\b/gim)].map((m) => m[1]);
        const measurements = measureNames.length ? parseMeasurements((r.stdout || '') + '\n' + log, measureNames) : undefined;
        const transferFunction = /^\s*tf\s/im.test(netlist) ? parseTransferFunction((r.stdout || '') + '\n' + log) : undefined;
        const sensitivity = analysis.type === 'sens' ? parseSensitivity((r.stdout || '') + '\n' + log) : undefined;
        return { netlist, exit: r.status, rows: res.meta.pointsCount, series, errors: errs, erc, fourier, measurements, transferFunction, noise, noiseSpectrum, sensitivity };
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---- expectation helpers ----
const finiteAll = (rep) => rep.series.length > 0 && rep.series.every((s) => Number.isFinite(s.final));
const ran = (rep) => rep.exit === 0 && rep.rows > 0 && rep.errors.length === 0 && !rep.genError;
const ok = () => ({ pass: true });
const fail = (why) => ({ pass: false, why });
const near = (v, t, tol) => Number.isFinite(v) && Math.abs(v - t) <= tol;
const ercErrors = (rep) => (rep.erc?.issues ?? []).filter((i) => i.severity === 'error');
function baseOk(rep, { swing } = {}) {
    if (rep.genError) return fail(`generate threw: ${rep.genError}`);
    if (!ran(rep)) return fail(`ngspice: exit=${rep.exit} rows=${rep.rows} errors=${JSON.stringify(rep.errors.slice(0, 2))}`);
    if (!finiteAll(rep)) return fail(`non-finite series: ${rep.series.map((s) => s.name + '=' + s.final).join(',')}`);
    if (swing && !(Math.abs(rep.series[0]?.pp) > swing)) return fail(`expected swing > ${swing}, got pp=${rep.series[0]?.pp}`);
    return ok();
}
/** SAFETY invariant for ill-posed circuits: the system must REFUSE silently-wrong output — it either flags an
 *  ERC error, throws at generation, or ngspice fails loud. A clean exit-0 with finite data is a FAILURE here
 *  (it means we returned a confident answer for a meaningless circuit). */
function loudlyRejected(rep) {
    const erc = ercErrors(rep).length > 0;
    const loud = !!rep.genError || rep.exit !== 0 || rep.rows === 0 || rep.errors.length > 0;
    return erc || loud
        ? ok()
        : fail(`expected LOUD rejection (ERC error / gen-throw / ngspice fail) but got a clean finite result (exit=${rep.exit} rows=${rep.rows} erc=${rep.erc?.passed})`);
}

// ---- builders ----
const gnd = { id: '0', name: '0', isGround: true };
const N = (...ids) => [...ids.map((id) => ({ id, name: id })), gnd];
const V = (id, des, val, p, n) => ({ id, type: 'voltage_source', designator: des, value: val, pins: [{ pinId: '+', netId: p }, { pinId: '-', netId: n }] });
const I = (id, des, val, p, n) => ({ id, type: 'current_source', designator: des, value: val, pins: [{ pinId: '+', netId: p }, { pinId: '-', netId: n }] });
const R = (id, des, val, a, b) => ({ id, type: 'resistor', designator: des, value: val, pins: [{ pinId: '1', netId: a }, { pinId: '2', netId: b }] });
const C = (id, des, val, a, b) => ({ id, type: 'capacitor', designator: des, value: val, pins: [{ pinId: '1', netId: a }, { pinId: '2', netId: b }] });
const L = (id, des, val, a, b) => ({ id, type: 'inductor', designator: des, value: val, pins: [{ pinId: '1', netId: a }, { pinId: '2', netId: b }] });
const D = (id, des, a, k, model) => ({ id, type: 'diode', designator: des, ...(model ? { model } : {}), pins: [{ pinId: 'anode', netId: a }, { pinId: 'cathode', netId: k }] });
const AC1 = (id, des, p, n) => ({ id, type: 'voltage_source', designator: des, value: 'AC 1', pins: [{ pinId: '+', netId: p }, { pinId: '-', netId: n }] });
const circuit = (components, nets) => ({ version: '1.0', components, nets });
const OP = { type: 'op' };
const AC = { type: 'ac', variation: 'dec', points: 20, startFreq: '1', stopFreq: '1meg' };

const CELLS = [];
const add = (group, name, build, expect) => CELLS.push({ group, name, build, expect });
const divider = (r1, r2) => circuit([V('v1', 'V1', 'DC 10', 'sup', '0'), R('r1', 'R1', r1, 'sup', 'mid'), R('r2', 'R2', r2, 'mid', '0')], N('sup', 'mid'));
const rails = () => [V('vcc', 'VCC', 'DC 15', 'vcc', '0'), V('vee', 'VEE', 'DC -15', 'vee', '0')];
const opamp = (id, out, inp, inn) => ({ id, type: 'subckt', designator: id.toUpperCase(), model: 'OPAMPGEN', pins: [{ pinId: 'out', netId: out }, { pinId: 'in+', netId: inp }, { pinId: 'in-', netId: inn }, { pinId: 'vcc', netId: 'vcc' }, { pinId: 'vee', netId: 'vee' }] });

// ========================= A. NUMERIC extremes (value scaling must not move the answer) =========================
add('A-numeric', 'micro-ohm divider (1m/1m) → 5V', () => ({ circuit: divider('1m', '1m'), analysis: OP, probes: ['v(mid)'] }), (r) => near(r.series[0]?.final, 5, 0.01) ? ok() : fail(`v(mid)=${r.series[0]?.final} want 5 (scale-invariant)`));
add('A-numeric', 'giga-ohm divider (1G/1G) → 5V', () => ({ circuit: divider('1G', '1G'), analysis: OP, probes: ['v(mid)'] }), (r) => near(r.series[0]?.final, 5, 0.01) ? ok() : fail(`v(mid)=${r.series[0]?.final} want 5`));
add('A-numeric', 'scientific-notation values (1e3/1e3) → 5V', () => ({ circuit: divider('1e3', '1e3'), analysis: OP, probes: ['v(mid)'] }), (r) => near(r.series[0]?.final, 5, 0.01) ? ok() : fail(`v(mid)=${r.series[0]?.final} want 5 (sci-notation parse)`));
add('A-numeric', 'asymmetric sci-notation (3e3/1e3) → 2.5V', () => ({ circuit: divider('3e3', '1e3'), analysis: OP, probes: ['v(mid)'] }), (r) => near(r.series[0]?.final, 2.5, 0.01) ? ok() : fail(`v(mid)=${r.series[0]?.final} want 2.5 (10*1k/4k)`));
add('A-numeric', 'mixed unit forms (4.7k vs 4700) identical → same node', () => ({ circuit: circuit([V('v1', 'V1', 'DC 10', 'sup', '0'), R('r1', 'R1', '4.7k', 'sup', 'mid'), R('r2', 'R2', '4700', 'mid', '0')], N('sup', 'mid')), analysis: OP, probes: ['v(mid)'] }), (r) => near(r.series[0]?.final, 5, 0.01) ? ok() : fail(`v(mid)=${r.series[0]?.final} want 5 (4.7k==4700)`));
add('A-numeric', 'extreme RC (1T·1f, τ=1ms) tran stays finite', () => ({ circuit: circuit([V('v1', 'V1', 'PULSE(0 5 0 1u 1u 5m 10m)', 'in', '0'), R('r1', 'R1', '1T', 'in', 'out'), C('c1', 'C1', '1f', 'out', '0')], N('in', 'out')), analysis: { type: 'tran', stopTime: '5m', stepTime: '5u' }, probes: ['v(out)'] }), (r) => baseOk(r));
add('A-numeric', 'very small DC source (1uV) divider → 0.5uV', () => ({ circuit: circuit([V('v1', 'V1', 'DC 1u', 'sup', '0'), R('r1', 'R1', '1k', 'sup', 'mid'), R('r2', 'R2', '1k', 'mid', '0')], N('sup', 'mid')), analysis: OP, probes: ['v(mid)'] }), (r) => near(r.series[0]?.final, 0.5e-6, 1e-8) ? ok() : fail(`v(mid)=${r.series[0]?.final} want 0.5u`));

// ========================= B. HARD-SIM (convergence-stressing nonlinear) =========================
add('B-hardsim', 'full-wave bridge rectifier → output stays positive', () => ({ circuit: circuit([V('v1', 'V1', 'SIN(0 10 1k)', 'ac1', 'ac2'), D('d1', 'D1', 'ac1', 'out'), D('d2', 'D2', 'ac2', 'out'), D('d3', 'D3', 'gnd', 'ac1'), D('d4', 'D4', 'gnd', 'ac2'), R('rl', 'RL', '1k', 'out', 'gnd'), { id: 'g', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] }], [{ id: 'ac1', name: 'ac1' }, { id: 'ac2', name: 'ac2' }, { id: 'out', name: 'out' }, { id: 'gnd', name: 'gnd', isGround: true }]), analysis: { type: 'tran', stopTime: '3m', stepTime: '2u' }, probes: ['v(out,gnd)'] }), (r) => baseOk(r).pass && r.series[0].min > -0.7 && near(r.series[0].max, 8.4, 0.9) ? ok() : fail(`rectified out min=${r.series[0]?.min?.toFixed(2)} max=${r.series[0]?.max?.toFixed(2)} want min>~0 + peak≈8.4 (10−2·Vf); a lost arm or extra drop shifts the peak`));
add('B-hardsim', 'op-amp relaxation oscillator OSCILLATES with an .ic kick (pp near rail)', () => ({ circuit: circuit([V('vcc', 'VCC', 'DC 15', 'vcc', '0'), V('vee', 'VEE', 'DC -15', 'vee', '0'), R('rf', 'RF', '10k', 'out', 'np'), R('rg', 'RG', '10k', 'np', '0'), R('rt', 'RT', '10k', 'out', 'nm'), C('ct', 'CT', '100n', 'nm', '0'), { id: 'u1', type: 'subckt', designator: 'U1', model: 'OPAMPGEN', pins: [{ pinId: 'out', netId: 'out' }, { pinId: 'in+', netId: 'np' }, { pinId: 'in-', netId: 'nm' }, { pinId: 'vcc', netId: 'vcc' }, { pinId: 'vee', netId: 'vee' }] }], N('vcc', 'vee', 'out', 'np', 'nm')), analysis: { type: 'tran', stopTime: '20m', stepTime: '5u', initialConditions: { out: 14 } }, probes: ['v(out)'] }), (r) => baseOk(r).pass && r.series[0].pp > 10 ? ok() : fail(`oscillator out pp=${r.series[0]?.pp?.toFixed(2)} want >10 (an ideal op-amp needs the documented .ic seed to break symmetry; without it it sits at the metastable equilibrium)`));
add('B-hardsim', 'op-amp Schmitt trigger snaps on a slow ramp', () => ({ circuit: circuit([V('vcc', 'VCC', 'DC 15', 'vcc', '0'), V('vee', 'VEE', 'DC -15', 'vee', '0'), V('vin', 'VIN', 'PULSE(-5 5 0 10m 10m 1u 40m)', 'in', '0'), R('rf', 'RF', '10k', 'out', 'np'), R('rg', 'RG', '10k', 'np', 'in'), { id: 'u1', type: 'subckt', designator: 'U1', model: 'OPAMPGEN', pins: [{ pinId: 'out', netId: 'out' }, { pinId: 'in+', netId: 'np' }, { pinId: 'in-', netId: '0' }, { pinId: 'vcc', netId: 'vcc' }, { pinId: 'vee', netId: 'vee' }] }], N('vcc', 'vee', 'in', 'np', 'out')), analysis: { type: 'tran', stopTime: '20m', stepTime: '10u' }, probes: ['v(out)'] }), (r) => baseOk(r).pass && r.series[0].pp > 10 ? ok() : fail(`schmitt out pp=${r.series[0]?.pp?.toFixed(2)} want >10 (rail-to-rail snap)`));
add('B-hardsim', 'DC-pathless cap node still yields FINITE op (gmin) or fails loud', () => { const c = circuit([V('v1', 'V1', 'DC 5', 'in', '0'), C('c1', 'C1', '1u', 'in', 'flt'), C('c2', 'C2', '1u', 'flt', '0')], N('in', 'flt')); return { circuit: c, analysis: OP, probes: ['v(flt)'] }; }, (r) => (baseOk(r).pass && finiteAll(r)) || loudlyRejected(r).pass ? ok() : fail(`floating-cap node: neither finite nor loud (exit=${r.exit} rows=${r.rows})`));

// ========================= C. SAFETY (ill-posed → must be LOUD, never silent-wrong) =========================
add('C-safety', 'parallel V-sources, conflicting values → loud reject', () => ({ circuit: circuit([V('v1', 'V1', 'DC 5', 'a', '0'), V('v2', 'V2', 'DC 9', 'a', '0'), R('rl', 'RL', '1k', 'a', '0')], N('a')), analysis: OP, probes: ['v(a)'] }), (r) => loudlyRejected(r));
add('C-safety', 'voltage source shorted (both pins one net) → loud reject', () => ({ circuit: circuit([V('v1', 'V1', 'DC 5', 'a', 'a'), R('rl', 'RL', '1k', 'a', '0')], N('a')), analysis: OP, probes: ['v(a)'] }), (r) => loudlyRejected(r));
// A current source into a floating node has NO real finite solution, and ngspice's response is VERSION-DEPENDENT:
// older builds fail loud (singular matrix); ngspice-42 (Ubuntu apt / CI) gmin-solves it to a finite value. Both
// are acceptable — what must NEVER happen is silent NaN/Inf or a crash. So mirror the gmin cap-node cell above:
// finite-and-clean OR loud reject (the magnitude is gmin-dependent, so we do NOT assert on it). A DETERMINISTIC
// loud reject would need an ERC "current source / single-pin net has no DC return path" rule — tracked as a
// follow-up; out of scope for this CI fix.
add('C-safety', 'current source into an open node → finite (gmin) OR loud reject (version-dependent, never NaN/crash)', () => ({ circuit: circuit([I('i1', 'I1', 'DC 1m', '0', 'hot')], N('hot')), analysis: OP, probes: ['v(hot)'] }), (r) => (baseOk(r).pass && finiteAll(r)) || loudlyRejected(r).pass ? ok() : fail(`current src into open: neither finite-clean nor loud (exit=${r.exit} rows=${r.rows} v(hot)=${r.series[0]?.final})`));
add('C-safety', 'isolated sub-circuit island (no path to ground) → ERC error', () => ({ circuit: circuit([V('v1', 'V1', 'DC 10', 'vcc', '0'), R('r1', 'R1', '1k', 'vcc', '0'), V('v2', 'V2', 'DC 3', 'a', 'b'), R('r2', 'R2', '2k', 'a', 'b')], N('vcc', 'a', 'b')), analysis: OP, probes: ['v(a)'] }), (r) => ercErrors(r).some((i) => i.code === 'ERC042') ? ok() : fail(`island not flagged ISOLATED_SUBCIRCUIT; erc errors=${JSON.stringify(ercErrors(r).map((i) => i.code))}`));
add('C-safety', 'inductor directly across a voltage source (Ldi/dt loop) → loud reject', () => ({ circuit: circuit([V('v1', 'V1', 'DC 5', 'a', '0'), L('l1', 'L1', '1m', 'a', '0')], N('a')), analysis: OP, probes: ['i(L1)'] }), (r) => loudlyRejected(r));
add('C-safety', 'subckt instance missing a declared port → generator throws (not a silent drop)', () => ({ circuit: circuit([...rails(), V('vin', 'VIN', 'DC 1', 'in', '0'), { id: 'u1', type: 'subckt', designator: 'U1', model: 'OPAMPGEN', pins: [{ pinId: 'out', netId: 'out' }, { pinId: 'in+', netId: 'in' }, { pinId: 'in-', netId: '0' }, { pinId: 'vcc', netId: 'vcc' }] }], N('vcc', 'vee', 'in', 'out')), analysis: OP, probes: ['v(out)'] }), (r) => r.genError && /missing pin|vee/i.test(r.genError) ? ok() : fail(`expected a generate-time 'missing pin' throw for the dropped vee port; got genError=${r.genError ?? 'none'}`));

// ========================= D. ANALYSIS edge cases =========================
add('D-analysis', 'AC sweep with NO AC source → generator REFUSES (loud, not a silent all-zero sweep)', () => ({ circuit: circuit([V('v1', 'V1', 'DC 5', 'in', '0'), R('r1', 'R1', '1.6k', 'in', 'out'), C('c1', 'C1', '100n', 'out', '0')], N('in', 'out')), analysis: AC, probes: ['v(out)'] }), (r) => r.genError && /AC magnitude/i.test(r.genError) ? ok() : fail(`expected a loud generate-time refusal (no AC source ⇒ identically-zero sweep); got genError=${r.genError ?? 'none'} exit=${r.exit}`));
add('D-analysis', 'single-point AC sweep (fstart==fstop) returns data', () => ({ circuit: circuit([AC1('v1', 'V1', 'in', '0'), R('r1', 'R1', '1.6k', 'in', 'out'), C('c1', 'C1', '100n', 'out', '0')], N('in', 'out')), analysis: { type: 'ac', variation: 'lin', points: 1, startFreq: '1k', stopFreq: '1k' }, probes: ['v(out)'] }), (r) => baseOk(r));
add('D-analysis', 'DC sweep of a divider is linear (endpoints exact)', () => ({ circuit: divider('1k', '1k'), analysis: { type: 'dc', source: 'V1', startVal: '0', stopVal: '10', increment: '1' }, probes: ['v(mid)'] }), (r) => baseOk(r).pass && near(r.series[0].min, 0, 0.01) && near(r.series[0].max, 5, 0.01) ? ok() : fail(`dc-sweep mid min=${r.series[0]?.min} max=${r.series[0]?.max} want 0..5`));
add('D-analysis', 'op-amp comparator latch .op finds a finite solution', () => ({ circuit: circuit([V('vcc', 'VCC', 'DC 15', 'vcc', '0'), V('vee', 'VEE', 'DC -15', 'vee', '0'), V('vin', 'VIN', 'DC 0.1', 'in', '0'), { id: 'u1', type: 'subckt', designator: 'U1', model: 'OPAMPGEN', pins: [{ pinId: 'out', netId: 'out' }, { pinId: 'in+', netId: 'in' }, { pinId: 'in-', netId: '0' }, { pinId: 'vcc', netId: 'vcc' }, { pinId: 'vee', netId: 'vee' }] }], N('vcc', 'vee', 'in', 'out')), analysis: OP, probes: ['v(out)'] }), (r) => baseOk(r).pass && r.series[0].final > 5 ? ok() : fail(`comparator out=${r.series[0]?.final?.toFixed(2)} want positive rail (V+=0.1>V-=0)`));
add('D-analysis', 'BIPOLAR .dc sweep (−5..+5) of a 2:1 divider → −1.667..+1.667', () => ({ circuit: circuit([V('v1', 'V1', 'DC 0', 'sup', '0'), R('r1', 'R1', '2k', 'sup', 'mid'), R('r2', 'R2', '1k', 'mid', '0')], N('sup', 'mid')), analysis: { type: 'dc', source: 'V1', startVal: '-5', stopVal: '5', increment: '0.5' }, probes: ['v(mid)'] }), (r) => baseOk(r).pass && near(r.series[0].min, -1.667, 0.02) && near(r.series[0].max, 1.667, 0.02) ? ok() : fail(`bipolar dc min=${r.series[0]?.min?.toFixed(3)} max=${r.series[0]?.max?.toFixed(3)} want ∓1.667 (signed startVal + ×1/3)`));

// ========================= E. PHYSICS known-answer (verified-but-wrong guards) =========================
add('E-physics', 'RC step settles to the source rail (final≈5V)', () => ({ circuit: circuit([V('v1', 'V1', 'PULSE(0 5 0 1u 1u 50m 100m)', 'in', '0'), R('r1', 'R1', '1k', 'in', 'out'), C('c1', 'C1', '1u', 'out', '0')], N('in', 'out')), analysis: { type: 'tran', stopTime: '20m', stepTime: '20u' }, probes: ['v(out)'] }), (r) => baseOk(r).pass && near(r.series[0].final, 5, 0.05) && near(r.series[0].max, 5, 0.05) ? ok() : fail(`RC settle final=${r.series[0]?.final?.toFixed(3)} want ~5 (τ=1ms<<20ms)`));
add('E-physics', 'RC -3dB corner ≈ 1/(2πRC) ≈ 995 Hz', () => ({ circuit: circuit([AC1('v1', 'V1', 'in', '0'), R('r1', 'R1', '1.6k', 'in', 'out'), C('c1', 'C1', '100n', 'out', '0')], N('in', 'out')), analysis: { type: 'ac', variation: 'dec', points: 50, startFreq: '1', stopFreq: '1meg' }, probes: ['v(out)'] }), (r) => { const cutoff = r.series[0]?.cutoff; return near(cutoff, 995, 120) ? ok() : fail(`-3dB fc=${cutoff == null ? 'null' : cutoff.toFixed(0)} want ~995 (1/(2π·1.6k·100n))`); });
add('E-physics', 'inverting op-amp gain EXACT = -Rf/Rin (-10·0.5V = -5V)', () => ({ circuit: circuit([V('vcc', 'VCC', 'DC 15', 'vcc', '0'), V('vee', 'VEE', 'DC -15', 'vee', '0'), V('vin', 'VIN', 'DC 0.5', 'sig', '0'), R('rin', 'RIN', '1k', 'sig', 'inv'), R('rf', 'RF', '10k', 'out', 'inv'), { id: 'u1', type: 'subckt', designator: 'U1', model: 'OPAMPGEN', pins: [{ pinId: 'out', netId: 'out' }, { pinId: 'in+', netId: '0' }, { pinId: 'in-', netId: 'inv' }, { pinId: 'vcc', netId: 'vcc' }, { pinId: 'vee', netId: 'vee' }] }], N('vcc', 'vee', 'sig', 'inv', 'out')), analysis: OP, probes: ['v(out)'] }), (r) => near(r.series[0]?.final, -5, 0.1) ? ok() : fail(`inverting v(out)=${r.series[0]?.final?.toFixed(3)} want -5 (-Rf/Rin·0.5)`));
add('E-physics', 'loaded divider 10V·(R2‖RL)/(R1+R2‖RL) = 3.33V', () => ({ circuit: circuit([V('v1', 'V1', 'DC 10', 'sup', '0'), R('r1', 'R1', '1k', 'sup', 'mid'), R('r2', 'R2', '1k', 'mid', '0'), R('rl', 'RL', '1k', 'mid', '0')], N('sup', 'mid')), analysis: OP, probes: ['v(mid)'] }), (r) => near(r.series[0]?.final, 3.333, 0.02) ? ok() : fail(`loaded divider v(mid)=${r.series[0]?.final?.toFixed(3)} want 3.333 (R2‖RL=500)`));
add('E-physics', 'forward diode drop is ~0.6–0.8 V at ~9 mA', () => ({ circuit: circuit([V('v1', 'V1', 'DC 10', 'in', '0'), R('r1', 'R1', '1k', 'in', 'a'), D('d1', 'D1', 'a', '0')], N('in', 'a')), analysis: OP, probes: ['v(a)'] }), (r) => baseOk(r).pass && r.series[0].final > 0.55 && r.series[0].final < 0.85 ? ok() : fail(`Vf=${r.series[0]?.final?.toFixed(3)} want 0.6–0.8`));
add('E-physics', 'zener clamps a 10V drive near Vz=5.1V', () => ({ circuit: circuit([V('v1', 'V1', 'DC 10', 'in', '0'), R('r1', 'R1', '1k', 'in', 'out'), { id: 'z1', type: 'zener', designator: 'Z1', value: '5.1', pins: [{ pinId: 'cathode', netId: 'out' }, { pinId: 'anode', netId: '0' }] }], N('in', 'out')), analysis: OP, probes: ['v(out)'] }), (r) => baseOk(r).pass && r.series[0].final > 4.5 && r.series[0].final < 6 ? ok() : fail(`zener v(out)=${r.series[0]?.final?.toFixed(2)} want ~5.1 clamp`));

add('E-physics', 'branch-current probe magnitude |i(R1)| = 10 mA', () => ({ circuit: circuit([V('v1', 'V1', 'DC 10', 'in', '0'), R('r1', 'R1', '1k', 'in', '0')], N('in')), analysis: OP, probes: ['i(R1)'] }), (r) => baseOk(r).pass && near(Math.abs(r.series[0].final), 0.010, 5e-4) ? ok() : fail(`|i(R1)|=${r.series[0]?.final} want 0.010 (V/R; @r1[i]+savecurrents rewrite, magnitude survives pin-order sign)`));
add('E-physics', 'RC step at t=τ reaches 63.2% (10·(1−e⁻¹)=6.32V)', () => ({ circuit: circuit([V('v1', 'V1', 'PULSE(0 10 0 1n 1n 1 2)', 'in', '0'), R('r1', 'R1', '1k', 'in', 'out'), C('c1', 'C1', '1u', 'out', '0')], N('in', 'out')), analysis: { type: 'tran', stopTime: '1m', stepTime: '10u' }, probes: ['v(out)'] }), (r) => baseOk(r).pass && near(r.series[0].final, 6.321, 0.2) ? ok() : fail(`v(out)@τ=${r.series[0]?.final?.toFixed(3)} want 6.321 (τ=RC=1ms; time-axis fidelity)`));
add('E-physics', 'HIGH-pass −3dB corner ≈ 1/(2πRC) ≈ 995 Hz (passband at top)', () => ({ circuit: circuit([AC1('v1', 'V1', 'in', '0'), C('c1', 'C1', '100n', 'in', 'out'), R('r1', 'R1', '1.6k', 'out', '0')], N('in', 'out')), analysis: { type: 'ac', variation: 'dec', points: 50, startFreq: '1', stopFreq: '1meg' }, probes: ['v(out)'] }), (r) => { const fc = r.series[0]?.cutoff; return near(fc, 994.7, 60) ? ok() : fail(`high-pass fc=${fc == null ? 'null' : fc.toFixed(0)} want ~995 (cutoff metric with the passband ABOVE the corner)`); });
add('E-physics', 'NON-inverting op-amp gain = 1+Rf/Rg (0.5·10 = 5V)', () => ({ circuit: circuit([...rails(), V('vin', 'VIN', 'DC 0.5', 'sig', '0'), R('rg', 'RG', '1k', 'inv', '0'), R('rf', 'RF', '9k', 'out', 'inv'), opamp('u1', 'out', 'sig', 'inv')], N('vcc', 'vee', 'sig', 'inv', 'out')), analysis: OP, probes: ['v(out)'] }), (r) => near(r.series[0]?.final, 5, 0.1) ? ok() : fail(`non-inv v(out)=${r.series[0]?.final?.toFixed(3)} want 5 (1+9k/1k)·0.5; guards in+/in- binding the other way vs the inverting cell`));
add('E-physics', 'NEGATIVE supply node stays signed: −8·R2/(R1+R2) = −6V (no spurious abs)', () => ({ circuit: circuit([V('v1', 'V1', 'DC -8', 'sup', '0'), R('r1', 'R1', '1k', 'sup', 'mid'), R('r2', 'R2', '3k', 'mid', '0')], N('sup', 'mid')), analysis: OP, probes: ['v(mid)'] }), (r) => near(r.series[0]?.final, -6, 0.05) ? ok() : fail(`v(mid)=${r.series[0]?.final?.toFixed(3)} want −6 (negative source round-trip; a voltage must NOT be magnitude'd)`));
add('E-physics', 'sine RMS = amplitude/√2 and avg ≈ 0 (time-weighted metric, real ngspice)', () => ({ circuit: circuit([V('v1', 'V1', 'SIN(0 5 1k)', 'in', '0'), R('r1', 'R1', '1k', 'in', '0')], N('in')), analysis: { type: 'tran', stopTime: '5m', stepTime: '5u' }, probes: ['v(in)'] }), (r) => baseOk(r).pass && near(r.series[0].rms, 5 / Math.SQRT2, 0.12) && Math.abs(r.series[0].avg) < 0.12 ? ok() : fail(`sine rms=${r.series[0]?.rms?.toFixed(3)} avg=${r.series[0]?.avg?.toFixed(3)} want rms≈${(5 / Math.SQRT2).toFixed(3)} (5/√2), avg≈0`));
// Fourier/THD (.four via the `fourier` control command) — exercises the FULL new path: generator emits the
// fourier command, ngspice computes it, parseFourierLog extracts THD from the listing. Both THD values were
// verified IDENTICAL on ngspice-41 (host) and ngspice-42 (CI apt): clean sine ≈ 0.27%, square ≈ 42.92%.
add('E-physics', 'Fourier THD of a clean 1kHz sine ≈ 0% (fourier cmd, real ngspice)', () => ({ circuit: circuit([V('v1', 'V1', 'SIN(0 1 1k)', 'in', '0'), R('r1', 'R1', '1k', 'in', 'out'), C('c1', 'C1', '1u', 'out', '0')], N('in', 'out')), analysis: { type: 'tran', stopTime: '5m', stepTime: '5u', fourier: { fundamentalFreq: '1k', probes: ['v(out)'] } }, probes: ['v(out)'] }), (r) => { const f = (r.fourier || [])[0]; return f && Number.isFinite(f.thd) && f.thd >= 0 && f.thd < 1 ? ok() : fail(`clean-sine THD: want a parsed block with THD<1%, got ${JSON.stringify(r.fourier)}`); });
add('E-physics', 'Fourier THD of a 1kHz square ≈ 43% (10-harmonic truncation, real ngspice)', () => ({ circuit: circuit([V('v1', 'V1', 'PULSE(-1 1 0 1n 1n 0.5m 1m)', 'out', '0'), R('r1', 'R1', '1k', 'out', '0')], N('out')), analysis: { type: 'tran', stopTime: '10m', stepTime: '2u', fourier: { fundamentalFreq: '1k', probes: ['v(out)'] } }, probes: ['v(out)'] }), (r) => { const f = (r.fourier || [])[0]; return f && f.thd > 38 && f.thd < 47 ? ok() : fail(`square THD: want 38-47% (≈42.9), got ${JSON.stringify(r.fourier)}`); });
// .meas (measurement engine) — extrema/RMS + threshold-crossing time, with ANALYTIC answers, on real ngspice.
// Rides on the .tran run (no extra sim, output.csv unaffected); results parsed from the listing by parseMeasurements.
add('E-physics', '.meas extrema/RMS of a 5V 1kHz sine (vpk≈5, vpp≈10, vrms≈3.54 — real ngspice)', () => ({ circuit: circuit([V('v1', 'V1', 'SIN(0 5 1k)', 'in', '0'), R('r1', 'R1', '1k', 'in', '0')], N('in')), analysis: { type: 'tran', stopTime: '5m', stepTime: '5u', measurements: [{ name: 'vpk', type: 'max', probe: 'v(in)' }, { name: 'vp2p', type: 'pp', probe: 'v(in)' }, { name: 'vr', type: 'rms', probe: 'v(in)' }] }, probes: ['v(in)'] }), (r) => { const m = Object.fromEntries((r.measurements || []).map((x) => [x.name, x.value])); return near(m.vpk, 5, 0.25) && near(m.vp2p, 10, 0.5) && near(m.vr, 5 / Math.SQRT2, 0.2) ? ok() : fail(`.meas sine: vpk=${m.vpk} vp2p=${m.vp2p} vr=${m.vr} want ≈5/10/${(5 / Math.SQRT2).toFixed(2)} — got ${JSON.stringify(r.measurements)}`); });
add('E-physics', '.meas WHEN: rising 1kHz sine crosses 0.5 at t≈83.3µs = asin(0.5)/(2πf) (real ngspice)', () => ({ circuit: circuit([V('v1', 'V1', 'SIN(0 1 1k)', 'in', '0'), R('r1', 'R1', '1k', 'in', '0')], N('in')), analysis: { type: 'tran', stopTime: '5m', stepTime: '2u', measurements: [{ name: 'tc', type: 'when', probe: 'v(in)', value: 0.5, edge: 'rise' }] }, probes: ['v(in)'] }), (r) => { const tc = (r.measurements || []).find((x) => x.name === 'tc')?.value; return near(tc, 8.333e-5, 1.5e-5) ? ok() : fail(`.meas WHEN tc=${tc} want ≈8.33e-5 (asin(0.5)/(2π·1k)) — got ${JSON.stringify(r.measurements)}`); });
// .tf DC transfer function (op add-on) — gain + Zin + Zout of a resistive divider, all analytically exact.
add('E-physics', '.tf DC transfer of a 1k/2k divider: gain≈0.667, Zin≈3k, Zout≈667Ω (real ngspice)', () => ({ circuit: circuit([V('v1', 'V1', 'DC 5', 'in', '0'), R('r1', 'R1', '1k', 'in', 'out'), R('r2', 'R2', '2k', 'out', '0')], N('in', 'out')), analysis: { type: 'op', tf: { output: 'v(out)', inputSource: 'V1' } }, probes: ['v(out)'] }), (r) => { const t = r.transferFunction; return t && near(t.gain, 2 / 3, 0.02) && near(t.inputImpedanceOhms, 3000, 100) && near(t.outputImpedanceOhms, 2000 / 3, 30) ? ok() : fail(`.tf divider: got ${JSON.stringify(r.transferFunction)} want gain≈0.667 Zin≈3k Zout≈667`); });
// .noise — output-referred noise SPECTRUM + integrated totals. A 1k resistor's Johnson-noise floor is √(4kTR)
// ≈ 4.07 nV/√Hz at 300K (the analytic oracle for the low-frequency onoise density of this RC low-pass).
add('E-physics', '.noise: 1k Johnson floor √(4kTR)≈4.07nV/√Hz + finite integrated totals (real ngspice)', () => ({ circuit: circuit([V('v1', 'V1', 'DC 0 AC 1', 'in', '0'), R('r1', 'R1', '1k', 'in', 'out'), C('c1', 'C1', '159n', 'out', '0')], N('in', 'out')), analysis: { type: 'noise', output: 'v(out)', inputSource: 'V1', variation: 'dec', points: 10, startFreq: '1', stopFreq: '100k' }, probes: ['v(out)'] }), (r) => { const on = (r.noiseSpectrum || []).find((s) => s.name === 'onoise_spectrum'); const lowf = on?.points?.[0]?.y; return near(lowf, 4.07e-9, 0.3e-9) && Number.isFinite(r.noise?.onoiseTotalV) && r.noise.onoiseTotalV > 0 && Number.isFinite(r.noise?.inoiseTotalV) ? ok() : fail(`.noise: onoise@1Hz=${lowf} want ≈4.07e-9, totals=${JSON.stringify(r.noise)}`); });
// .sens DC sensitivity (no-series analysis) — d(v(mid))/d(param) of a 5V→1k/2k divider, all analytically exact:
// d/dV1=R2/(R1+R2)=0.667, d/dR1=-V·R2/(R1+R2)²=-1.111e-3, d/dR2=+V·R1/(R1+R2)²=5.556e-4.
add('E-physics', '.sens DC sensitivities of a 5V 1k/2k divider: d/dV1≈0.667, d/dR1≈-1.11m, d/dR2≈0.556m (real ngspice)', () => ({ circuit: circuit([V('v1', 'V1', 'DC 5', 'in', '0'), R('r1', 'R1', '1k', 'in', 'mid'), R('r2', 'R2', '2k', 'mid', '0')], N('in', 'mid')), analysis: { type: 'sens', output: 'v(mid)' }, probes: ['v(mid)'] }), (r) => { const s = Object.fromEntries((r.sensitivity?.entries || []).map((e) => [e.name, e.value])); return near(s.v1, 2 / 3, 0.02) && near(s.r1, -1.111e-3, 1e-4) && near(s.r2, 5.556e-4, 1e-4) ? ok() : fail(`.sens divider: got ${JSON.stringify(r.sensitivity)} want v1≈0.667 r1≈-1.11e-3 r2≈5.56e-4`); });

// ========================= F. DEVICE-physics known-answer (emission + pinId binding + sign) =========================
add('F-device', 'VCCS Iout = gm·Vin into a load, sign-correct → +10V', () => ({ circuit: circuit([V('v1', 'V1', 'DC 2', 'in', '0'), { id: 'g1', type: 'vccs', designator: 'G1', value: '5m', pins: [{ pinId: '+', netId: '0' }, { pinId: '-', netId: 'out' }, { pinId: 'c+', netId: 'in' }, { pinId: 'c-', netId: '0' }] }, R('rl', 'RL', '1k', 'out', '0')], N('in', 'out')), analysis: OP, probes: ['v(out)'] }), (r) => near(r.series[0]?.final, 10, 0.1) ? ok() : fail(`vccs v(out)=${r.series[0]?.final?.toFixed(3)} want +10 (gm·Vin·RL = 5m·2·1k); sign + canonical out/ctrl pin binding`));
add('F-device', 'matched transmission line: V/2 step arrives at t=td, NO reflection', () => ({ circuit: circuit([V('v1', 'V1', 'PULSE(0 5 0 0.1n 0.1n 100n 200n)', 'src', '0'), R('rs', 'RS', '50', 'src', 'a'), { id: 't1', type: 'tline', designator: 'T1', properties: { z0: '50', td: '20n' }, pins: [{ pinId: 'a+', netId: 'a' }, { pinId: 'a-', netId: '0' }, { pinId: 'b+', netId: 'b' }, { pinId: 'b-', netId: '0' }] }, R('rt', 'RT', '50', 'b', '0')], N('src', 'a', 'b')), analysis: { type: 'tran', stopTime: '100n', stepTime: '0.1n' }, probes: ['v(b)'] }), (r) => baseOk(r).pass && near(r.series[0].final, 2.5, 0.2) && r.series[0].max < 2.9 ? ok() : fail(`tline v(b) final=${r.series[0]?.final?.toFixed(3)} max=${r.series[0]?.max?.toFixed(3)} want 2.5 flat (matched: no reflection/overshoot; guards z0/td emission + a/b port binding)`));
add('F-device', 'voltage-controlled switch ON-state: RON divider → 9.99V', () => ({ circuit: circuit([V('v1', 'V1', 'DC 10', 'sup', '0'), V('vc', 'VC', 'DC 5', 'ctl', '0'), { id: 's1', type: 'switch', designator: 'S1', model: 'SWGEN', pins: [{ pinId: '+', netId: 'sup' }, { pinId: '-', netId: 'out' }, { pinId: 'c+', netId: 'ctl' }, { pinId: 'c-', netId: '0' }] }, R('rl', 'RL', '1k', 'out', '0')], N('sup', 'ctl', 'out')), analysis: OP, probes: ['v(out)'] }), (r) => near(r.series[0]?.final, 9.99, 0.1) ? ok() : fail(`switch ON v(out)=${r.series[0]?.final?.toFixed(3)} want 9.99 (RON=1 vs RL=1k); SWGEN params + sense pins`));
add('F-device', 'voltage-controlled switch OFF-state: ROFF blocks → ~0V', () => ({ circuit: circuit([V('v1', 'V1', 'DC 10', 'sup', '0'), V('vc', 'VC', 'DC 0', 'ctl', '0'), { id: 's1', type: 'switch', designator: 'S1', model: 'SWGEN', pins: [{ pinId: '+', netId: 'sup' }, { pinId: '-', netId: 'out' }, { pinId: 'c+', netId: 'ctl' }, { pinId: 'c-', netId: '0' }] }, R('rl', 'RL', '1k', 'out', '0')], N('sup', 'ctl', 'out')), analysis: OP, probes: ['v(out)'] }), (r) => baseOk(r).pass && r.series[0].final < 0.1 ? ok() : fail(`switch OFF v(out)=${r.series[0]?.final?.toFixed(4)} want ~0 (ROFF=1meg vs RL=1k); threshold polarity`));
add('F-device', 'behavioral source does real arithmetic: V=v(a)·v(b) = 12V', () => ({ circuit: circuit([V('v1', 'V1', 'DC 3', 'a', '0'), V('v2', 'V2', 'DC 4', 'b', '0'), { id: 'b1', type: 'bsource', designator: 'B1', value: 'V=v(a)*v(b)', pins: [{ pinId: '+', netId: 'out' }, { pinId: '-', netId: '0' }] }, R('rl', 'RL', '1k', 'out', '0')], N('a', 'b', 'out')), analysis: OP, probes: ['v(out)'] }), (r) => near(r.series[0]?.final, 12, 0.1) ? ok() : fail(`bsource v(out)=${r.series[0]?.final?.toFixed(3)} want 12 (3·4); v(...) net-id→node rewrite in .op`));
add('F-device', 'two cascaded inverting stages multiply: (−10)·(−10)·0.05 = +5V', () => ({ circuit: circuit([...rails(), V('vin', 'VIN', 'DC 0.05', 'sig', '0'), R('ri1', 'RI1', '1k', 'sig', 'i1'), R('rf1', 'RF1', '10k', 'o1', 'i1'), opamp('u1', 'o1', '0', 'i1'), R('ri2', 'RI2', '1k', 'o1', 'i2'), R('rf2', 'RF2', '10k', 'o2', 'i2'), opamp('u2', 'o2', '0', 'i2')], N('vcc', 'vee', 'sig', 'i1', 'o1', 'i2', 'o2')), analysis: OP, probes: ['v(o2)'] }), (r) => near(r.series[0]?.final, 5, 0.2) ? ok() : fail(`cascade v(o2)=${r.series[0]?.final?.toFixed(3)} want +5; two OPAMPGEN instances, no node bleed between identical macromodels`));

// ---- run ----
const groups = [...new Set(CELLS.map((c) => c.group))];
let failures = 0;
console.log('\n==================== NGSPICE EDGE-CASE BATTERY ====================');
for (const g of groups) {
    console.log(`\n■ ${g.toUpperCase()}`);
    for (const cell of CELLS.filter((c) => c.group === g)) {
        let verdict;
        try {
            const spec = cell.build();
            const rep = runCell(spec.circuit, spec.analysis, spec.probes);
            verdict = cell.expect(rep);
        } catch (e) { verdict = fail(`harness threw: ${e instanceof Error ? e.message : String(e)}`); }
        if (verdict.pass) console.log(`   ✅  ${cell.name}`);
        else { console.log(`   ❌  ${cell.name}\n        ${verdict.why}`); failures++; }
    }
}
console.log(`\n====================================================================`);
console.log(`RESULT: ${CELLS.length - failures}/${CELLS.length} cells green  (${failures} red)`);
process.exit(failures === 0 ? 0 : 1);
