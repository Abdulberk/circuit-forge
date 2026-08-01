/**
 * Gallery circuit definitions (OUR CircuitJson) — shared by gen-gallery.mjs and placement-ab.mjs
 * so the A/B measurement runs EXACTLY the boards the gallery ships. Netlists only — no coordinates.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The vetted single-op-amp macromodel, REFERENCED rather than copied. Restating its body here would fork
// a model the product ships and tests, and the two copies would drift silently. Every consumer of this
// module already loads a built workspace package, so the import costs nothing new.
const { GENERIC_MODELS } = await import(
    new URL(
        `file://${join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'eda-core', 'dist', 'index.js').replace(/\\/g, '/')}`,
    ).href
);
const OPAMPGEN = GENERIC_MODELS.opamp;

/**
 * A generic DUAL op-amp at the PACKAGE level: two OPAMPGEN cores in the industry-standard SOIC-8 dual
 * pinout, which LM358 / LM2904 / TL07x / MCP600x all share.
 *
 * The PINOUT is portable; the WIRING of the board using it is not, and the model cannot tell you that.
 * This fixture ties amp B's non-inverting input to V−, which only a part whose input common-mode range
 * INCLUDES V− tolerates (the LM358 family's defining feature). A TL072 there would phase-invert.
 * OPAMPGEN's input is `Rin inp inn 2Meg` — purely differential, with no common-mode limit at all — so it
 * reports a clean 0 V and can never surface that. Same for supply current: `Gm`/`Ebuf` are referenced to
 * node 0, so the rails deliver nothing (measured: max |i(V2)| = 2.0e-11 A while the output sources
 * 4.2e-4 A). First-order voltage behaviour is what this tier is for; power and common-mode are not in it.
 *
 * WHY THE PORTS ARE PAD NUMBERS. Two independent consumers read `ports`, and they must agree:
 * `generateNetlist` binds a subckt's pins to them BY NAME, and pcb-core's `chipPinOrder` uses the very
 * same array to decide which PAD each pin lands on (adapter.ts). Naming the ports "out"/"in+"/… would
 * bind SPICE correctly and then assign pad 1 to the output of whatever the port order happened to be —
 * a board that no longer matches the package. Naming them for the pads makes both readings identical,
 * which is also how vendor SPICE decks have always been written (`.SUBCKT LM358 1 2 3 4 5 6 7 8`).
 *
 * NOT called LM358GEN. It is not a model OF an LM358 — it is a generic op-amp topology in that package's
 * pinout, with generic-tier fidelity (first-order gain/pole/clamp, no datasheet Vos, Ib, slew or GBW).
 * Naming it after a real part would claim a fidelity it does not have.
 */
const OPAMP2GEN = {
    name: 'OPAMP2GEN',
    device: 'subckt',
    tier: 'generic',
    ports: ['1', '2', '3', '4', '5', '6', '7', '8'],
    body: [
        '* Generic dual op-amp, SOIC-8 dual pinout.',
        '* pads: 1=OUT_A 2=IN_A- 3=IN_A+ 4=V- 5=IN_B+ 6=IN_B- 7=OUT_B 8=V+',
        '.subckt OPAMP2GEN 1 2 3 4 5 6 7 8',
        'XA 1 3 2 8 4 OPAMPGEN',
        'XB 7 5 6 8 4 OPAMPGEN',
        '.ends',
    ].join('\n'),
};

const gnd = () => ({ id: 'gnd1', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] });

// ---------------------------------------------------------------- circuits (OUR CircuitJson)

/** 2-transistor astable multivibrator — the canonical discrete LED flasher. */
const astableFlasher = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 9', pins: [{ pinId: '+', netId: 'vcc' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'q1', type: 'bjt', designator: 'Q1', model: 'QGENNPN', pins: [{ pinId: 'c', netId: 'c1' }, { pinId: 'b', netId: 'b1' }, { pinId: 'e', netId: 'gnd' }] },
        { id: 'q2', type: 'bjt', designator: 'Q2', model: 'QGENNPN', pins: [{ pinId: 'c', netId: 'c2' }, { pinId: 'b', netId: 'b2' }, { pinId: 'e', netId: 'gnd' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '470', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'la1' }] },
        { id: 'r4', type: 'resistor', designator: 'R4', value: '470', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'la2' }] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '47k', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'b1' }] },
        { id: 'r3', type: 'resistor', designator: 'R3', value: '47k', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'b2' }] },
        { id: 'c1', type: 'capacitor', designator: 'C1', value: '10u', pins: [{ pinId: '1', netId: 'c1' }, { pinId: '2', netId: 'b2' }] },
        { id: 'c2', type: 'capacitor', designator: 'C2', value: '10u', pins: [{ pinId: '1', netId: 'c2' }, { pinId: '2', netId: 'b1' }] },
        { id: 'd1', type: 'diode', designator: 'LED1', model: 'LEDRED', pins: [{ pinId: 'anode', netId: 'la1' }, { pinId: 'cathode', netId: 'c1' }] },
        { id: 'd2', type: 'diode', designator: 'LED2', model: 'LEDRED', pins: [{ pinId: 'anode', netId: 'la2' }, { pinId: 'cathode', netId: 'c2' }] },
        gnd(),
    ],
    nets: [
        { id: 'vcc', name: 'VCC' }, { id: 'gnd', name: 'GND', isGround: true },
        { id: 'c1', name: 'C1N' }, { id: 'c2', name: 'C2N' }, { id: 'b1', name: 'B1' }, { id: 'b2', name: 'B2' },
        { id: 'la1', name: 'LA1' }, { id: 'la2', name: 'LA2' },
    ],
};

/**
 * Non-inverting amplifier (op-amp A, gain 1 + 100k/10k = 11) + LED indicator; op-amp B wired as a unity
 * follower with its input at ground.
 *
 * U1 used to be a `generic` catalog part, which meant the deck contained NO op-amp: the board "simulated"
 * as three resistors and an LED, and `v(OUT2)` did not exist because nothing drove that net. It now carries
 * the OPAMP2GEN macromodel, so both amplifiers in the package are actually in the deck. The FOOTPRINT and
 * the eight pins are unchanged — pcb-core routes `subckt` through the same chip-fallback path as `generic`
 * — so the board is the same board.
 */
const opampAmp = {
    version: '1.0',
    // Both models are listed because the resolver attaches only what a COMPONENT references: OPAMP2GEN's
    // body calls OPAMPGEN, and a body reference is not followed. Omitting it yields a deck missing the
    // .subckt it instantiates, which nothing catches until ngspice exits 1 with no output.
    models: [OPAMPGEN, OPAMP2GEN],
    components: [
        { id: 'u1', type: 'subckt', designator: 'U1', model: 'OPAMP2GEN', footprint: 'soic8', pins: [
            { pinId: '1', netId: 'out' }, { pinId: '2', netId: 'inm' }, { pinId: '3', netId: 'in' }, { pinId: '4', netId: 'gnd' },
            { pinId: '5', netId: 'gnd' }, { pinId: '6', netId: 'out2' }, { pinId: '7', netId: 'out2' }, { pinId: '8', netId: 'vcc' },
        ] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '100k', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'inm' }] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '10k', pins: [{ pinId: '1', netId: 'inm' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'r3', type: 'resistor', designator: 'R3', value: '1k', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'ledk' }] },
        { id: 'd1', type: 'diode', designator: 'LED1', model: 'LEDRED', pins: [{ pinId: 'anode', netId: 'ledk' }, { pinId: 'cathode', netId: 'gnd' }] },
        { id: 'vin', type: 'voltage_source', designator: 'V1', value: 'SIN(0 0.2 1k)', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'vcc', type: 'voltage_source', designator: 'V2', value: 'DC 9', pins: [{ pinId: '+', netId: 'vcc' }, { pinId: '-', netId: 'gnd' }] },
        gnd(),
    ],
    nets: [
        { id: 'out', name: 'OUT' }, { id: 'inm', name: 'INM' }, { id: 'in', name: 'IN' }, { id: 'out2', name: 'OUT2' },
        { id: 'vcc', name: 'VCC' }, { id: 'ledk', name: 'LEDK' }, { id: 'gnd', name: 'GND', isGround: true },
    ],
};

/** Full-wave bridge rectifier + smoothing cap + power-on LED + load. */
const bridgeRectifier = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'SIN(0 12 50)', pins: [{ pinId: '+', netId: 'ac1' }, { pinId: '-', netId: 'ac2' }] },
        { id: 'd1', type: 'diode', designator: 'D1', pins: [{ pinId: 'anode', netId: 'ac1' }, { pinId: 'cathode', netId: 'vplus' }] },
        { id: 'd2', type: 'diode', designator: 'D2', pins: [{ pinId: 'anode', netId: 'ac2' }, { pinId: 'cathode', netId: 'vplus' }] },
        { id: 'd3', type: 'diode', designator: 'D3', pins: [{ pinId: 'anode', netId: 'gnd' }, { pinId: 'cathode', netId: 'ac1' }] },
        { id: 'd4', type: 'diode', designator: 'D4', pins: [{ pinId: 'anode', netId: 'gnd' }, { pinId: 'cathode', netId: 'ac2' }] },
        { id: 'c1', type: 'capacitor', designator: 'C1', value: '100u', pins: [{ pinId: '1', netId: 'vplus' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'vplus' }, { pinId: '2', netId: 'ledk' }] },
        { id: 'led1', type: 'diode', designator: 'LED1', model: 'LEDRED', pins: [{ pinId: 'anode', netId: 'ledk' }, { pinId: 'cathode', netId: 'gnd' }] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '2.2k', pins: [{ pinId: '1', netId: 'vplus' }, { pinId: '2', netId: 'gnd' }] },
        gnd(),
    ],
    nets: [
        { id: 'ac1', name: 'AC1' }, { id: 'ac2', name: 'AC2' }, { id: 'vplus', name: 'VPLUS' },
        { id: 'ledk', name: 'LEDK' }, { id: 'gnd', name: 'GND', isGround: true },
    ],
};

/** 74HC595 serial-in/parallel-out shift register driving 8 LEDs (Q0..Q7 = pads 15,1..7). */
const shiftRegister = (() => {
    const OUT_PADS = ['15', '1', '2', '3', '4', '5', '6', '7']; // Q0..Q7 physical pads
    const comps = [
        { id: 'u1', type: 'generic', designator: 'U1', footprint: 'soic16', pins: [
            { pinId: '16', netId: 'vcc' }, { pinId: '8', netId: 'gnd' },
            { pinId: '10', netId: 'vcc' }, { pinId: '13', netId: 'gnd' }, // MR high, OE low
            { pinId: '14', netId: 'data' }, { pinId: '11', netId: 'shcp' }, { pinId: '12', netId: 'stcp' },
            ...OUT_PADS.map((pad, i) => ({ pinId: pad, netId: `q${i}` })),
        ] },
        { id: 'vcc', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'vcc' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'vdata', type: 'voltage_source', designator: 'V2', value: 'PULSE(0 5 0 1u 1u 5m 10m)', pins: [{ pinId: '+', netId: 'data' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'vshcp', type: 'voltage_source', designator: 'V3', value: 'PULSE(0 5 0 1u 1u 1m 2m)', pins: [{ pinId: '+', netId: 'shcp' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'vstcp', type: 'voltage_source', designator: 'V4', value: 'PULSE(0 5 0 1u 1u 8m 16m)', pins: [{ pinId: '+', netId: 'stcp' }, { pinId: '-', netId: 'gnd' }] },
        gnd(),
    ];
    const nets = [
        { id: 'vcc', name: 'VCC' }, { id: 'gnd', name: 'GND', isGround: true },
        { id: 'data', name: 'DATA' }, { id: 'shcp', name: 'SHCP' }, { id: 'stcp', name: 'STCP' },
    ];
    for (let i = 0; i < 8; i++) {
        comps.push({ id: `r${i}`, type: 'resistor', designator: `R${i + 1}`, value: '330', pins: [{ pinId: '1', netId: `q${i}` }, { pinId: '2', netId: `lk${i}` }] });
        comps.push({ id: `led${i}`, type: 'diode', designator: `LED${i + 1}`, model: 'LEDRED', pins: [{ pinId: 'anode', netId: `lk${i}` }, { pinId: 'cathode', netId: 'gnd' }] });
        nets.push({ id: `q${i}`, name: `Q${i}` }, { id: `lk${i}`, name: `LK${i}` });
    }
    return { version: '1.0', components: comps, nets };
})();

/** 7805 linear regulator: 12V→5V with input/output caps, power-on LED and load. */
const regulator5v = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 12', pins: [{ pinId: '+', netId: 'vin' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'u1', type: 'generic', designator: 'U1', footprint: 'to220', pins: [{ pinId: '1', netId: 'vin' }, { pinId: '2', netId: 'gnd' }, { pinId: '3', netId: 'vout' }] },
        { id: 'c1', type: 'capacitor', designator: 'C1', value: '330n', pins: [{ pinId: '1', netId: 'vin' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'c2', type: 'capacitor', designator: 'C2', value: '100u', pins: [{ pinId: '1', netId: 'vout' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'vout' }, { pinId: '2', netId: 'ledk' }] },
        { id: 'led1', type: 'diode', designator: 'LED1', model: 'LEDRED', pins: [{ pinId: 'anode', netId: 'ledk' }, { pinId: 'cathode', netId: 'gnd' }] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '1k', pins: [{ pinId: '1', netId: 'vout' }, { pinId: '2', netId: 'gnd' }] },
        gnd(),
    ],
    nets: [
        { id: 'vin', name: 'VIN' }, { id: 'vout', name: 'VOUT' }, { id: 'ledk', name: 'LEDK' }, { id: 'gnd', name: 'GND', isGround: true },
    ],
};

/** N-MOSFET low-side switch driving an inductive load (motor coil) with a flyback diode + status LED. */
const mosfetSwitch = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 12', pins: [{ pinId: '+', netId: 'vcc' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'v2', type: 'voltage_source', designator: 'V2', value: 'PULSE(0 5 0 1u 1u 5m 10m)', pins: [{ pinId: '+', netId: 'gatein' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'q1', type: 'mosfet', designator: 'Q1', model: 'MGENNMOS', pins: [{ pinId: 'd', netId: 'd' }, { pinId: 'g', netId: 'g' }, { pinId: 's', netId: 'gnd' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '100', pins: [{ pinId: '1', netId: 'gatein' }, { pinId: '2', netId: 'g' }] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '10k', pins: [{ pinId: '1', netId: 'g' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'l1', type: 'inductor', designator: 'L1', value: '1m', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'd' }] },
        { id: 'd1', type: 'diode', designator: 'D1', pins: [{ pinId: 'anode', netId: 'd' }, { pinId: 'cathode', netId: 'vcc' }] },
        { id: 'r3', type: 'resistor', designator: 'R3', value: '1k', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'ledk' }] },
        { id: 'led1', type: 'diode', designator: 'LED1', model: 'LEDRED', pins: [{ pinId: 'anode', netId: 'ledk' }, { pinId: 'cathode', netId: 'd' }] },
        gnd(),
    ],
    nets: [
        { id: 'vcc', name: 'VCC' }, { id: 'gnd', name: 'GND', isGround: true }, { id: 'gatein', name: 'GATEIN' },
        { id: 'g', name: 'G' }, { id: 'd', name: 'D' }, { id: 'ledk', name: 'LEDK' },
    ],
};

/** NE555 astable blinker — the canonical first-timer circuit (pin 5 CTRL left NC, declared). */
const ne555Blinker = {
    version: '1.0',
    components: [
        { id: 'u1', type: 'generic', designator: 'U1', footprint: 'soic8', pins: [
            { pinId: '1', netId: 'gnd' }, { pinId: '2', netId: 'thr' }, { pinId: '3', netId: 'out' },
            { pinId: '4', netId: 'vcc' }, { pinId: '6', netId: 'thr' }, { pinId: '7', netId: 'dis' }, { pinId: '8', netId: 'vcc' },
        ] },
        { id: 'ra', type: 'resistor', designator: 'R1', value: '10k', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'dis' }] },
        { id: 'rb', type: 'resistor', designator: 'R2', value: '47k', pins: [{ pinId: '1', netId: 'dis' }, { pinId: '2', netId: 'thr' }] },
        { id: 'c1', type: 'capacitor', designator: 'C1', value: '10u', pins: [{ pinId: '1', netId: 'thr' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'r3', type: 'resistor', designator: 'R3', value: '470', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'ledk' }] },
        { id: 'led1', type: 'diode', designator: 'LED1', model: 'LEDRED', pins: [{ pinId: 'anode', netId: 'ledk' }, { pinId: 'cathode', netId: 'gnd' }] },
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 9', pins: [{ pinId: '+', netId: 'vcc' }, { pinId: '-', netId: 'gnd' }] },
        gnd(),
    ],
    nets: [
        { id: 'vcc', name: 'VCC' }, { id: 'gnd', name: 'GND', isGround: true },
        { id: 'thr', name: 'THR' }, { id: 'dis', name: 'DIS' }, { id: 'out', name: 'OUT' }, { id: 'ledk', name: 'LEDK' },
    ],
};

/** 555 clock → CD4017 decade counter → 10 chasing LEDs (datasheet pinout: Q0..Q9 = 3,2,4,7,10,1,5,6,9,11). */
const chaser4017 = (() => {
    const Q_PADS = ['3', '2', '4', '7', '10', '1', '5', '6', '9', '11'];
    const comps = [
        { id: 'u1', type: 'generic', designator: 'U1', footprint: 'soic8', pins: [
            { pinId: '1', netId: 'gnd' }, { pinId: '2', netId: 'thr' }, { pinId: '3', netId: 'clk' },
            { pinId: '4', netId: 'vcc' }, { pinId: '6', netId: 'thr' }, { pinId: '7', netId: 'dis' }, { pinId: '8', netId: 'vcc' },
        ] },
        { id: 'u2', type: 'generic', designator: 'U2', footprint: 'soic16', pins: [
            { pinId: '16', netId: 'vcc' }, { pinId: '8', netId: 'gnd' },
            { pinId: '14', netId: 'clk' }, { pinId: '13', netId: 'gnd' }, { pinId: '15', netId: 'gnd' },
            ...Q_PADS.map((pad, i) => ({ pinId: pad, netId: `q${i}` })),
        ] },
        { id: 'ra', type: 'resistor', designator: 'R11', value: '1k', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'dis' }] },
        { id: 'rb', type: 'resistor', designator: 'R12', value: '10k', pins: [{ pinId: '1', netId: 'dis' }, { pinId: '2', netId: 'thr' }] },
        { id: 'ct', type: 'capacitor', designator: 'C1', value: '10u', pins: [{ pinId: '1', netId: 'thr' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 9', pins: [{ pinId: '+', netId: 'vcc' }, { pinId: '-', netId: 'gnd' }] },
        gnd(),
    ];
    const nets = [
        { id: 'vcc', name: 'VCC' }, { id: 'gnd', name: 'GND', isGround: true },
        { id: 'thr', name: 'THR' }, { id: 'dis', name: 'DIS' }, { id: 'clk', name: 'CLK' },
    ];
    for (let i = 0; i < 10; i++) {
        comps.push({ id: `r${i}`, type: 'resistor', designator: `R${i + 1}`, value: '330', pins: [{ pinId: '1', netId: `q${i}` }, { pinId: '2', netId: `lk${i}` }] });
        comps.push({ id: `led${i}`, type: 'diode', designator: `LED${i + 1}`, model: 'LEDRED', pins: [{ pinId: 'anode', netId: `lk${i}` }, { pinId: 'cathode', netId: 'gnd' }] });
        nets.push({ id: `q${i}`, name: `Q${i}` }, { id: `lk${i}`, name: `LK${i}` });
    }
    return { version: '1.0', components: comps, nets };
})();

export const galleryCases = [
    ['astable-flasher', astableFlasher],
    ['opamp-amp', opampAmp],
    ['bridge-rectifier', bridgeRectifier],
    ['shift-register', shiftRegister],
    ['regulator-5v', regulator5v],
    ['mosfet-switch', mosfetSwitch],
    ['ne555-blinker', ne555Blinker],
    ['chaser-4017', chaser4017],
];

/**
 * How each board is meant to be EXCITED, so a simulation of it shows what the circuit actually does.
 *
 * Kept beside the fixtures and separate from `galleryCases`: a board's layout and its stimulus are
 * different facts, and a board with no entry here is honestly reported as having no declared stimulus
 * rather than silently simulated on a guessed timebase. Each window is derived from the circuit's OWN
 * excitation — a 50 Hz rectifier and a 1 kHz amplifier do not share a timebase, and inferring one would be
 * a heuristic whose output we would then animate.
 *
 * `note` records what the simulation is expected to SHOW, including when the honest answer is "nothing
 * moves". A board sitting at steady state and a board we failed to simulate look identical in a waveform
 * viewer and are completely different facts.
 */
export const gallerySimPlan = {
    'astable-flasher': {
        analysis: { type: 'tran', stopTime: '2', stepTime: '2m' },
        // 47k x 10u gives a ~0.65 s period, so 2 s is three cycles — but an IDEAL astable is perfectly
        // symmetric and sits in its unstable equilibrium forever. A real one starts from noise; SPICE needs
        // an initial condition it is not given here, so this correctly reports a circuit that never starts.
        note: 'idealised astable: symmetric, so it rests at equilibrium and does not oscillate without an initial condition',
    },
    'opamp-amp': {
        analysis: { type: 'tran', stopTime: '5m', stepTime: '5u' },
        // The positive half is the circuit: +2.20 V out from ±0.2 V in is exactly the 11× the 100k/10k pair
        // sets. The −0.49 V floor is NOT. It is OPAMPGEN's clamp diode (`Dlo vee n2 DCLMP`) conducting a
        // forward drop BELOW the negative rail — measured, not inferred: moving V− from 0 V to −1 V moved
        // the floor from −0.4876 to −1.4652, so it tracks the rail, not ground. No physical op-amp drives
        // its output below its own V−; a real single-supply part stops a few millivolts above it.
        //
        // This note previously said "single supply, so the negative half clips near ground" — false in the
        // same flattering direction as the two notes corrected alongside it, and by the same mechanism:
        // attributing a macromodel artifact to the circuit.
        note: 'SIN(0 0.2 1k) in, gain 11 — the positive half is the circuit; the −0.49 V floor is the generic macromodel’s rail clamp, not board behaviour (a real single-supply part stops at V−)',
    },
    'bridge-rectifier': {
        analysis: { type: 'tran', stopTime: '100m', stepTime: '100u' },
        note: 'SIN(0 12 50) mains-frequency input — five cycles of rectification and filtering',
    },
    'shift-register': {
        analysis: { type: 'tran', stopTime: '100m', stepTime: '100u' },
        note: '10 ms clock period — ten shifts of the data pattern through the register',
    },
    'regulator-5v': {
        analysis: { type: 'tran', stopTime: '20m', stepTime: '20u' },
        // This note used to read "the rail is regulated and steady — a flat trace is the right answer".
        // That was wrong, and wrong in the most flattering direction: the 7805 is a catalog-only part with
        // no SPICE model, so it is not in the deck at all. The trace is flat because there is no regulator,
        // not because the regulator is doing its job. `simulationCoverage` now states this per board.
        note: 'the 7805 is a catalog-only part with no simulation model — the deck has an open where it belongs, so this is NOT a picture of regulation',
    },
    'ne555-blinker': {
        analysis: { type: 'tran', stopTime: '2', stepTime: '2m' },
        // Likewise: there is no 555 macromodel to oscillate. What simulates is the RC timing network alone.
        note: 'the NE555 is a catalog-only part with no simulation model — only its RC timing network is in the deck, so nothing can blink',
    },
    'chaser-4017': {
        analysis: { type: 'tran', stopTime: '2', stepTime: '2m' },
        note: '4017 is a catalog-only part with no simulation model — expected to be unsimulatable',
    },
    'mosfet-switch': {
        analysis: { type: 'tran', stopTime: '50m', stepTime: '50u' },
        note: '10 ms gate pulse — expected to fail: the MOSFET is drawn with 3 pins and ERC rejects it',
    },
};
