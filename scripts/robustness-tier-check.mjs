// Real-ngspice proof that the top robustness tier is REACHABLE.
//
// The stopping rule and the grading rule used to be independent: the run stopped once the Wilson-95
// half-width fell to ±0.03 — true at 61 flawless samples, where the LOWER bound is 0.9408 — while the
// grader awarded `robust` only at a lower bound ≥ robustMin (0.99 for consumer). So a design that never
// failed a single variant was permanently graded `marginal`, and the note told the user to buy tighter
// parts to fix what was actually a sample-count artefact.
//
// The unit suite (packages/eda-core/__tests__/robustness-tier-reachability.test.ts) covers this with an
// injected runner. This harness proves the same thing with the REAL binary: real generateNetlist → real
// ngspice → real parser → real assertions → real classifier, over hundreds of perturbed variants. It prints
// BEFORE (fixed half-width) next to AFTER (bar-aware) so the flip is visible rather than asserted.
//
// Run: NGSPICE_PATH=... node scripts/robustness-tier-check.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    generateNetlist,
    parseSimulationOutput,
    extractProbes,
    summarizeSeries,
    evaluateAssertions,
    runMonteCarlo,
    classifyRobustness,
    requiredRunsForBar,
    barsForProfile,
    ROBUSTNESS_PROFILES,
} from '../packages/eda-core/dist/index.js';

const NG = process.env.NGSPICE_PATH || 'C:/ProgramData/chocolatey/lib/ngspice/tools/Spice64/bin/ngspice_con.exe';
const ANALYSIS = { type: 'op' };

// A deliberately SOUND design: 5 V across two 1 kΩ ±5 % resistors puts the mid node at 2.5 V, and the worst
// ±5 % corner still lands 2.38–2.63 V. Every variant should pass, so anything short of `robust` is the
// engine's own arithmetic talking, not the circuit.
const CIRCUIT = {
    version: '1.0',
    components: [
        {
            id: 'v1',
            type: 'voltage_source',
            designator: 'V1',
            value: 'DC 5',
            pins: [
                { pinId: '+', netId: 'src' },
                { pinId: '-', netId: '0' },
            ],
        },
        {
            id: 'r1',
            type: 'resistor',
            designator: 'R1',
            value: '1k',
            tolerance: 0.05,
            pins: [
                { pinId: '1', netId: 'src' },
                { pinId: '2', netId: 'mid' },
            ],
        },
        {
            id: 'r2',
            type: 'resistor',
            designator: 'R2',
            value: '1k',
            tolerance: 0.05,
            pins: [
                { pinId: '1', netId: 'mid' },
                { pinId: '2', netId: '0' },
            ],
        },
    ],
    nets: [
        { id: 'src', name: 'src' },
        { id: 'mid', name: 'mid' },
        { id: '0', name: '0', isGround: true },
    ],
};
const CRITERIA = [{ probe: 'v(mid)', metric: 'final', op: 'gt', value: 2.0, label: 'V(mid) > 2.0 V' }];

/** REAL per-variant runner: generateNetlist → ngspice -b → parse → per-node scalars. null = un-runnable. */
const realRunner = async (variant) => {
    let netlist;
    try {
        netlist = generateNetlist(variant, ANALYSIS, {});
    } catch {
        return null;
    }
    const dir = mkdtempSync(join(tmpdir(), 'cf-tier-'));
    try {
        writeFileSync(join(dir, 'c.cir'), netlist);
        const r = spawnSync(NG, ['-b', '-o', 'log.txt', 'c.cir'], { cwd: dir, encoding: 'utf-8', timeout: 30000 });
        if (r.status !== 0) return null;
        let csv = '';
        try {
            csv = readFileSync(join(dir, 'output.csv'), 'utf-8');
        } catch {
            return null;
        }
        if (!csv.trim()) return null;
        const res = parseSimulationOutput(csv, extractProbes(netlist), ANALYSIS.type);
        return res.series.map((s) => summarizeSeries(s, ANALYSIS.type));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

let failures = 0;
const ok = (cond, msg) => {
    console.log(`  ${cond ? '✅' : '❌'} ${msg}`);
    if (!cond) failures++;
};

async function main() {
    // Probe the binary by RUNNING it, not by looking for a file at that path. NGSPICE_PATH is legitimately
    // either an absolute path (Windows: ...\ngspice_con.exe) or a bare command resolved through PATH — and
    // CI passes the bare `ngspice` the apt package installs. An existsSync() check rejects the second form
    // outright, which is how this harness failed in CI on a runner where ngspice was installed and working.
    // Still fail-closed: a silent skip here would be worse than having no harness at all.
    const probe = spawnSync(NG, ['--version'], { encoding: 'utf-8', timeout: 30000 });
    if (probe.error || typeof probe.status !== 'number') {
        console.error(
            `FAIL: could not run ngspice as "${NG}" (set NGSPICE_PATH to an absolute path or a command on PATH).\n` +
                `  ${probe.error ? String(probe.error) : 'the process did not report an exit status'}\n` +
                `This harness requires the real binary.`,
        );
        process.exit(1);
    }
    console.log(
        `ngspice: ${
            (probe.stdout || probe.stderr || '')
                .split('\n')
                .find((l) => /ngspice/i.test(l))
                ?.trim() ?? NG
        }`,
    );

    const bars = ROBUSTNESS_PROFILES.consumer;
    const needed = requiredRunsForBar(bars.robustMin);
    console.log(
        `consumer bar: robustMin=${bars.robustMin} → needs ${needed} clean runs for the Wilson-95 lower bound\n`,
    );

    // Preflight: the nominal design must actually pass, or the whole comparison is meaningless.
    const nominal = await realRunner(CIRCUIT);
    // Ask the ENGINE whether the criterion passes at nominal instead of string-matching node names here:
    // net ids are sanitised on the way into the deck (mid -> nmid), and the assertion evaluator is the piece
    // that knows how to map a v(netId) probe back onto a measured node. If the two disagreed, every variant
    // would silently "fail" and the comparison below would be measuring probe resolution, not tier logic.
    const pre = evaluateAssertions(nominal ?? [], CRITERIA, true, CIRCUIT.nets);
    if (!pre.length || !pre.every((r) => r.pass)) {
        console.error(
            `PREFLIGHT FAILED: the criterion does not pass at NOMINAL — a probe-resolution or ngspice issue, not a tier issue.\n` +
                `  measured nodes: ${JSON.stringify(nominal?.map((m) => ({ node: m.node, final: m.final })) ?? null)}\n` +
                `  assertions:     ${JSON.stringify(pre)}`,
        );
        process.exit(1);
    }
    console.log(`preflight: criterion passes at nominal — ${pre[0].detail ?? pre[0].label}\n`);

    // LEGACY — the fixed-precision rule, with no idea what bar it will be graded against. Kept as the
    // contrast arm only; nothing ships this any more.
    const before = await runMonteCarlo(CIRCUIT, CRITERIA, realRunner, { seed: 7, ciStopHalfWidth: 0.03 });
    const beforeVerdict = classifyRobustness(before, 'consumer');

    // DEFAULT PATH — deliberately built the way a request that names NO profile is now handled: bars come
    // from barsForProfile(undefined), and the grade is taken with no profile argument either. An earlier
    // version of this harness passed a hand-set profile on both sides, which meant its "before" arm WAS the
    // shipped default and the check stayed green while the product path was still broken. Prove the path
    // almost every request actually takes, not a configuration only a test uses.
    const defaultBars = barsForProfile(undefined);
    const after = await runMonteCarlo(CIRCUIT, CRITERIA, realRunner, {
        seed: 7,
        stopBars: { robustMin: defaultBars.robustMin, marginalMin: defaultBars.marginalMin },
    });
    const afterVerdict = classifyRobustness(after);

    const row = (l, b, a) => console.log(`  │ ${l.padEnd(27)} │ ${String(b).padEnd(13)} │ ${String(a).padEnd(13)} │`);
    console.log('  ┌─────────────────────────────┬───────────────┬───────────────┐');
    console.log('  │                             │ LEGACY  rule  │ DEFAULT path  │');
    console.log('  ├─────────────────────────────┼───────────────┼───────────────┤');
    row('variants evaluated', before.evaluated, after.evaluated);
    row('failed variants', before.failed, after.failed);
    row('Wilson-95 lower bound', before.ci95.low.toFixed(4), after.ci95.low.toFixed(4));
    row('tier', beforeVerdict.tier, afterVerdict.tier);
    console.log('  └─────────────────────────────┴───────────────┴───────────────┘\n');

    ok(before.failed === 0 && after.failed === 0, 'the design is genuinely sound — zero failing variants in both runs');
    ok(
        beforeVerdict.tier === 'marginal',
        `LEGACY: a flawless design was capped at "marginal" (got ${beforeVerdict.tier})`,
    );
    ok(before.evaluated === 61, `LEGACY: the fixed ±3% rule stops at 61 samples (got ${before.evaluated})`);
    ok(
        afterVerdict.tier === 'robust',
        `DEFAULT PATH (no profile named): the same flawless design earns "robust" (got ${afterVerdict.tier})`,
    );
    ok(
        after.evaluated === needed,
        `DEFAULT PATH: it runs exactly the ${needed} samples the bar requires (got ${after.evaluated})`,
    );
    ok(
        after.ci95.low >= bars.robustMin,
        `DEFAULT PATH: the lower bound clears the bar (${after.ci95.low.toFixed(4)} ≥ ${bars.robustMin})`,
    );
    ok(
        /more variants|Undecided/i.test(beforeVerdict.note) &&
            !/Tighten component tolerances/i.test(beforeVerdict.note),
        'LEGACY: the note blames the sample count, not the parts (it used to say "buy ±1% parts")',
    );

    console.log(
        `\n${failures === 0 ? 'PASS — the top tier is reachable with the real simulator.' : `${failures} CHECK(S) FAILED`}`,
    );
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('harness error:', e);
    process.exit(1);
});
