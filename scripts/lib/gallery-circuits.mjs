/**
 * Gallery circuit definitions (OUR CircuitJson) — shared by gen-gallery.mjs and placement-ab.mjs
 * so the A/B measurement runs EXACTLY the boards the gallery ships. Netlists only — no coordinates.
 */
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

/** LM358 non-inverting amplifier (op-amp A) + LED indicator; op-amp B wired as a clean unity follower. */
const opampAmp = {
    version: '1.0',
    components: [
        { id: 'u1', type: 'generic', designator: 'U1', footprint: 'soic8', pins: [
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
