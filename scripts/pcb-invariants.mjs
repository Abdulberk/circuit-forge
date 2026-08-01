/**
 * Tier-0 PCB conservation gate — the invariants that must hold for ANY component from a catalog of any
 * size, checked without Docker, without tscircuit eval, and without a routed board.
 *
 * WHY THIS EXISTS. The gallery proves eight boards work. It cannot prove the NEXT board works, and the
 * input space it covers is tiny: ten of thirty-two component types and four distinct footprint strings,
 * against a parts catalog with hundreds of thousands of entries whose `Case` field lands directly in
 * `component.footprint`. Measured across 69 physically-plausible (type × real TME case) pairs, 46% of
 * them fail the job outright and 7% ship undeclared copper.
 *
 * WHAT IT ASSERTS. Not "does the circuit work" — conservation. Nothing lost, nothing invented, and every
 * claim's denominator equal to the input:
 *
 *   I-FP-VOCAB      the footprint string is one the renderer actually accepts
 *   I-PIN-TOTALITY  every pin reaches exactly one pad, or its loss is DECLARED
 *   I-PAD-ACCOUNT   surplus footprint pads are declared NC, never silent copper
 *   I-IDENTITY      component ids, designators and net ids are unique; every pin.netId exists
 *   I-DENOMINATOR   a coverage claim is computed against the INPUT's pin count, not a post-loss set
 *
 * These are cheap because they are pure: three functions pcb-core already exports, plus footprinter as
 * ground truth for pad count. Measured ~0.01 ms/case, so the reachable input space is ENUMERATED rather
 * than sampled — there is no seed, no shrinking and no randomness to reproduce.
 *
 * Run: node scripts/pcb-invariants.mjs [--verbose] [--json]
 */
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..', 'packages', 'pcb-core');
const { classifyCircuit, generateTscircuitCode, resolveFootprint, normalizeFootprint } = await import(
    new URL(`file://${join(pkgRoot, 'dist', 'index.js').replace(/\\/g, '/')}`).href
);

/**
 * footprinter is the ONLY ground truth for how many pads a footprint string really has.
 *
 * pcb-core now asks the same library (see `loadPadCountOracle`), which is exactly why this gate loads its
 * OWN copy rather than importing pcb-core's: an oracle that comes from the code under audit can only ever
 * agree with it. Before that change pcb-core guessed from a nine-family name pattern that answered for a
 * minority of the vocabulary and answered CONFIDENTLY for strings footprinter rejects outright.
 *
 * A failure to resolve is FATAL: a pad-count oracle that quietly degrades to "unknown" would pass every
 * board, which is the precise failure this whole gate exists to end.
 */
// Resolved THROUGH @tscircuit/eval, not beside it. footprinter is eval's own dependency, and under pnpm's
// strict layout a sibling copy could easily be a different version — an oracle that measures a different
// footprinter than the pipeline loads is not an oracle, it is a second opinion.
let footprinter;
let footprinterVersion = 'unknown';
try {
    // eval's `exports` map blocks both its main and './package.json' from a plain require.resolve, so the
    // dependency graph is walked on disk instead: pcb-core's link to eval, realpath'd into the pnpm store,
    // then eval's OWN node_modules — which is exactly the copy eval loads at runtime.
    // Reached through @tscircuit/core, whose store directory holds a real, separately-loadable footprinter
    // in the same resolved graph. (@tscircuit/eval cannot be used for this: its dist is a 12 MB bundle with
    // footprinter inlined, so there is nothing to import.) pnpm lays a package's dependencies out as
    // SIBLINGS in the same store node_modules, hence two levels up rather than nested.
    //
    // This is the one place the gate uses a copy rather than the exact module the evaluator runs, so it is
    // stated here and CHECKED at Tier 1: once a board is really evaluated, its pad count per footprint must
    // equal what this oracle predicted. A divergence means the oracle went stale, and that is a finding,
    // not something to assume away.
    const evalDir = await realpath(join(pkgRoot, 'node_modules', '@tscircuit', 'eval'));
    const coreDir = await realpath(join(evalDir, '..', 'core'));
    const fpDir = join(coreDir, '..', '..', '@tscircuit', 'footprinter');
    const fpPkg = JSON.parse(await readFile(join(fpDir, 'package.json'), 'utf8'));
    const entry = fpPkg.exports?.['.']?.import ?? fpPkg.exports?.['.']?.default ?? fpPkg.module ?? fpPkg.main;
    footprinter = await import(new URL(`file://${join(fpDir, entry).replace(/\\/g, '/')}`).href);
    footprinterVersion = fpPkg.version;
} catch (e) {
    console.error(
        `FATAL: @tscircuit/footprinter could not be resolved through @tscircuit/eval ` +
            `(${String(e.message).slice(0, 140)}).\n` +
            `It is the pad-count ground truth for this gate; without it the gate would pass everything.`,
    );
    process.exit(2);
}

/** Real pad count for a footprint string, or null when the renderer refuses it. */
const padCountCache = new Map();
function truePadCount(fpString) {
    if (padCountCache.has(fpString)) return padCountCache.get(fpString);
    let n = null;
    try {
        const cj = footprinter.fp.string(fpString).circuitJson();
        n = cj.filter((e) => e.type === 'pcb_smtpad' || e.type === 'pcb_plated_hole').length;
        if (n === 0) n = null; // a footprint with no copper is not a footprint we can place a pin on
    } catch {
        n = null;
    }
    padCountCache.set(fpString, n);
    return n;
}

// ---------------------------------------------------------------- the invariants

/** Components that are not placed at all — their pins are not expected to reach copper. */
const NON_PHYSICAL = new Set(['ground']);

/**
 * Check one circuit. Returns a list of violations; empty means every conservation law held.
 *
 * Deliberately does NOT decide whether the circuit is a good design. A short circuit, a floating input and
 * a nonsense value all pass here — this gate answers one question only: did the pipeline keep everything
 * it was given, and declare everything it dropped?
 */
export function checkInvariants(circuit) {
    const v = [];
    const add = (id, message, detail) => v.push({ id, message, ...(detail ? { detail } : {}) });

    // ---- I-IDENTITY: referential integrity of the input itself.
    const seenId = new Set();
    const seenDesignator = new Set();
    const netIds = new Set((circuit.nets ?? []).map((n) => n.id));
    for (const n of circuit.nets ?? []) {
        if (seenId.has(`net:${n.id}`)) add('I-IDENTITY', `duplicate net id "${n.id}"`);
        seenId.add(`net:${n.id}`);
    }
    for (const c of circuit.components ?? []) {
        if (seenId.has(`comp:${c.id}`)) add('I-IDENTITY', `duplicate component id "${c.id}"`);
        seenId.add(`comp:${c.id}`);
        if (seenDesignator.has(c.designator))
            add('I-IDENTITY', `duplicate designator "${c.designator}" — the BOM and the pick-and-place file will disagree`);
        seenDesignator.add(c.designator);
        for (const p of c.pins ?? []) {
            if (!netIds.has(p.netId))
                add('I-IDENTITY', `${c.designator}.${p.pinId} references net "${p.netId}", which does not exist`);
        }
    }

    let classified;
    try {
        classified = classifyCircuit(circuit, { padCount: truePadCount });
    } catch (e) {
        add('I-CRASH', `classifyCircuit threw instead of returning a diagnostic: ${String(e.message).slice(0, 160)}`);
        return v;
    }

    /**
     * A board the product REFUSES is not a conservation failure — it is the system working.
     *
     * These invariants are about what SHIPS. When `layoutable` is false the job stops with an error-severity
     * diagnostic naming the reason (a MOSFET whose bulk sits on its own net is refused exactly this way,
     * PCB010), so nothing was lost silently and there is nothing to conserve. Flagging those cases anyway
     * would fill the report with the one class of input the pipeline already handles honestly, and a gate
     * that cries wolf is a gate people learn to skip.
     *
     * I-IDENTITY still stands above: a duplicate designator corrupts the delivered BOM whether or not the
     * board is refused.
     */
    if (classified.layoutable === false) {
        v.refused = true;
        return v;
    }

    // ---- I-FP-VOCAB: every placed component's footprint is one the renderer accepts.
    for (const plan of classified.plans ?? []) {
        const c = plan.component;
        if (plan.role === 'excluded' || NON_PHYSICAL.has(c.type)) continue;
        const resolved = plan.footprint?.footprint ?? resolveFootprint(c)?.footprint ?? null;
        if (!resolved) {
            add('I-FP-VOCAB', `${c.designator} (${c.type}) resolved to no footprint at all`);
            continue;
        }
        if (truePadCount(resolved) === null) {
            add(
                'I-FP-VOCAB',
                `${c.designator} (${c.type}): footprint "${c.footprint ?? '(default)'}" normalises to ` +
                    `"${resolved}", which the renderer refuses — the job fails with a tool-internal message`,
                { footprint: resolved },
            );
        }
    }

    // ---- the adapter's own account of which pins survived.
    let adapted;
    try {
        adapted = generateTscircuitCode(circuit, undefined, classified, {});
    } catch (e) {
        add('I-CRASH', `generateTscircuitCode threw: ${String(e.message).slice(0, 160)}`);
        return v;
    }

    const mappedByDesignator = new Map();
    for (const x of adapted.expectations) mappedByDesignator.set(x.name, (mappedByDesignator.get(x.name) ?? 0) + 1);

    for (const plan of classified.plans ?? []) {
        const c = plan.component;
        if (plan.role === 'excluded' || NON_PHYSICAL.has(c.type)) continue;
        const emitted = adapted.namesById?.[c.id] ?? c.designator;
        const mapped = mappedByDesignator.get(emitted) ?? 0;
        const pins = (c.pins ?? []).length;
        const declaredNc = plan.ncPinCount;

        // ---- I-PIN-TOTALITY: a pin may only vanish if its loss was declared.
        if (mapped < pins) {
            add(
                'I-PIN-TOTALITY',
                `${c.designator} (${c.type}) has ${pins} pin(s) but only ${mapped} reached copper — ` +
                    `${pins - mapped} silently dropped. The board ships that part with missing legs.`,
                { pins, mapped },
            );
        }
        if (mapped > pins) add('I-PIN-TOTALITY', `${c.designator}: ${mapped} pads mapped from ${pins} pins — invented copper`);

        // ---- I-PAD-ACCOUNT: surplus pads on the footprint must be declared NC.
        const resolved = plan.footprint?.footprint ?? null;
        const pads = resolved ? truePadCount(resolved) : null;
        if (pads !== null && pads > mapped && declaredNc === undefined) {
            add(
                'I-PAD-ACCOUNT',
                `${c.designator} (${c.type}) sits on "${resolved}" with ${pads} pads but only ${mapped} wired — ` +
                    `${pads - mapped} pad(s) of undeclared copper, with no diagnostic of any severity`,
                { pads, mapped },
            );
        }
        if (pads !== null && mapped > pads) {
            add(
                'I-PAD-ACCOUNT',
                `${c.designator}: ${mapped} pins mapped onto a ${pads}-pad footprint "${resolved}" — ` +
                    `more legs than the package has`,
                { pads, mapped },
            );
        }
    }

    // ---- I-DENOMINATOR: the coverage claim must be measured against the INPUT.
    const physicalPins = (classified.plans ?? [])
        .filter((p) => p.role !== 'excluded' && !NON_PHYSICAL.has(p.component.type))
        .reduce((n, p) => n + (p.component.pins ?? []).length, 0);
    const declaredNcTotal = (classified.plans ?? []).reduce((n, p) => n + (p.ncPinCount ?? 0), 0);
    if (adapted.expectations.length !== physicalPins && physicalPins - adapted.expectations.length !== declaredNcTotal) {
        add(
            'I-DENOMINATOR',
            `parity will report ${adapted.expectations.length}/${adapted.expectations.length} pins isomorphic ` +
                `while the input has ${physicalPins} physical pin(s) — the claim is computed against a set that ` +
                `already lost some`,
        );
    }

    return v;
}

// ---------------------------------------------------------------- enumeration

const TWO_PIN = [
    { type: 'resistor', value: '1k', pins: ['1', '2'] },
    { type: 'capacitor', value: '100n', pins: ['1', '2'] },
    { type: 'inductor', value: '10u', pins: ['1', '2'] },
    { type: 'diode', pins: ['anode', 'cathode'] },
];
const MULTI_PIN = [
    { type: 'bjt', model: 'QGENNPN', pins: ['c', 'b', 'e'] },
    { type: 'mosfet', model: 'MGENNMOS', pins: ['d', 'g', 's', 'b'] },
];

/** Real `Case` strings seen on TME parts, plus the shapes our own gallery uses. */
const CASE_STRINGS = [
    '0402', '0603', '0805', '1206', '1210', '2512',
    '0603 (1608 Metric)', '0402 (1005 Metric)',
    'SOD-123', 'SOD-323', 'SMA', 'SMB', 'SMC',
    'DO-41', 'DO-35', 'DO-201', 'DO-214AC', 'DO-214AB',
    'SOT-23', 'SOT-23-3', 'SOT-223', 'SOT-323', 'SOT-363', 'SC-70',
    'TO-92', 'TO-126', 'TO-220', 'TO-220-3', 'TO-247', 'TO-252', 'TO-263',
    'DPAK', 'D2PAK', 'PowerPAK SO-8',
    'SOIC-8', 'SOIC-14', 'SOIC-16', 'TSSOP-20', 'QFN-32', 'LQFP-48', 'DIP-8',
    'THT', 'SMD', '2.54mm', '5.08mm',
];

function caseCircuit(part, footprint) {
    const nets = [{ id: 'gnd', name: 'GND', isGround: true }, ...part.pins.map((p, i) => ({ id: `n${i}`, name: `N${i}` }))];
    return {
        version: '1.0',
        components: [
            {
                id: 'u1',
                type: part.type,
                designator: part.type === 'resistor' ? 'R1' : part.type === 'capacitor' ? 'C1' : 'U1',
                ...(part.value ? { value: part.value } : {}),
                ...(part.model ? { model: part.model } : {}),
                footprint,
                pins: part.pins.map((pinId, i) => ({ pinId, netId: `n${i}` })),
            },
            { id: 'r9', type: 'resistor', designator: 'R9', value: '1k', pins: [{ pinId: '1', netId: 'n0' }, { pinId: '2', netId: 'gnd' }] },
            { id: 'gnd1', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
        ],
        nets,
    };
}


/**
 * LOCKED counterexamples — each one a board the whole pipeline called good before these checks existed.
 *
 * They live here rather than in jest because they need the real pad-count oracle, and footprinter is
 * ESM-only while pcb-core's jest transpiles to CommonJS (the split jest.config.js already documents). A
 * regression here exits non-zero, so this is a gate, not a report.
 */
const LOCKED = [
    { name: 'a 3-pin BJT on a 2-pad 0603 ships with two legs', part: { type: 'bjt', model: 'QGENNPN', pins: ['c', 'b', 'e'] }, footprint: '0603', expect: 'refused' },
    { name: 'a diode on DO-41 (a real catalog Case value)', part: { type: 'diode', pins: ['anode', 'cathode'] }, footprint: 'DO-41', expect: 'refused' },
    { name: 'a diode on DO-214AC — the package SMA spells differently', part: { type: 'diode', pins: ['anode', 'cathode'] }, footprint: 'DO-214AC', expect: 'refused' },
    { name: 'a resistor on a SOIC-8 leaves 6 pads of undeclared copper', part: { type: 'resistor', value: '1k', pins: ['1', '2'] }, footprint: 'SOIC-8', expect: 'accounted', nc: 6 },
    { name: 'a resistor on a SOT-23 leaves 1', part: { type: 'resistor', value: '1k', pins: ['1', '2'] }, footprint: 'SOT-23', expect: 'accounted', nc: 1 },
    // Controls — these must never regress into refusals.
    { name: 'the same BJT on a SOT-23 that fits', part: { type: 'bjt', model: 'QGENNPN', pins: ['c', 'b', 'e'] }, footprint: 'SOT-23', expect: 'accounted', nc: 0 },
    { name: 'a diode on SMA', part: { type: 'diode', pins: ['anode', 'cathode'] }, footprint: 'SMA', expect: 'accounted', nc: 0 },
    { name: 'a resistor on an 0603', part: { type: 'resistor', value: '1k', pins: ['1', '2'] }, footprint: '0603', expect: 'accounted', nc: 0 },
];

function runLocked(padCount) {
    const failures = [];
    for (const c of LOCKED) {
        const r = classifyCircuit(caseCircuit(c.part, c.footprint), { padCount });
        const plan = r.plans.find((p) => p.component.id === 'u1');
        if (c.expect === 'refused') {
            if (r.layoutable) failures.push(`${c.name}: expected the board to be REFUSED, it was accepted`);
        } else if (!r.layoutable) {
            failures.push(`${c.name}: expected the board to be accepted, it was refused`);
        } else if (plan?.ncPinCount !== c.nc) {
            failures.push(`${c.name}: expected ${c.nc} declared NC pad(s), got ${String(plan?.ncPinCount)}`);
        }
    }
    return failures;
}

if (import.meta.url === new URL(`file://${process.argv[1]?.replace(/\\/g, '/')}`).href) {
    const verbose = process.argv.includes('--verbose');
    const started = Date.now();
    const buckets = new Map();
    const rows = [];
    let clean = 0;
    let total = 0;

    let refused = 0;
    for (const part of [...TWO_PIN, ...MULTI_PIN]) {
        for (const fp of CASE_STRINGS) {
            total++;
            const violations = checkInvariants(caseCircuit(part, fp));
            // Disjoint buckets: a refused board is not "clean", it is a board the product declined to
            // build. Counting it as clean would let a rise in refusals read as an improvement.
            if (violations.refused) {
                refused++;
                continue;
            }
            if (violations.length === 0) {
                clean++;
                continue;
            }
            for (const x of violations) buckets.set(x.id, (buckets.get(x.id) ?? 0) + 1);
            rows.push({ part: part.type, footprint: fp, violations });
        }
    }

    const ms = Date.now() - started;
    console.log(`\n${total} cases in ${ms} ms (${(ms / total).toFixed(3)} ms/case)\n`);
    console.log(`  clean            ${String(clean).padStart(4)}  ${((clean / total) * 100).toFixed(0)}%   conservation held`);
    console.log(`  refused          ${String(refused).padStart(4)}  ${((refused / total) * 100).toFixed(0)}%   the product said no, with a reason — working as intended`);
    for (const [id, n] of [...buckets].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${id.padEnd(14)} ${String(n).padStart(4)}  ${((n / total) * 100).toFixed(0)}%`);
    }

    if (verbose) {
        console.log('\n──────── violations');
        for (const r of rows) {
            for (const x of r.violations) console.log(`  [${x.id}] ${r.part} + "${r.footprint}": ${x.message}`);
        }
    } else if (rows.length) {
        console.log(`\n  (${rows.length} failing case(s) — run with --verbose to see them)`);
    }

    // The LOCKED cases are the gate. The enumeration above is a REPORT: it is introduced against real
    // remaining violations, and a permanently-red gate teaches people to skip gates. Locking the measured
    // counterexamples blocks regressions today while the enumeration tracks the rest honestly.
    const locked = runLocked(truePadCount);
    if (locked.length) {
        console.log('\n──────── LOCKED counterexamples FAILED');
        for (const f of locked) console.log(`  ✗ ${f}`);
        console.log(`\n❌ ${locked.length} locked case(s) regressed`);
        process.exit(1);
    }
    console.log(`\n✅ ${LOCKED.length} locked counterexamples all hold`);
    process.exit(0);
}
