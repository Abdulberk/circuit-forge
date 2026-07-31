// Seeded circuit fuzzer: generate random (frequently pathological, occasionally hostile-named) circuits and
// run them through the full pipeline. It does NOT assert that random circuits "work" — most are electrical
// nonsense. It asserts the engine's SAFETY INVARIANT: every outcome is either (a) finite parseable data, or
// (b) a LOUD, diagnosable failure (clean generateNetlist throw / captured ngspice error). The bug classes:
//   SILENT-EMPTY   ngspice exit 0, no output, no error captured anywhere — the caller sees nothing.
//   NON-FINITE     parsed series contain NaN/Inf presented as data.
//   UGLY-THROW           generateNetlist threw something that is NOT a declared DeckRefusal — an internal
//                       fault (TypeError / "undefined" internals), however loud it looked.
//   UNDECLARED-REFUSAL  the same, on a circuit ERC declared clean: the pre-simulation gate let through
//                       something nothing had a considered answer for. This is the invariant that needs no
//                       list of failure classes, so it catches the ones nobody has thought of yet.
//
//   node scripts/fuzz-circuits.mjs [seed] [count]     (defaults: seed=12345, count=150; deterministic)
import {
    generateNetlist,
    parseSimulationOutput,
    resolveGenericModels,
    extractProbes,
    runErc,
    isDeckRefusal,
} from '../packages/eda-core/dist/index.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NG = process.env.NGSPICE_PATH || 'C:/ProgramData/chocolatey/lib/ngspice/tools/Spice64/bin/ngspice_con.exe'; // CONSOLE build — the choco-shim ngspice.exe is the GUI build: it writes NO log in -b mode (silent empty) and zombies on hangs
const SEED = Number(process.argv[2] ?? 12345);
const COUNT = Number(process.argv[3] ?? 150);

// mulberry32 — deterministic PRNG
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = rng(SEED);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const irange = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const RVALS = ['10', '100', '1k', '4.7k', '10k', '100k', '1meg'];
const CVALS = ['10p', '1n', '10n', '100n', '1u', '10u'];
const LVALS = ['1u', '100u', '1m', '10m'];
const SRC_VALS = [
    'DC 5',
    'DC 12',
    'DC -5',
    'SIN(0 2 1k)',
    'SIN(0 5 10k)',
    'PULSE(0 5 0 1u 1u 50u 100u)',
    'AC 1',
    'DC 5 AC 1',
];
const HOSTILE_NAMES = ['e', 'ne', 'in', 'out', 'vcc', 'gnd', '2x', 'net-a', 'and', 'tran'];

function randomCircuit(i) {
    const netCount = irange(3, 9);
    const nets = ['0'];
    for (let k = 1; k <= netCount; k++) {
        nets.push(rand() < 0.15 ? `${pick(HOSTILE_NAMES)}${k}` : rand() < 0.08 ? pick(HOSTILE_NAMES) : `n${i}_${k}`);
    }
    const uniq = [...new Set(nets)];
    const anyNet = () => pick(uniq);

    const comps = [];
    let id = 0;
    const add = (c) => comps.push({ ...c, id: `c${i}_${id++}` });

    // Always at least one voltage source so the circuit has excitation.
    add({
        type: 'voltage_source',
        designator: `V${id}`,
        value: pick(SRC_VALS),
        pins: [
            { pinId: '+', netId: anyNet() },
            { pinId: '-', netId: pick([...uniq, '0', '0']) },
        ],
    });

    const n = irange(3, 22);
    for (let k = 0; k < n; k++) {
        const t = pick([
            'resistor',
            'resistor',
            'resistor',
            'capacitor',
            'capacitor',
            'inductor',
            'diode',
            'zener',
            'bjt',
            'mosfet',
            'voltage_source',
            'current_source',
            'vcvs',
            'bsource',
            'switch',
            'logic_and',
            'logic_not',
            'dff',
            'subckt',
        ]);
        switch (t) {
            case 'resistor':
                add({
                    type: t,
                    designator: `R${id}`,
                    value: pick(RVALS),
                    pins: [
                        { pinId: '1', netId: anyNet() },
                        { pinId: '2', netId: anyNet() },
                    ],
                });
                break;
            case 'capacitor':
                add({
                    type: t,
                    designator: `C${id}`,
                    value: pick(CVALS),
                    pins: [
                        { pinId: '1', netId: anyNet() },
                        { pinId: '2', netId: anyNet() },
                    ],
                });
                break;
            case 'inductor':
                add({
                    type: t,
                    designator: `L${id}`,
                    value: pick(LVALS),
                    pins: [
                        { pinId: '1', netId: anyNet() },
                        { pinId: '2', netId: anyNet() },
                    ],
                });
                break;
            case 'diode':
                add({
                    type: t,
                    designator: `D${id}`,
                    pins: [
                        { pinId: 'anode', netId: anyNet() },
                        { pinId: 'cathode', netId: anyNet() },
                    ],
                });
                break;
            case 'zener':
                add({
                    type: t,
                    designator: `Z${id}`,
                    value: pick(['3.3', '5.1', '12']),
                    pins: [
                        { pinId: 'anode', netId: anyNet() },
                        { pinId: 'cathode', netId: anyNet() },
                    ],
                });
                break;
            case 'bjt':
                add({
                    type: t,
                    designator: `Q${id}`,
                    model: pick(['QGENNPN', 'QGENPNP']),
                    pins: [
                        { pinId: 'c', netId: anyNet() },
                        { pinId: 'b', netId: anyNet() },
                        { pinId: 'e', netId: anyNet() },
                    ],
                });
                break;
            case 'mosfet':
                add({
                    type: t,
                    designator: `M${id}`,
                    model: pick(['MGENNMOS', 'MGENPMOS']),
                    pins: [
                        { pinId: 'd', netId: anyNet() },
                        { pinId: 'g', netId: anyNet() },
                        { pinId: 's', netId: anyNet() },
                        { pinId: 'b', netId: anyNet() },
                    ],
                });
                break;
            case 'voltage_source':
                add({
                    type: t,
                    designator: `V${id}`,
                    value: pick(SRC_VALS),
                    pins: [
                        { pinId: '+', netId: anyNet() },
                        { pinId: '-', netId: anyNet() },
                    ],
                });
                break;
            case 'current_source':
                add({
                    type: t,
                    designator: `I${id}`,
                    value: pick(['DC 1m', 'DC 10m']),
                    pins: [
                        { pinId: '+', netId: anyNet() },
                        { pinId: '-', netId: anyNet() },
                    ],
                });
                break;
            case 'vcvs':
                add({
                    type: t,
                    designator: `E${id}`,
                    value: pick(['0.5', '2', '10']),
                    pins: [
                        { pinId: '+', netId: anyNet() },
                        { pinId: '-', netId: anyNet() },
                        { pinId: 'c+', netId: anyNet() },
                        { pinId: 'c-', netId: anyNet() },
                    ],
                });
                break;
            case 'bsource':
                add({
                    type: t,
                    designator: `B${id}`,
                    value: `V=v(${anyNet()})*${pick(['0.5', '2'])}+${pick(['0', '1'])}`,
                    pins: [
                        { pinId: '+', netId: anyNet() },
                        { pinId: '-', netId: anyNet() },
                    ],
                });
                break;
            case 'switch':
                add({
                    type: t,
                    designator: `S${id}`,
                    model: 'SWGEN',
                    pins: [
                        { pinId: '+', netId: anyNet() },
                        { pinId: '-', netId: anyNet() },
                        { pinId: 'c+', netId: anyNet() },
                        { pinId: 'c-', netId: anyNet() },
                    ],
                });
                break;
            case 'logic_and':
                add({
                    type: t,
                    designator: `XA${id}`,
                    pins: [
                        { pinId: 'in1', netId: anyNet() },
                        { pinId: 'in2', netId: anyNet() },
                        { pinId: 'out', netId: anyNet() },
                    ],
                });
                break;
            case 'logic_not':
                add({
                    type: t,
                    designator: `XN${id}`,
                    pins: [
                        { pinId: 'in1', netId: anyNet() },
                        { pinId: 'out', netId: anyNet() },
                    ],
                });
                break;
            case 'dff':
                add({
                    type: t,
                    designator: `U${id}`,
                    pins: [
                        { pinId: 'd', netId: anyNet() },
                        { pinId: 'clk', netId: anyNet() },
                        { pinId: 'q', netId: anyNet() },
                        { pinId: 'qb', netId: anyNet() },
                    ],
                });
                break;
            case 'subckt':
                add({
                    type: t,
                    designator: `U${id}`,
                    model: 'OPAMPGEN',
                    pins: [
                        { pinId: 'out', netId: anyNet() },
                        { pinId: 'in+', netId: anyNet() },
                        { pinId: 'in-', netId: anyNet() },
                        { pinId: 'vcc', netId: anyNet() },
                        { pinId: 'vee', netId: anyNet() },
                    ],
                });
                break;
        }
    }

    const circuit = {
        version: '1.0',
        components: comps,
        nets: uniq.map((id2) => (id2 === '0' ? { id: '0', name: '0', isGround: true } : { id: id2, name: id2 })),
    };

    // Random analysis (weighted to tran); AC sometimes lacks an AC source on purpose (the guard must throw).
    const aPick = rand();
    const analysis =
        aPick < 0.6
            ? { type: 'tran', stopTime: '200u', stepTime: '500n' }
            : aPick < 0.75
              ? { type: 'op' }
              : aPick < 0.9
                ? { type: 'dc', source: comps[0].designator, startVal: '0', stopVal: '5', increment: '0.5' }
                : { type: 'ac', variation: 'dec', points: 5, startFreq: '10', stopFreq: '100k' };

    // 1-3 random probes; occasionally a current probe on a random designator.
    const probes = [];
    const np = irange(1, 3);
    for (let k = 0; k < np; k++) probes.push(rand() < 0.25 ? `i(${pick(comps).designator})` : `v(${anyNet()})`);

    return { circuit, analysis, probes };
}

// A deliberate refusal is a PASS (fail-loud); anything else escaping the generator is an internal fault.
// This used to be a regex over error MESSAGES — so the list of intentional refusals lived HERE, in the
// test, rather than with the code that raises them, and rewording a message silently reclassified a
// deliberate refusal as a bug (or a bug as fine). eda-core types them now, and a type cannot drift from
// the throw that carries it.

let okData = 0,
    okLoud = 0,
    convergeFail = 0;
const bugs = [];
const t0 = Date.now();

for (let i = 0; i < COUNT; i++) {
    const { circuit, analysis, probes } = randomCircuit(i);
    const c = JSON.parse(JSON.stringify(circuit));
    let ercErrors;
    try {
        ercErrors = runErc(c).issues.filter((x) => x.severity === 'error');
    } catch (e) {
        bugs.push({ i, kind: 'ERC-CRASH', detail: String((e && e.message) || e) });
        continue;
    }
    const extra = (() => {
        try {
            return resolveGenericModels(c);
        } catch (e) {
            bugs.push({ i, kind: 'RESOLVE-CRASH', detail: String((e && e.message) || e) });
            return null;
        }
    })();
    if (extra === null) continue;
    if (extra.length) c.models = [...(c.models ?? []), ...extra];

    let netlist;
    try {
        netlist = generateNetlist(c, analysis, { probes });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // The invariant, and it does not need to know the failure CLASS — which is what makes it a
        // guarantee rather than a list: it catches the refusal nobody has thought of yet.
        //
        // An UNDECLARED refusal is the bug. A DeckRefusal is a considered statement about the input and
        // carries its reason, so a caller — the design loop, a user — can act on it immediately; that is
        // acceptable even when ERC did not predict it, because nothing is left unexplained. Anything else
        // escaping the generator is a statement about OUR code, and is a fault however loud it is.
        if (!isDeckRefusal(e)) {
            bugs.push({
                i,
                kind: ercErrors.length === 0 ? 'UNDECLARED-REFUSAL' : 'UGLY-THROW',
                detail: msg.slice(0, 200),
            });
            continue;
        }
        okLoud++;
        continue;
    }

    const dir = mkdtempSync(join(tmpdir(), 'cf-fuzz-'));
    try {
        writeFileSync(join(dir, 'c.cir'), netlist);
        const r = spawnSync(NG, ['-b', '-o', 'log.txt', 'c.cir'], { cwd: dir, encoding: 'utf-8', timeout: 15000 });
        const log = (() => {
            try {
                return readFileSync(join(dir, 'log.txt'), 'utf-8');
            } catch {
                return '';
            }
        })();
        const errs = ((r.stderr || '') + '\n' + log)
            .split('\n')
            .map((s) => s.trim())
            .filter((x) =>
                /singular matrix|no convergence|Timestep too small|Unable to find|fatal|aborted|no such|error|warning/i.test(
                    x,
                ),
            );
        let csv = '';
        try {
            csv = readFileSync(join(dir, 'output.csv'), 'utf-8');
        } catch {
            /* none */
        }

        if (!csv.trim()) {
            if (errs.length || r.status !== 0 || r.signal) {
                convergeFail++;
                continue;
            } // loud failure: diagnosable
            try {
                writeFileSync(`.stress/fuzz-bug-${i}.cir`, netlist);
            } catch {
                /* no .stress dir */
            }
            bugs.push({
                i,
                kind: 'SILENT-EMPTY',
                detail: `exit=${r.status}, no output.csv, no error lines (deck saved to .stress/fuzz-bug-${i}.cir)`,
                netlist: netlist.slice(0, 800),
                log: log.slice(0, 1500),
                stderr: (r.stderr || '').slice(0, 500),
                analysis: JSON.stringify(analysis),
                probes: JSON.stringify(probes),
            });
            continue;
        }
        const names = extractProbes(netlist);
        let res;
        try {
            res = parseSimulationOutput(csv, names.length ? names : probes, analysis.type);
        } catch (e) {
            bugs.push({ i, kind: 'PARSE-CRASH', detail: String((e && e.message) || e).slice(0, 200) });
            continue;
        }
        const nonFinite = res.series.some((s) => s.points.some((p) => !Number.isFinite(p.y)));
        if (nonFinite) {
            bugs.push({ i, kind: 'NON-FINITE', detail: 'NaN/Inf presented as data', netlist: netlist.slice(0, 800) });
            continue;
        }
        okData++;
    } finally {
        // A timed-out ngspice can still hold the dir on Windows (EBUSY) — retry, then give up quietly
        // (the OS temp dir is periodically cleaned; a leaked dir must not abort the fuzz run).
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {
            /* leaked temp dir */
        }
    }
}

console.log(
    `\n==================== FUZZ (seed=${SEED}, n=${COUNT}, ${((Date.now() - t0) / 1000).toFixed(0)}s) ====================`,
);
console.log(`finite data:        ${okData}`);
console.log(`loud gen-throw:     ${okLoud}   (engineered fail-loud — OK)`);
console.log(`loud ngspice fail:  ${convergeFail}   (diagnosable convergence/etc — OK)`);
console.log(`SAFETY BUGS:        ${bugs.length}`);
for (const b of bugs) {
    console.log(`\n--- BUG [${b.kind}] circuit #${b.i}\n    ${b.detail}`);
    if (b.analysis) console.log(`    analysis: ${b.analysis}  probes: ${b.probes}`);
    if (b.netlist)
        console.log(
            '    netlist head:\n' +
                b.netlist
                    .split('\n')
                    .slice(0, 24)
                    .map((l) => '      ' + l)
                    .join('\n'),
        );
    if (b.log)
        console.log(
            '    ngspice log:\n' +
                b.log
                    .split('\n')
                    .map((l) => '      ' + l)
                    .join('\n'),
        );
    if (b.stderr)
        console.log(
            '    stderr:\n' +
                b.stderr
                    .split('\n')
                    .map((l) => '      ' + l)
                    .join('\n'),
        );
}
process.exit(bugs.length ? 1 : 0);
