/**
 * pcb-core layout harness — the REAL integration gate (`pnpm test:layout`).
 *
 * Runs three fixture circuits (in OUR CircuitJson format) through the full Phase-1 pipeline:
 * classify -> adapter -> HEADLESS tscircuit eval + LOCAL autoroute -> connectivity PARITY -> outputs.
 * Then, when Docker is available, notarizes the generated .kicad_pcb with kicad-cli 10
 * (`pcb drc --refill-zones --exit-code-violations`, judged against OUR .kicad_pro fab rules), and
 * replays the golden freerouting fixtures through exportDsn/mergeSes.
 *
 * Convention: like test:matrix / test:edge, this is a node harness (the tscircuit deps are ESM-only,
 * which keeps real-eval integration out of jest); exits non-zero on any failure.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { makeFreeroutingRunner } from './lib/freerouting.mjs';
import { makeKicadDrcRunner, makeKicadDrcReportRunner } from './lib/kicad-drc.mjs';
import { KICAD_IMAGE, FR_IMAGE, assertImagesMatchProduction, dockerUserArgs } from './lib/eda-images.mjs';

// Before anything runs: the images this harness judges boards with MUST be the ones production runs.
// A gate testing a different KiCad than the product is not a gate.
assertImagesMatchProduction();

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..', 'packages', 'pcb-core');
const outRoot = join(pkgRoot, '.layout-check');
const { layoutCircuit, exportDsn, mergeSes, stripRouting, injectModels, hasVisibleDesignators } = await import(
    new URL(`file://${join(pkgRoot, 'dist', 'index.js').replace(/\\/g, '/')}`).href
);

let failures = 0;
const fail = (msg) => {
    failures++;
    console.error(`  ✗ ${msg}`);
};
const ok = (msg) => console.log(`  ✓ ${msg}`);

// PCB_GATE_STRICT=1 (set by the CI quality gate): a MISSING Docker image is a FAILURE, not a silent
// skip. Locally the Docker tiers self-skip so `pnpm test:layout` still runs without Docker; in CI the
// gate exists precisely to run them, so "couldn't run" must never masquerade as green.
const STRICT = process.env.PCB_GATE_STRICT === '1';

// ---------------------------------------------------------------- fixtures (OUR CircuitJson)

const gnd = (netId) => ({ id: 'gnd1', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId }] });

/** (a) divider + LED indicator — the canonical starter circuit. */
const dividerLed = {
    version: '1.0',
    components: [
        {
            id: 'v1',
            type: 'voltage_source',
            designator: 'V1',
            value: 'DC 9',
            pins: [
                { pinId: '+', netId: 'vin' },
                { pinId: '-', netId: 'gnd' },
            ],
        },
        {
            id: 'r1',
            type: 'resistor',
            designator: 'R1',
            value: '10k',
            pins: [
                { pinId: '1', netId: 'vin' },
                { pinId: '2', netId: 'vout' },
            ],
        },
        {
            id: 'r2',
            type: 'resistor',
            designator: 'R2',
            value: '10k',
            pins: [
                { pinId: '1', netId: 'vout' },
                { pinId: '2', netId: 'gnd' },
            ],
        },
        {
            id: 'r3',
            type: 'resistor',
            designator: 'R3',
            value: '330',
            pins: [
                { pinId: '1', netId: 'vout' },
                { pinId: '2', netId: 'ledk' },
            ],
        },
        {
            id: 'd1',
            type: 'diode',
            designator: 'LED1',
            model: 'led_red',
            pins: [
                { pinId: 'anode', netId: 'ledk' },
                { pinId: 'cathode', netId: 'gnd' },
            ],
        },
        gnd('gnd'),
    ],
    nets: [
        { id: 'vin', name: 'VIN' },
        { id: 'vout', name: 'VOUT' },
        { id: 'ledk', name: 'LEDK' },
        { id: 'gnd', name: 'GND', isGround: true },
    ],
};

/** (b) common-emitter amplifier — BJT pin-map correctness under parity. */
const ceAmp = {
    version: '1.0',
    components: [
        {
            id: 'v1',
            type: 'voltage_source',
            designator: 'V1',
            value: 'DC 12',
            pins: [
                { pinId: '+', netId: 'vcc' },
                { pinId: '-', netId: 'gnd' },
            ],
        },
        {
            id: 'v2',
            type: 'voltage_source',
            designator: 'V2',
            value: 'SIN(0 0.01 1k)',
            pins: [
                { pinId: '+', netId: 'in' },
                { pinId: '-', netId: 'gnd' },
            ],
        },
        {
            id: 'q1',
            type: 'bjt',
            designator: 'Q1',
            model: 'QGENNPN',
            pins: [
                { pinId: 'c', netId: 'vc' },
                { pinId: 'b', netId: 'vb' },
                { pinId: 'e', netId: 've' },
            ],
        },
        {
            id: 'rc',
            type: 'resistor',
            designator: 'RC1',
            value: '4.7k',
            pins: [
                { pinId: '1', netId: 'vcc' },
                { pinId: '2', netId: 'vc' },
            ],
        },
        {
            id: 'rb1',
            type: 'resistor',
            designator: 'RB1',
            value: '100k',
            pins: [
                { pinId: '1', netId: 'vcc' },
                { pinId: '2', netId: 'vb' },
            ],
        },
        {
            id: 'rb2',
            type: 'resistor',
            designator: 'RB2',
            value: '22k',
            pins: [
                { pinId: '1', netId: 'vb' },
                { pinId: '2', netId: 'gnd' },
            ],
        },
        {
            id: 're',
            type: 'resistor',
            designator: 'RE1',
            value: '1k',
            pins: [
                { pinId: '1', netId: 've' },
                { pinId: '2', netId: 'gnd' },
            ],
        },
        {
            id: 'c1',
            type: 'capacitor',
            designator: 'C1',
            value: '100n',
            pins: [
                { pinId: '1', netId: 'in' },
                { pinId: '2', netId: 'vb' },
            ],
        },
        gnd('gnd'),
    ],
    nets: [
        { id: 'vcc', name: 'VCC' },
        { id: 'in', name: 'IN' },
        { id: 'vc', name: 'VC' },
        { id: 'vb', name: 'VB' },
        { id: 've', name: 'VE' },
        { id: 'gnd', name: 'GND', isGround: true },
    ],
};

/** (c) inverting op-amp (subckt, 5 ports on a SOIC-8 -> 3 NC pins; port-order mapping under parity). */
const opampMixed = {
    version: '1.0',
    components: [
        {
            id: 'u1',
            type: 'subckt',
            designator: 'U1',
            model: 'OPAMPGEN',
            pins: [
                { pinId: 'out', netId: 'out' },
                { pinId: 'in+', netId: 'gnd' },
                { pinId: 'in-', netId: 'inm' },
                { pinId: 'vcc', netId: 'vcc' },
                { pinId: 'vee', netId: 'vee' },
            ],
        },
        {
            id: 'r1',
            type: 'resistor',
            designator: 'R1',
            value: '10k',
            pins: [
                { pinId: '1', netId: 'in' },
                { pinId: '2', netId: 'inm' },
            ],
        },
        {
            id: 'r2',
            type: 'resistor',
            designator: 'R2',
            value: '20k',
            pins: [
                { pinId: '1', netId: 'inm' },
                { pinId: '2', netId: 'out' },
            ],
        },
        {
            id: 'vp',
            type: 'voltage_source',
            designator: 'VCC1',
            value: 'DC 12',
            pins: [
                { pinId: '+', netId: 'vcc' },
                { pinId: '-', netId: 'gnd' },
            ],
        },
        {
            id: 'vn',
            type: 'voltage_source',
            designator: 'VEE1',
            value: 'DC -12',
            pins: [
                { pinId: '+', netId: 'vee' },
                { pinId: '-', netId: 'gnd' },
            ],
        },
        {
            id: 'vs',
            type: 'voltage_source',
            designator: 'VIN1',
            value: 'SIN(0 1 1k)',
            pins: [
                { pinId: '+', netId: 'in' },
                { pinId: '-', netId: 'gnd' },
            ],
        },
        gnd('gnd'),
    ],
    nets: [
        { id: 'in', name: 'IN' },
        { id: 'inm', name: 'INM' },
        { id: 'out', name: 'OUT' },
        { id: 'vcc', name: 'VCC' },
        { id: 'vee', name: 'VEE' },
        { id: 'gnd', name: 'GND', isGround: true },
    ],
    models: [
        {
            name: 'OPAMPGEN',
            device: 'subckt',
            body: '.subckt OPAMPGEN out inp inn vcc vee\n.ends',
            ports: ['out', 'in+', 'in-', 'vcc', 'vee'],
        },
    ],
};

// ---------------------------------------------------------------- pipeline runs

const cases = [
    ['divider-led', dividerLed],
    ['ce-amp', ceAmp],
    ['opamp-mixed', opampMixed],
];

mkdirSync(outRoot, { recursive: true });
const boards = [];

for (const [name, circuit] of cases) {
    console.log(`\n── ${name}`);
    const t0 = Date.now();
    let result;
    try {
        result = await layoutCircuit(circuit, {});
    } catch (e) {
        // one throwing fixture must not abort the whole harness — count it and keep going
        fail(`${name}: layoutCircuit threw — ${String(e).slice(0, 300)}`);
        continue;
    }
    const dir = join(outRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'generated.tsx.txt'), result.code);
    writeFileSync(join(dir, 'diagnostics.json'), JSON.stringify(result.diagnostics, null, 1));

    if (!result.ok) {
        fail(
            `${name}: layoutCircuit not ok — ${result.diagnostics
                .filter((d) => d.severity === 'error')
                .map((d) => `${d.code} ${d.message}`)
                .join(' | ')}`,
        );
        continue;
    }
    ok(
        `layout ok in ${Date.now() - t0}ms — traces=${result.stats.traces} vias=${result.stats.vias} completeness=${result.completeness}`,
    );

    // The board must SAY it was routed by the local router. This run injects no freerouting runner, so a
    // `tier: 'quality'` here would mean the field is decorative — and a decorative honesty field is worse
    // than none, because it is believed.
    const d = result.delivery;
    if (d?.routing?.tier !== 'local' || d.routing.drcCertified !== false || !d.routing.degradedReason) {
        fail(`${name}: fast path must report the LOCAL routing tier with a reason — got ${JSON.stringify(d?.routing)}`);
    } else {
        ok(`delivery is honest about the fast path — tier=local, reason="${d.routing.degradedReason}"`);
    }

    if (result.parity.checkedPins !== result.parity.expectedPins) {
        fail(`${name}: parity checked ${result.parity.checkedPins}/${result.parity.expectedPins} pins`);
    } else {
        ok(`parity: ${result.parity.checkedPins}/${result.parity.expectedPins} pins isomorphic (both views agree)`);
    }

    const layers = Object.keys(result.outputs.gerbers.layers);
    if (!layers.includes('F_Cu') || !layers.includes('Edge_Cuts')) {
        fail(`${name}: gerber layer set incomplete: ${layers.join(',')}`);
    } else {
        ok(`gerbers: ${layers.length} layers + drill`);
    }

    for (const [layer, content] of Object.entries(result.outputs.gerbers.layers)) {
        writeFileSync(join(dir, `${layer}.gbr`), content);
    }
    writeFileSync(join(dir, 'drill.drl'), result.outputs.gerbers.drill);
    writeFileSync(join(dir, 'board.kicad_pcb'), result.outputs.kicadPcb);
    writeFileSync(join(dir, 'board.kicad_pro'), result.outputs.kicadPro);
    writeFileSync(join(dir, 'bom.csv'), result.outputs.bomCsv);
    writeFileSync(join(dir, 'pnp.csv'), result.outputs.pnpCsv);

    const pourNote = result.diagnostics.find((d) => d.code === 'PCB032' || d.code === 'PCB033');
    if (pourNote)
        ok(
            `pour: ${pourNote.code === 'PCB032' ? 'zone injected' : 'skipped honestly'} — ${pourNote.message.slice(0, 90)}`,
        );

    // SEMANTIC ANCHORS: the parity check certifies against the adapter's own selectors; these asserts
    // pin the STATIC map to tscircuit's OWN hints on a real evaluated board (upstream alias-change alarm).
    if (name === 'ce-amp') {
        const q1 = result.evaluated.find((e) => e.type === 'source_component' && e.name === 'Q1');
        const qPorts = result.evaluated.filter(
            (e) => e.type === 'source_port' && e.source_component_id === q1?.source_component_id,
        );
        for (const letter of ['c', 'b', 'e']) {
            const matches = qPorts.filter((p) => (p.port_hints ?? []).includes(letter));
            if (matches.length !== 1)
                fail(
                    `semantic anchor: transistor hint '${letter}' matches ${matches.length} ports (expected exactly 1) — upstream alias change!`,
                );
        }
        ok('semantic anchors: transistor c/b/e hints unique on the real board');
    }
    if (name === 'divider-led') {
        const led = result.evaluated.find((e) => e.type === 'source_component' && e.name === 'LED1');
        const ledPorts = result.evaluated.filter(
            (e) => e.type === 'source_port' && e.source_component_id === led?.source_component_id,
        );
        const anode = ledPorts.filter((p) => (p.port_hints ?? []).includes('anode'));
        const cathode = ledPorts.filter((p) => (p.port_hints ?? []).includes('cathode'));
        if (anode.length !== 1 || cathode.length !== 1 || anode[0] === cathode[0]) {
            fail('semantic anchor: led anode/cathode hints not uniquely resolvable — upstream alias change!');
        } else ok('semantic anchors: led anode/cathode hints unique on the real board');
    }
    boards.push([name, dir]);
}

// ---------------------------------------------------------------- notary (Docker kicad-cli 10)

let dockerOk = false;
try {
    execFileSync('docker', ['image', 'inspect', KICAD_IMAGE], { stdio: 'ignore', timeout: 30000 });
    dockerOk = true;
} catch {
    console.log(`\n(kicad notary skipped — ${KICAD_IMAGE} not available locally)`);
}
if (!dockerOk && STRICT)
    fail(`PCB_GATE_STRICT: ${KICAD_IMAGE} not available — the DRC gate cannot run (refusing a silent green).`);

// ONE runner for every DRC verdict in this harness — see scripts/lib/kicad-drc.mjs.
const drcReportRunner = makeKicadDrcReportRunner({ workDir: outRoot });

if (dockerOk) {
    // NOTARY POLICY (Phase 1): the DRC verdict is REPORTED as the manufacturable-stamp status, not a
    // process gate — the local fast router cannot yet meet the 0.2mm clearance profile on dense areas
    // (tracks_crossing/clearance are ROUTER-quality issues; the freerouting quality tier owns the
    // DRC-clean stamp).
    //
    // The verdict comes from the SHARED runner, which is the same code and the same severity policy the
    // product ships. This harness used to run its own kicad-cli invocation at --severity-error and read
    // exit 5 itself, which made its stamp a SECOND implementation of the manufacturability verdict — and a
    // harness whose stamp is computed differently from the product's is not evidence about the product, in
    // either direction. It also could not see warning-severity findings at all, so it reported CLEAN on
    // boards the product now reports 30+ findings on.
    console.log('\n── notary: kicad-cli 10 DRC (shared runner, judged by OUR .kicad_pro rules)');
    for (const [name, dir] of boards) {
        rmSync(join(dir, 'drc.json'), { force: true }); // never let a STALE report masquerade as this run's verdict
        let report;
        try {
            report = await drcReportRunner(
                readFileSync(join(dir, 'board.kicad_pcb'), 'utf8'),
                readFileSync(join(dir, 'board.kicad_pro'), 'utf8'),
            );
        } catch (e) {
            // The notary FAILED rather than judging. Distinct from a dirty board on purpose: the shared
            // runner is fail-closed, so a missing or unreadable report arrives here and never as a verdict.
            fail(`${name}: kicad-cli DRC did not report — ${String(e).slice(0, 200)}`);
            continue;
        }
        const warned = report.warnings.length ? ` (+${report.warnings.length} warning-severity finding(s), not gating)` : '';
        if (report.clean) {
            ok(`${name}: DRC CLEAN — manufacturable stamp ✔${warned}`);
            continue;
        }
        const byType = {};
        for (const v of report.violations) byType[v.type] = (byType[v.type] ?? 0) + 1;
        const detail =
            [
                report.violations.length
                    ? `${report.violations.length} blocking violation(s): ${Object.entries(byType)
                          .map(([t, n]) => `${t}×${n}`)
                          .join(', ')}`
                    : null,
                report.unconnected.length ? `${report.unconnected.length} unconnected item(s)` : null,
            ]
                .filter(Boolean)
                .join(' + ') || 'not clean with an empty report (unexpected)';
        console.log(`  ⚠ ${name}: stamp NOT clean — ${detail}${warned}`);
    }
}

// ---------------------------------------------------------------- quality route (the DRC-CLEAN stamp)

let frOk = false;
if (dockerOk) {
    try {
        execFileSync('docker', ['image', 'inspect', FR_IMAGE], { stdio: 'ignore', timeout: 30000 });
        frOk = true;
    } catch {
        console.log(`\n(quality tier skipped — ${FR_IMAGE} not available locally)`);
    }
}
if (!frOk && STRICT) fail(`PCB_GATE_STRICT: ${FR_IMAGE} not available — the quality-route DRC-clean gate cannot run.`);

if (frOk) {
    // Unlike the Phase-1 notary above (report-only, fast router), the quality route IS the pass/fail
    // manufacturable stamp: freerouting routes with the fab padstack -> mergeSes splices the copper onto
    // the FULL placed board -> injectModels adds real 3D bodies -> kicad-cli DRC must come back CLEAN.
    console.log('\n── quality route: freerouting 2.2.4 → splice → 3D bodies → kicad-cli 10 DRC (manufacturable stamp)');
    const freeroute = makeFreeroutingRunner({ workDir: outRoot });
    const notaryDrc = makeKicadDrcRunner({ workDir: outRoot }); // Lever 1: DRC-oracle margin retry + local fallback
    const toDocker = (p) => p.replace(/\\/g, '/');
    for (const [name, circuit] of cases) {
        const dir = join(outRoot, name);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        let q;
        try {
            q = await layoutCircuit(circuit, { router: 'quality', freeroute, notaryDrc });
        } catch (e) {
            fail(`${name}: quality layoutCircuit threw — ${String(e).slice(0, 200)}`);
            continue;
        }
        if (!q.ok || !q.outputs) {
            fail(
                `${name}: quality route not ok — ${q.diagnostics
                    .filter((d) => d.severity === 'error')
                    .map((d) => d.code)
                    .join(',')}`,
            );
            continue;
        }
        const applied = q.diagnostics.find((d) => d.code === 'PCB030' && d.message.includes('applied'));
        if (!applied) {
            // Say WHY. pcb-core records the degradation as PCB035 (the route threw — usually the freerouting
            // container itself) or PCB036 (no margin produced an accepted board). Reporting only "did not
            // apply" makes a broken container and a genuinely unroutable board look identical, which is
            // exactly the situation this gate exists to avoid — and it left a CI failure undiagnosable from
            // its own log. Dump the full diagnostic set to disk too, so nothing is lost to truncation.
            const why = q.diagnostics.filter((d) => d.code === 'PCB035' || d.code === 'PCB036');
            writeFileSync(join(dir, 'quality-diagnostics.json'), JSON.stringify(q.diagnostics, null, 1));
            fail(
                `${name}: quality route did NOT apply (freerouting not engaged) — ` +
                    (why.length
                        ? why.map((d) => `${d.code}: ${d.message}`).join(' | ')
                        : `no PCB035/PCB036 diagnostic either; full set: ${q.diagnostics.map((d) => d.code).join(',')}`),
            );
            continue;
        }
        ok(`${name}: ${applied.message}`);

        // Cross-check the typed field against the human message: they are produced by different code paths,
        // so agreement is evidence, and the margin must be the one actually accepted rather than a default.
        const qd = q.delivery?.routing;
        if (qd?.tier !== 'quality' || qd.drcCertified !== true || qd.degradedReason) {
            fail(`${name}: delivery must report a certified QUALITY route — got ${JSON.stringify(qd)}`);
        } else if (!applied.message.includes(`margin ${qd.marginMm}mm`)) {
            fail(`${name}: delivery.marginMm=${qd.marginMm} disagrees with the accepted route (${applied.message})`);
        } else {
            ok(`${name}: delivery agrees with the route — tier=quality, DRC-certified, margin ${qd.marginMm}mm`);
        }

        // The routing headroom must be GIVEN BACK. freerouting routes inside an oversized outline (the
        // margin ladder above), and that headroom used to survive into the delivered board: measured on
        // this very fixture, a 22×11mm circuit shipped as a 50×40mm board — 83% of the laminate empty,
        // priced by area, and invisible to every check because empty copper-free area violates no rule.
        // pcb-core now trims the outline back and re-certifies it with the notary; assert that it did,
        // because a silently-skipped trim looks exactly like a working one from the outside.
        const outline = (pcb) => {
            const xs = [],
                ys = [];
            for (const m of pcb.matchAll(
                /\(gr_line\s+\(start ([-\d.]+) ([-\d.]+)\)\s+\(end ([-\d.]+) ([-\d.]+)\)[\s\S]{0,200}?Edge\.Cuts/g,
            )) {
                xs.push(+m[1], +m[3]);
                ys.push(+m[2], +m[4]);
            }
            return xs.length ? { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } : null;
        };
        const trimmedTo = outline(q.outputs.kicadPcb);
        const trimNote = q.diagnostics.find((d) => d.code === 'PCB052');
        // The board was routed inside (auto-size + 2×margin). Anything close to that is untrimmed.
        const routedW = (trimmedTo?.w ?? 0) + 2 * (q.delivery?.routing?.marginMm ?? 0);
        if (!trimmedTo) {
            fail(`${name}: delivered board has no Edge.Cuts outline to measure`);
        } else if (!trimNote) {
            fail(`${name}: no PCB052 — the outline trim did not even report an outcome`);
        } else if (!trimNote.message.includes('trimmed')) {
            fail(`${name}: routing headroom NOT returned — ${trimNote.message}`);
        } else {
            ok(
                `${name}: routing headroom returned — delivered ${trimmedTo.w.toFixed(1)}×${trimmedTo.h.toFixed(1)}mm ` +
                    `instead of ~${routedW.toFixed(1)}mm wide, DRC re-certified`,
            );
        }

        // Reference designators must be PLOTTED, and that is checked on the OUTPUT rather than inferred
        // from the source. circuit-json-to-kicad writes each designator twice — a modern
        // `(property "Reference" …)` carrying `(hide yes)` and a legacy visible `(fp_text reference …)`.
        // Reading only the hidden property makes the silkscreen look blank; it is not, kicad-cli plots the
        // fp_text (re-hiding the property leaves the F.Silkscreen gerber byte-identical). But fp_text is the
        // DEPRECATED half of that pair: the release that drops it leaves only the hidden property, and every
        // board then ships unlabelled — assemblable by a pick-and-place machine and by nobody else. Nothing
        // downstream would notice, because silkscreen carries no design rule, so DRC stays clean and the
        // manufacturability verdict does not move. This is the only thing that would go red.
        const designated = hasVisibleDesignators(q.outputs.kicadPcb);
        const silkOps = (l) => ((q.outputs.gerbers.layers[l] ?? '').match(/D0[123]\*/g) ?? []).length;
        const plotted = silkOps('F_SilkScreen') + silkOps('B_SilkScreen');
        if (!designated)
            fail(`${name}: no VISIBLE reference designator on either silkscreen layer — the board ships unlabelled`);
        else if (plotted === 0)
            fail(`${name}: the board declares designators but the delivered silkscreen gerbers plot nothing`);
        else ok(`${name}: designators reach the delivered silkscreen — ${plotted} plotted operation(s)`);

        // ONE PHYSICAL HOLE, ONE DRILL HIT. dsn-converter describes every layer change twice — as a
        // standalone pcb_via carrying the real padstack AND as a route_type:'via' waypoint inside the trace
        // — and circuit-json-to-kicad emits a (via …) record for both. The waypoint has no dimensions, so
        // its record lands at KiCad's 0.8/0.4 default. Measured on a delivered board before the fix, the
        // drill file carried "T1 (0.300) X90.657Y-110.535" and "T2 (0.400) X90.657Y-110.535": two hits, two
        // tool diameters, one coordinate. The wider one wins, so the finished annular ring is 0.10mm
        // against a 0.15mm rule — on a board stamped manufacturable.
        //
        // KiCad reports it too, as `holes_co_located` at WARNING severity — which the notary now collects
        // and surfaces, where it used to be invisible because the DRC ran at --severity-error. This
        // structural check is kept anyway and is not redundant: it reads OUR OWN output rather than KiCad's
        // opinion of it, so it stays exact and stays independent of what severity a future KiCad assigns.
        // A defect this expensive — a fab drilling one hole twice at two diameters, on a board stamped
        // manufacturable — is worth being told about by two witnesses that cannot fail the same way.
        const viaRecords = [...q.outputs.kicadPcb.matchAll(/\(via[\s\S]{0,240}?\(at ([-\d.]+) ([-\d.]+)\)/g)].map(
            (m) => `${m[1]},${m[2]}`,
        );
        const coincident = viaRecords.filter((v, i) => viaRecords.indexOf(v) !== i);
        if (coincident.length)
            fail(
                `${name}: ${coincident.length} via(s) described TWICE at the same coordinate — the fab drills ` +
                    `each of ${[...new Set(coincident)].join(' / ')} twice, at two different diameters`,
            );
        else ok(`${name}: ${viaRecords.length} via(s), each described exactly once — no coincident drill hits`);

        // real 3D bodies for every footprint
        const injectResult = injectModels(q.outputs.kicadPcb);
        writeFileSync(join(dir, 'board_quality.kicad_pcb'), q.outputs.kicadPcb);
        writeFileSync(join(dir, 'board_quality_bodies.kicad_pcb'), injectResult.kicadPcb);
        writeFileSync(join(dir, 'board_quality.kicad_pro'), q.outputs.kicadPro);
        if (injectResult.unmatched.length) {
            fail(
                `${name}: ${injectResult.unmatched.length} footprint(s) with no 3D body — ${injectResult.unmatched.map((u) => u.id).join(', ')}`,
            );
        } else if (injectResult.injected === 0) {
            // Vacuous-pass guard: zero unmatched AND zero injected means the regex matched nothing (e.g. the
            // converter changed footprint formatting) — a silent "all bodied" that bodied nothing.
            fail(
                `${name}: injectModels matched 0 footprints — 3D-body injection is broken (footprint format changed?)`,
            );
        } else {
            ok(`${name}: 3D bodies injected for all ${injectResult.injected} footprint(s)`);
        }

        // DRC now EXPECTS clean — this is the stamp, not a report. Same shared runner as the notary
        // section above, so the harness and the product cannot reach different conclusions about the
        // same board, and the warnings the product reports are visible here too.
        rmSync(join(dir, 'drc_quality.json'), { force: true });
        let qReport;
        try {
            qReport = await drcReportRunner(
                readFileSync(join(dir, 'board_quality.kicad_pcb'), 'utf8'),
                readFileSync(join(dir, 'board_quality.kicad_pro'), 'utf8'),
            );
        } catch (e) {
            fail(`${name}: quality kicad-cli DRC did not report — ${String(e).slice(0, 200)}`);
            continue;
        }
        const qWarned = qReport.warnings.length
            ? ` (+${qReport.warnings.length} warning-severity finding(s), not gating)`
            : '';
        if (qReport.clean) {
            ok(
                `${name}: quality DRC CLEAN — manufacturable stamp ✔✔ (traces=${q.stats.traces} vias=${q.stats.vias})${qWarned}`,
            );
        } else {
            // The stamp requires BOTH zero blocking violations AND zero unconnected nets (an unrouted net
            // is a real defect, reported separately from `violations` in the DRC JSON).
            const byType = {};
            for (const v of qReport.violations) byType[v.type] = (byType[v.type] ?? 0) + 1;
            const parts = [];
            if (qReport.violations.length)
                parts.push(
                    `${qReport.violations.length} blocking violation(s): ${Object.entries(byType)
                        .map(([t, n]) => `${t}×${n}`)
                        .join(', ')}`,
                );
            if (qReport.unconnected.length) parts.push(`${qReport.unconnected.length} unrouted net(s)`);
            fail(`${name}: quality DRC NOT clean — ${parts.join(' + ')}${qWarned}`);
        }

        // The DELIVERED fab bundle — the one artifact nothing downstream inspects. The manufacturability
        // verdict is computed from DRC violation/unconnected counts alone, so it is blind to what was
        // PLOTTED: a board exported without soldermask yields a byte-identical DRC verdict and ships
        // stamped manufacturable. The worker asserts this too (runners/kicad.ts), but pcb-gate.yml
        // deliberately does not trigger on apps/pcb-worker/**, so only this check runs against a BUMPED
        // KiCad image — which is the event the gate exists for. Until now its only layer assertion
        // inspected pcb-core's soup gerbers, the artifact the worker explicitly does not deliver.
        try {
            const gbrDir = join(dir, 'delivered-gbr');
            rmSync(gbrDir, { recursive: true, force: true });
            mkdirSync(gbrDir, { recursive: true });
            execFileSync(
                'docker',
                [
                    'run',
                    '--rm',
                    ...dockerUserArgs(),
                    '-v',
                    `${toDocker(dir)}:/work`,
                    KICAD_IMAGE,
                    'kicad-cli',
                    'pcb',
                    'export',
                    'gerbers',
                    '--check-zones',
                    '--output',
                    '/work/delivered-gbr',
                    '/work/board_quality.kicad_pcb',
                ],
                { stdio: 'pipe', timeout: 300000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
            );
            const delivered = {};
            for (const f of readdirSync(gbrDir)) {
                if (f.endsWith('.gbrjob') || f.endsWith('.drl')) continue;
                delivered[f.replace(/^board_quality-/, '').replace(/\.[^.]+$/, '')] = readFileSync(
                    join(gbrDir, f),
                    'utf8',
                );
            }
            const required = ['F_Cu', 'B_Cu', 'Edge_Cuts', 'F_Mask', 'B_Mask'];
            const missing = required.filter((l) => delivered[l] === undefined);
            // A Gerber with no D01/D02/D03 plots nothing: headers, then M02*. Existence is not content.
            const blank = required.filter((l) => delivered[l] !== undefined && !/D0[123]\*/.test(delivered[l]));
            if (missing.length)
                fail(`${name}: delivered bundle is missing ${missing.join(', ')} — a board no fab can build`);
            else if (blank.length)
                fail(`${name}: delivered ${blank.join(', ')} plotted NO geometry — well-formed and empty`);
            else
                ok(
                    `${name}: delivered fab bundle complete — ${Object.keys(delivered).length} layers, all of ${required.join('/')} carry geometry`,
                );
        } catch (e) {
            fail(`${name}: delivered-gerber export failed — ${String(e.stderr ?? e).slice(-300)}`);
        }
        // Prove the injected bodies actually RESOLVE (not just that a GLB exists — board geometry alone can
        // be large). DIFFERENTIAL check: export the bare board and the bodied board with identical flags;
        // the bodied GLB must be materially larger, which only happens if --subst-models embedded the models.
        if (name === 'opamp-mixed') {
            const exportGlb = (src, out) => {
                rmSync(join(dir, out), { force: true });
                execFileSync(
                    'docker',
                    [
                        'run',
                        '--rm',
                        ...dockerUserArgs(),
                        '-v',
                        `${toDocker(dir)}:/work`,
                        KICAD_IMAGE,
                        'kicad-cli',
                        'pcb',
                        'export',
                        'glb',
                        '--include-tracks',
                        '--include-pads',
                        '--include-zones',
                        '--include-silkscreen',
                        '--include-soldermask',
                        '--subst-models',
                        '--output',
                        `/work/${out}`,
                        `/work/${src}`,
                    ],
                    { stdio: 'pipe', timeout: 300000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
                );
                return statSync(join(dir, out)).size;
            };
            // kicad-cli's GLB exporter occasionally dies inside its own allocator under memory pressure
            // ("malloc(): unaligned tcache chunk detected", observed 27 Tem 2026 — the same board exported
            // fine on the next run). That is the TOOL crashing, not the bodies failing to resolve, and the
            // two must not share a verdict: a crash is infrastructure and gets one retry, while an export
            // that SUCCEEDS but produces no body geometry is a real product regression and still fails.
            // Production takes the same view for a different reason — it delivers the fab bundle before the
            // 3D render precisely so a cosmetic export fault can never cost a manufacturable board.
            const exportGlbResilient = (src, out) => {
                try {
                    return exportGlb(src, out);
                } catch (e) {
                    console.log(
                        `  … glb export crashed (${String(e.stderr ?? e)
                            .slice(0, 80)
                            .trim()}) — retrying once`,
                    );
                    return exportGlb(src, out);
                }
            };
            try {
                const bareBytes = exportGlbResilient('board_quality.kicad_pcb', 'board_quality.glb'); // same flags, no (model ...) refs
                const bodiedBytes = exportGlbResilient('board_quality_bodies.kicad_pcb', 'board_quality_bodies.glb');
                const ratio = bodiedBytes / Math.max(bareBytes, 1);
                if (ratio >= 1.3)
                    ok(
                        `${name}: GLB bodies resolved — bodied ${Math.round(bodiedBytes / 1024)} KB vs bare ${Math.round(bareBytes / 1024)} KB (${ratio.toFixed(1)}×)`,
                    );
                else
                    fail(
                        `${name}: --subst-models did NOT add body geometry — bodied ${Math.round(bodiedBytes / 1024)} KB vs bare ${Math.round(bareBytes / 1024)} KB (${ratio.toFixed(2)}×, expected ≥1.3×)`,
                    );
            } catch (e) {
                fail(`${name}: glb export failed TWICE — ${String(e.stderr ?? e).slice(0, 200)}`);
            }
        }
    }
}

// ---------------------------------------------------------------- freerouting bridge (golden fixtures)

console.log('\n── freerouting bridge (golden fixtures from the real 2 Tem 2026 run)');
const fixtures = join(pkgRoot, '__fixtures__');
try {
    const denseCj = JSON.parse(readFileSync(join(fixtures, 'dense.circuit.json'), 'utf8'));
    const dsn = await exportDsn(stripRouting(denseCj));
    if (dsn.length > 1000 && dsn.includes('(pcb'))
        ok(`exportDsn: ${dsn.length} bytes of DSN from the stripped golden board`);
    else fail(`exportDsn produced implausible output (${dsn.length} bytes)`);

    const merged = await mergeSes(
        denseCj,
        readFileSync(join(fixtures, 'dense.dsn'), 'utf8'),
        readFileSync(join(fixtures, 'dense.ses'), 'utf8'),
    );
    const traces = merged.filter((e) => e.type === 'pcb_trace').length;
    const components = merged.filter((e) => e.type === 'pcb_component').length;
    // The splice must PRESERVE the placed board (components/pads), not reconstruct a loose-trace shell.
    if (traces > 0 && components > 0)
        ok(`mergeSes: golden SES spliced onto the full board — ${traces} traces + ${components} components preserved`);
    else fail(`mergeSes: expected traces AND preserved components, got traces=${traces} components=${components}`);
} catch (e) {
    fail(`freerouting bridge: ${String(e).slice(0, 300)}`);
}

// ---------------------------------------------------------------- tool failure ≠ DRC verdict
//
// The placement ladder retries a board with wider channels when it does not route DRC-clean. That is
// right for a VERDICT and wrong for a FAULT: if the router itself threw — a crashed container, a 300 s
// timeout — the next rung is a LARGER board, strictly more work for the tool that just failed, so it
// cannot help and only spends the timeout again. On a queue that drains one job at a time, every wasted
// rung is dead wall clock for every other tenant.
//
// Docker-free on purpose: the injected runner throws immediately, so this measures the CONTROL FLOW
// (how many times a broken tool is invoked), not the tools.
console.log(`\n── a failing router is not retried as if the board were dirty`);
try {
    let freerouteCalls = 0;
    const brokenFreeroute = async () => {
        freerouteCalls++;
        throw new Error('freerouting container failed (exit 137): killed');
    };
    const q = await layoutCircuit(dividerLed, {
        router: 'quality',
        freeroute: brokenFreeroute,
        notaryDrc: async () => true, // never reached — the router throws first
        placer: 'auto', // engages the channel ladder
    });

    // 1 ladder rung (short-circuited) + 1 genuinely different attempt on the grid board. Before the fix
    // this was 3: both rungs plus the grid attempt, each paying the tool failure in full.
    if (freerouteCalls !== 2) {
        fail(`a broken router was invoked ${freerouteCalls}× — expected 2 (one rung, then the grid attempt)`);
    } else {
        ok(`a broken router is invoked twice, not three times — the wider-channel rung is skipped`);
    }

    // The board must still be DELIVERED, by the local route, and must SAY the quality tier was not used.
    if (!q.ok) fail(`a router failure must not fail the board — it must fall back to the local route`);
    else if (q.delivery?.routing?.tier !== 'local' || !q.delivery.routing.degradedReason) {
        fail(`delivery must report the local tier with a reason — got ${JSON.stringify(q.delivery?.routing)}`);
    } else {
        ok(
            `the board is still delivered, honestly — tier=local, reason="${q.delivery.routing.degradedReason.slice(0, 70)}"`,
        );
    }

    // And the placement must report that it fell back BECAUSE the router failed, not because the layout
    // was rejected on its own merits — those are different problems with different fixes.
    if (q.delivery?.placement?.engine !== 'grid' || !/router failed/i.test(q.delivery.placement.degradedReason ?? '')) {
        fail(
            `placement should report a grid fallback caused by the router — got ${JSON.stringify(q.delivery?.placement)}`,
        );
    } else {
        ok(`placement blames the right thing — grid fallback, reason names the router failure`);
    }
} catch (e) {
    fail(`tool-failure ladder check: ${String(e).slice(0, 300)}`);
}

// ---------------------------------------------------------------- partial fab profile (real pipeline)
//
// A caller who overrides ONE manufacturing field used to replace the whole profile, leaving via geometry
// undefined — so the KiCad design rules, which are computed arithmetically from it, shipped with NaN in
// them and the DRC notary judged the board against a rulebook that was not a rulebook. The same gap also
// switched the ground pour off, because an absent flag was indistinguishable from a deliberate "no".
// Unit tests cover the resolver; this proves the REAL pipeline end to end on a real fixture.
console.log(`
── partial fab profile survives the real pipeline`);
try {
    const partial = await layoutCircuit(dividerLed, { fabProfile: { minTraceWidthMm: 0.25 } });
    if (!partial.ok) {
        fail(
            `partial profile: layout not ok — ${partial.diagnostics
                .filter((d) => d.severity === `error`)
                .map((d) => d.code)
                .join(`,`)}`,
        );
    } else {
        ok(`layout ok with a one-field override — traces=${partial.stats.traces} vias=${partial.stats.vias}`);

        const rules = JSON.parse(partial.outputs.kicadPro).board.design_settings.rules;
        const bad = Object.entries(rules).filter(([, v]) => typeof v === `number` && !Number.isFinite(v));
        if (bad.length) fail(`design rules contain non-finite values: ${JSON.stringify(bad)}`);
        else ok(`design rules all finite — min_via_diameter=${rules.min_via_diameter} (drill+2*annular, was NaN)`);

        if (rules.min_track_width !== 0.25)
            fail(`the override did not reach the rules (min_track_width=${rules.min_track_width})`);
        else ok(`the override itself is honoured — min_track_width=0.25`);

        if (partial.fab?.tier !== `economy`) fail(`resolved tier not recorded (got ${JSON.stringify(partial.fab)})`);
        else
            ok(
                `the board records the rules it was built by — tier=${partial.fab.tier}, ${Object.keys(partial.fab.profile).length} complete fields`,
            );

        if (partial.fab?.profile?.gndPour !== true)
            fail(`the ground pour was silently switched off by an unrelated override`);
        else ok(`ground pour still ON — an unrelated override no longer deletes the ground plane`);
    }

    // The other half of the contract: a value the fab cannot build is raised to its published limit and
    // disclosed, rather than quietly routed and then rejected at the panel.
    const tooFine = await layoutCircuit(dividerLed, { fabProfile: { minClearanceMm: 0.02 } });
    const raised = tooFine.diagnostics.find((d) => d.code === `fab_profile_adjusted`);
    if (tooFine.fab?.profile?.minClearanceMm !== 0.2)
        fail(`unmanufacturable clearance not clamped (got ${tooFine.fab?.profile?.minClearanceMm})`);
    else if (!raised) fail(`clamped silently — the adjustment was not disclosed`);
    else ok(`unmanufacturable value clamped AND disclosed — ${raised.message}`);
} catch (e) {
    fail(`partial fab profile: ${String(e).slice(0, 300)}`);
}

// ----------------------------------------------------------------

console.log(failures === 0 ? '\n✅ layout-check PASSED' : `\n❌ layout-check FAILED (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
