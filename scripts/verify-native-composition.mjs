/**
 * FULL native composition proof (LAYOUTJOB_PLAN.md M3) — runs INSIDE the pcb-worker image, where a
 * self-contained pcb-core is baked in. Unlike verify-native-pipeline.mjs (which exercises the native
 * runner PRIMITIVES against golden fixtures), this drives the WHOLE engine end-to-end with the native
 * runners injected — the exact path the worker will run:
 *
 *   layoutCircuit(router:'quality') → adapter → tscircuit eval → NATIVE freerouting (java -jar) →
 *   mergeSes → assembleKicadPcb → margin-retry judged by NATIVE kicad-cli DRC → injectModels →
 *   NATIVE kicad-cli GLB export.
 *
 * This closes the substitution gap: it proves the native freerouting SES is splice-able and the native
 * DRC oracle drives the accept/reject loop correctly, on real circuits, in the real image.
 *
 * Run:  docker run --rm pcb-worker:local node /app/verify-native-composition.mjs
 * Exits non-zero on any failure.
 */
const pcbCore = process.env.PCB_CORE_DIST ?? '/app/pcb-core/dist/index.js';
const runnersDir = process.env.PCB_RUNNERS_DIR ?? '/app/runners';

const { layoutCircuit, injectModels } = await import(`file://${pcbCore}`);
const { makeNativeFreeroutingRunner } = await import(`file://${runnersDir}/freerouting-native.mjs`);
const { makeNativeKicad } = await import(`file://${runnersDir}/kicad-native.mjs`);

let failures = 0;
const fail = (m) => { failures++; console.error(`  ✗ ${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);

const gnd = (netId) => ({ id: 'gnd1', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId }] });

// Two real circuits — a divider+LED (LED 3D body + THT) and a common-emitter amp (BJT pin-map + more nets).
const dividerLed = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 9', pins: [{ pinId: '+', netId: 'vin' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '10k', pins: [{ pinId: '1', netId: 'vin' }, { pinId: '2', netId: 'vout' }] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '10k', pins: [{ pinId: '1', netId: 'vout' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'r3', type: 'resistor', designator: 'R3', value: '330', pins: [{ pinId: '1', netId: 'vout' }, { pinId: '2', netId: 'ledk' }] },
        { id: 'd1', type: 'diode', designator: 'LED1', model: 'led_red', pins: [{ pinId: 'anode', netId: 'ledk' }, { pinId: 'cathode', netId: 'gnd' }] },
        gnd('gnd'),
    ],
    nets: [
        { id: 'vin', name: 'VIN' }, { id: 'vout', name: 'VOUT' }, { id: 'ledk', name: 'LEDK' },
        { id: 'gnd', name: 'GND', isGround: true },
    ],
};
const ceAmp = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 12', pins: [{ pinId: '+', netId: 'vcc' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'v2', type: 'voltage_source', designator: 'V2', value: 'SIN(0 0.01 1k)', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'q1', type: 'bjt', designator: 'Q1', model: 'QGENNPN', pins: [{ pinId: 'c', netId: 'vc' }, { pinId: 'b', netId: 'vb' }, { pinId: 'e', netId: 've' }] },
        { id: 'rc', type: 'resistor', designator: 'RC1', value: '4.7k', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'vc' }] },
        { id: 'rb1', type: 'resistor', designator: 'RB1', value: '100k', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'vb' }] },
        { id: 'rb2', type: 'resistor', designator: 'RB2', value: '22k', pins: [{ pinId: '1', netId: 'vb' }, { pinId: '2', netId: 'gnd' }] },
        { id: 're', type: 'resistor', designator: 'RE1', value: '1k', pins: [{ pinId: '1', netId: 've' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'c1', type: 'capacitor', designator: 'C1', value: '100n', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'vb' }] },
        gnd('gnd'),
    ],
    nets: [
        { id: 'vcc', name: 'VCC' }, { id: 'in', name: 'IN' }, { id: 'vc', name: 'VC' },
        { id: 'vb', name: 'VB' }, { id: 've', name: 'VE' }, { id: 'gnd', name: 'GND', isGround: true },
    ],
};

const kicad = makeNativeKicad();
const freeroute = makeNativeFreeroutingRunner(); // default 30 passes

for (const [name, circuit] of [['divider-led', dividerLed], ['ce-amp', ceAmp]]) {
    console.log(`\n── ${name}: full native layoutCircuit(router:'quality')`);
    const t0 = Date.now();
    let q;
    try {
        q = await layoutCircuit(circuit, { router: 'quality', freeroute, notaryDrc: kicad.notaryDrc });
    } catch (e) {
        fail(`${name}: layoutCircuit threw — ${String(e).slice(0, 300)}`);
        continue;
    }
    if (!q.ok || !q.outputs) {
        fail(`${name}: not ok — ${q.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`).join(' | ').slice(0, 300)}`);
        continue;
    }
    const applied = q.diagnostics.find((d) => d.code === 'PCB030' && d.message.includes('applied'));
    if (!applied) { fail(`${name}: quality route did NOT apply (native freerouting not engaged / SES not spliced)`); continue; }
    ok(`${name}: ${applied.message} in ${Date.now() - t0}ms (traces=${q.stats.traces} vias=${q.stats.vias})`);

    if (q.parity.checkedPins !== q.parity.expectedPins) fail(`${name}: parity ${q.parity.checkedPins}/${q.parity.expectedPins}`);
    else ok(`${name}: parity ${q.parity.checkedPins}/${q.parity.expectedPins} pins isomorphic`);

    // The definitive stamp — the board the NATIVE margin-retry accepted must be DRC-clean under a
    // FRESH native DRC run (not merely trusted from inside the loop).
    const clean = await kicad.notaryDrc(q.outputs.kicadPcb, q.outputs.kicadPro);
    if (clean === true) ok(`${name}: native kicad-cli DRC CLEAN on the quality-routed board — manufacturable ✔✔`);
    else fail(`${name}: quality-routed board is NOT DRC-clean under a fresh native run`);

    // 3D bodies + GLB, natively.
    const inj = injectModels(q.outputs.kicadPcb);
    if (inj.unmatched.length) fail(`${name}: ${inj.unmatched.length} footprint(s) with no 3D body — ${inj.unmatched.map((u) => u.id).join(', ')}`);
    else if (inj.injected === 0) fail(`${name}: injectModels matched 0 footprints (format changed?)`);
    else ok(`${name}: 3D bodies injected for all ${inj.injected} footprint(s)`);

    try {
        const bodied = await kicad.exportGlb(inj.kicadPcb);
        const bare = await kicad.exportGlb(q.outputs.kicadPcb);
        const magic = bodied.slice(0, 4).toString('ascii');
        const ratio = bodied.length / Math.max(bare.length, 1);
        if (magic === 'glTF' && ratio >= 1.3) ok(`${name}: native GLB, bodies resolved — bodied ${Math.round(bodied.length / 1024)}KB vs bare ${Math.round(bare.length / 1024)}KB (${ratio.toFixed(1)}×)`);
        else fail(`${name}: GLB weak — magic=${magic} ratio=${ratio.toFixed(2)}`);
    } catch (e) {
        fail(`${name}: native GLB export threw — ${String(e).slice(0, 200)}`);
    }
}

console.log(failures === 0 ? '\n✅ native-composition VERIFIED (full quality pipeline, native tools, end-to-end)' : `\n❌ native-composition FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
