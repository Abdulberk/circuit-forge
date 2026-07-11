// Real-ngspice proof for the MC/corner "current criterion" fix (arch-review debt #1).
//   node scripts/robustness-current-check.mjs
//
// The bug: the Monte-Carlo yield + worst-case corner batches regenerated each variant's netlist with NO
// criterion-derived probes, so the generator's voltage-only default sweep never saved a branch current. A
// design whose ONLY acceptance criterion is a current (e.g. "i(R1) > 2 mA") therefore read "probe not found"
// on EVERY variant → yield collapsed to ~0 % and passAllCorners went false, even though the nominal verify
// PASSED (the nominal path unions the same probe in). A direct trust contradiction: "verified" but "0 % robust".
//
// The fix: extraProbesForCriteria(criteria) is the ONE shared derivation; the batch runners now union it into
// every variant exactly like the nominal path. This script runs REAL ngspice through the REAL eda-core
// orchestrators (runMonteCarlo / runWorstCase) BEFORE (no extra probes) and AFTER (the shared derivation) and
// asserts the yield/passAllCorners flip. No mocks — the whole generator → ngspice → parser → assertion path runs.
import {
    generateNetlist,
    parseSimulationOutput,
    extractProbes,
    summarizeSeries,
    runMonteCarlo,
    runWorstCase,
    extraProbesForCriteria,
} from '../packages/eda-core/dist/index.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NG = process.env.NGSPICE_PATH || 'C:/ProgramData/chocolatey/lib/ngspice/tools/Spice64/bin/ngspice_con.exe'; // CONSOLE build (the choco-shim ngspice.exe is the GUI build: silent-empty in -b mode)

const ANALYSIS = { type: 'op' };
// A 5 V source across two 1 kΩ ±5 % resistors → I(R1) = 5 V / 2 kΩ = 2.5 mA nominal, and 2.38–2.63 mA across
// every ±5 % corner. The ONLY criterion is that current, so if it isn't saved the design looks 0 % robust.
const CIRCUIT = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: '0' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', tolerance: 0.05, pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '1k', tolerance: 0.05, pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: '0' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: '0', name: '0', isGround: true }],
};
// Peak-magnitude current criterion: 2.38–2.63 mA is comfortably > 2 mA at every corner (a sound design).
const CRITERIA = [{ probe: 'i(R1)', metric: 'max', op: 'gt', value: 0.002, label: 'I(R1) > 2 mA' }];

/** A REAL per-variant ngspice runner mirroring the worker's makeVariantRunner: generateNetlist WITH the given
 *  extraProbes → ngspice -b → parse → per-node scalar measurements. Returns null on any un-runnable variant. */
const makeRealRunner = (extraProbes) => async (variant) => {
    let netlist;
    try {
        netlist = generateNetlist(variant, ANALYSIS, extraProbes?.length ? { extraProbes } : {});
    } catch {
        return null;
    }
    const dir = mkdtempSync(join(tmpdir(), 'cf-rob-'));
    try {
        writeFileSync(join(dir, 'c.cir'), netlist);
        const r = spawnSync(NG, ['-b', '-o', 'log.txt', 'c.cir'], { cwd: dir, encoding: 'utf-8', timeout: 30000 });
        if (r.status !== 0) return null;
        let csv = '';
        try { csv = readFileSync(join(dir, 'output.csv'), 'utf-8'); } catch { return null; }
        if (!csv.trim()) return null;
        const res = parseSimulationOutput(csv, extractProbes(netlist), ANALYSIS.type);
        return res.series.map((s) => summarizeSeries(s, ANALYSIS.type));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

async function main() {
    if (!existsSync(NG)) {
        console.log(`SKIP: ngspice not found at ${NG} (set NGSPICE_PATH). This harness needs the real binary.`);
        process.exit(0);
    }

    // Preflight: the divider must actually simulate at nominal (else the whole comparison is meaningless).
    const nominal = await makeRealRunner(extraProbesForCriteria(CRITERIA))(CIRCUIT);
    const iMeas = nominal?.find((m) => /r1/i.test(m.node) && /\[i\]|i\(/i.test(m.node)) ?? nominal?.find((m) => m.node.includes('r1'));
    if (!nominal || !iMeas) {
        console.error('PREFLIGHT FAILED: could not measure I(R1) at nominal even WITH the fix — ngspice/build issue.', nominal);
        process.exit(2);
    }
    console.log(`preflight: nominal I(R1) ≈ ${(Math.abs(iMeas.raw?.final ?? iMeas.final) * 1000).toFixed(3)} mA (expect ~2.5)`);

    const N = 40;
    // BEFORE — the bug: batch runners derived NO extra probes → the current is never saved.
    const mcBefore = await runMonteCarlo(CIRCUIT, CRITERIA, makeRealRunner([]), { n: N, seed: 1 });
    const cornerBefore = await runWorstCase(CIRCUIT, CRITERIA, {}, makeRealRunner([]));
    // AFTER — the fix: the shared helper derives i(R1); the batch unions it into every variant.
    const probes = extraProbesForCriteria(CRITERIA);
    const mcAfter = await runMonteCarlo(CIRCUIT, CRITERIA, makeRealRunner(probes), { n: N, seed: 1 });
    const cornerAfter = await runWorstCase(CIRCUIT, CRITERIA, {}, makeRealRunner(probes));

    const pct = (y) => `${(y * 100).toFixed(0)}%`;
    console.log('\n  derived extraProbes (the shared seam):', JSON.stringify(probes));
    console.log('\n  ┌─────────────────────────────┬───────────────┬───────────────┐');
    console.log('  │                             │  BEFORE (bug) │  AFTER (fix)  │');
    console.log('  ├─────────────────────────────┼───────────────┼───────────────┤');
    console.log(`  │ Monte-Carlo yield           │ ${pct(mcBefore.yield).padEnd(13)} │ ${pct(mcAfter.yield).padEnd(13)} │`);
    console.log(`  │   evaluated / passed        │ ${`${mcBefore.evaluated} / ${mcBefore.passed}`.padEnd(13)} │ ${`${mcAfter.evaluated} / ${mcAfter.passed}`.padEnd(13)} │`);
    console.log(`  │ Corner passAllCorners       │ ${String(cornerBefore.passAllCorners).padEnd(13)} │ ${String(cornerAfter.passAllCorners).padEnd(13)} │`);
    console.log(`  │   corners passed / eval     │ ${`${cornerBefore.passed} / ${cornerBefore.evaluated}`.padEnd(13)} │ ${`${cornerAfter.passed} / ${cornerAfter.evaluated}`.padEnd(13)} │`);
    console.log('  └─────────────────────────────┴───────────────┴───────────────┘');

    // The fix makes a DIFFERENCE only if: bug path is broken (yield ~0 / corners fail) AND fix path is sound.
    const checks = [
        ['BEFORE: MC yield collapses to 0 (probe not found → every variant fails)', mcBefore.yield === 0 && mcBefore.evaluated === N],
        ['BEFORE: corners all fail (passAllCorners false, 0 passed)', cornerBefore.passAllCorners === false && cornerBefore.passed === 0],
        ['AFTER: MC yield is 100% (current measured → every variant passes)', mcAfter.yield === 1 && mcAfter.passed === N],
        ['AFTER: passAllCorners true (all corners measure > 2 mA)', cornerAfter.passAllCorners === true && cornerAfter.passed === cornerAfter.evaluated && cornerAfter.evaluated > 0],
    ];
    let ok = true;
    console.log('');
    for (const [label, pass] of checks) {
        console.log(`  ${pass ? '✅' : '❌'} ${label}`);
        if (!pass) ok = false;
    }
    console.log(ok ? '\nPASS — the fix flips a sound current-spec design from ~0% robust to 100%.\n' : '\nFAIL — the before/after difference was not demonstrated.\n');
    process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
