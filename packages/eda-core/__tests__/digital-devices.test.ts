/**
 * Digital / mixed-signal (XSPICE) support: gate + flip-flop emission, variable-arity bracket syntax,
 * automatic analog<->digital bridging (adc/dac direction per net composition), flip-flop set/reset
 * tie-off to a synthesized constant-LOW rail, the analog-only NO-OP guarantee, and the digital ERC
 * rules. Pure netlist-string / logic assertions (the live ngspice proofs run separately, offline).
 */
import { generateNetlist } from '../src/netlist/generator';
import { planMixedSignal } from '../src/netlist/digital';
import { sanitizeNodeName } from '../src/netlist/sanitizer';
import { runErc } from '../src/erc/checker';
import { ErcCode } from '../src/types/erc';
import { isDigitalType, digitalPinRole, isLogicGateType, isSingleInputGate } from '../src/types/circuit';
import type { CircuitJson } from '../src/types/circuit';
import type { TranAnalysis } from '../src/types/analysis';

const TRAN: TranAnalysis = { type: 'tran', stopTime: '1m' };

/** Replicates buildNodeMap so plan/emit unit tests use the SAME node names the generator does. */
function nodeMapOf(c: CircuitJson): Map<string, string> {
    const m = new Map<string, string>();
    for (const net of c.nets) m.set(net.id, net.isGround ? '0' : sanitizeNodeName(net.id));
    return m;
}
/** The device line for the given instance prefix from a full netlist. */
function deviceLine(netlist: string, name: string): string | undefined {
    return netlist.split('\n').find((l) => l.split(/\s+/)[0] === name);
}

describe('digital type helpers', () => {
    it('classifies gate/dff as digital and analog parts as not', () => {
        expect(isDigitalType('logic_and')).toBe(true);
        expect(isDigitalType('logic_not')).toBe(true);
        expect(isDigitalType('dff')).toBe(true);
        expect(isDigitalType('resistor')).toBe(false);
        expect(isDigitalType('bjt')).toBe(false);
    });
    it('marks only not/buffer as single-input gates', () => {
        expect(isSingleInputGate('logic_not')).toBe(true);
        expect(isSingleInputGate('logic_buffer')).toBe(true);
        expect(isSingleInputGate('logic_and')).toBe(false);
        expect(isLogicGateType('dff')).toBe(false);
    });
    it('assigns pin roles: gate out / ff q,qb are sources, the rest are sinks', () => {
        expect(digitalPinRole('logic_and', 'out')).toBe('source');
        expect(digitalPinRole('logic_and', 'in1')).toBe('sink');
        expect(digitalPinRole('dff', 'q')).toBe('source');
        expect(digitalPinRole('dff', 'qb')).toBe('source');
        expect(digitalPinRole('dff', 'd')).toBe('sink');
        expect(digitalPinRole('dff', 'clk')).toBe('sink');
        expect(digitalPinRole('resistor', '1')).toBeNull();
    });
});

describe('digital emission', () => {
    it('emits a multi-input gate with bracket syntax + its timing model once', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'logic_and', designator: 'U1', pins: [
                    { pinId: 'in1', netId: 'a' }, { pinId: 'in2', netId: 'b' }, { pinId: 'out', netId: 'y' }] },
            ],
            nets: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'y', name: 'Y' }],
        };
        const netlist = generateNetlist(c, TRAN);
        expect(deviceLine(netlist, 'AU1')).toBe('AU1 [na nb] ny CFD_AND');
        expect(netlist).toContain('.model CFD_AND d_and(');
        expect(netlist.match(/\.model CFD_AND/g)?.length).toBe(1);
    });

    it('emits a single-input gate (not/buffer) with a SCALAR input port (no brackets)', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'logic_not', designator: 'U1', pins: [
                    { pinId: 'in1', netId: 'a' }, { pinId: 'out', netId: 'y' }] },
            ],
            nets: [{ id: 'a', name: 'A' }, { id: 'y', name: 'Y' }],
        };
        const netlist = generateNetlist(c, TRAN);
        expect(deviceLine(netlist, 'AU1')).toBe('AU1 na ny CFD_NOT');
        expect(netlist).toContain('.model CFD_NOT d_inverter(');
        expect(netlist).not.toContain('[na]'); // scalar, not bracketed
    });

    it('orders gate inputs by their numeric index regardless of authored order', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                // authored in3, in1, in2 — emission must sort to in1 in2 in3
                { id: 'u1', type: 'logic_nand', designator: 'U1', pins: [
                    { pinId: 'in3', netId: 'c3' }, { pinId: 'in1', netId: 'c1' },
                    { pinId: 'in2', netId: 'c2' }, { pinId: 'out', netId: 'y' }] },
            ],
            nets: [{ id: 'c1', name: 'C1' }, { id: 'c2', name: 'C2' }, { id: 'c3', name: 'C3' }, { id: 'y', name: 'Y' }],
        };
        const netlist = generateNetlist(c, TRAN);
        expect(deviceLine(netlist, 'AU1')).toBe('AU1 [nc1 nc2 nc3] ny CFD_NAND');
    });

    it('emits a D flip-flop in d clk set rst q qb order, auto-tying absent set/rst to a synthesized LOW rail', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'dff', designator: 'U1', pins: [
                    { pinId: 'd', netId: 'din' }, { pinId: 'clk', netId: 'clk' },
                    { pinId: 'q', netId: 'q' }, { pinId: 'qb', netId: 'qb' }] },
            ],
            nets: [{ id: 'din', name: 'DIN' }, { id: 'clk', name: 'CLK' }, { id: 'q', name: 'Q' }, { id: 'qb', name: 'QB' }],
        };
        const netlist = generateNetlist(c, TRAN);
        // set + rst both resolve to the same synthesized LOW rail node.
        expect(deviceLine(netlist, 'AU1')).toBe('AU1 ndin nclk dlogic_lo dlogic_lo nq nqb CFD_DFF');
        expect(netlist).toContain('.model CFD_DFF d_dff(');
        // The rail is a DC-0 analog source bridged into the digital domain.
        expect(netlist).toMatch(/vxsyn\d+ dlogic_lo_a 0 DC 0/);
        expect(netlist).toMatch(/axsyn\d+ \[dlogic_lo_a\] \[dlogic_lo\] CFD_ADC/);
    });

    it('does NOT synthesize a LOW rail when set+rst are both wired', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'dff', designator: 'U1', pins: [
                    { pinId: 'd', netId: 'din' }, { pinId: 'clk', netId: 'clk' },
                    { pinId: 'set', netId: 's' }, { pinId: 'rst', netId: 'r' },
                    { pinId: 'q', netId: 'q' }, { pinId: 'qb', netId: 'qb' }] },
            ],
            nets: [{ id: 'din', name: 'D' }, { id: 'clk', name: 'CLK' }, { id: 's', name: 'S' },
                { id: 'r', name: 'R' }, { id: 'q', name: 'Q' }, { id: 'qb', name: 'QB' }],
        };
        const netlist = generateNetlist(c, TRAN);
        expect(deviceLine(netlist, 'AU1')).toBe('AU1 ndin nclk ns nr nq nqb CFD_DFF');
        expect(netlist).not.toContain('dlogic_lo');
    });
});

describe('automatic analog<->digital bridging', () => {
    it('inserts an adc_bridge when an analog source drives a digital sink (analog -> digital)', () => {
        // A PULSE clock (analog) feeding a flip-flop clk pin: net "clk" is analog + 1 digital sink, 0 sources.
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'vclk', type: 'voltage_source', designator: 'V1', value: 'PULSE(0 5 0 1n 1n 50u 100u)', pins: [
                    { pinId: '+', netId: 'clk' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'u1', type: 'dff', designator: 'U1', pins: [
                    { pinId: 'd', netId: 'din' }, { pinId: 'clk', netId: 'clk' },
                    { pinId: 'q', netId: 'q' }, { pinId: 'qb', netId: 'qb' }] },
            ],
            nets: [{ id: 'clk', name: 'CLK' }, { id: 'din', name: 'D' }, { id: 'q', name: 'Q' },
                { id: 'qb', name: 'QB' }, { id: 'gnd', name: 'GND', isGround: true }],
        };
        const nodeMap = nodeMapOf(c);
        const plan = planMixedSignal(c, nodeMap);
        // analog node keeps the net's name; the digital twin is a fresh "_d" node.
        expect(plan.nodeOverride.get('u1:clk')).toBe('nclk_d');
        expect(plan.deviceLines.some((l) => /axsyn\d+ \[nclk\] \[nclk_d\] CFD_ADC/.test(l))).toBe(true);
        // The flip-flop's clk pin is wired to the digital node, the source still drives the analog node.
        const netlist = generateNetlist(c, TRAN);
        expect(deviceLine(netlist, 'AU1')).toContain('nclk_d');
        expect(deviceLine(netlist, 'V1')).toContain(' nclk ');
    });

    it('inserts a dac_bridge when a digital output drives an analog load (digital -> analog)', () => {
        // A gate output feeding a resistor to ground: net "y" is analog + 1 digital source.
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'logic_buffer', designator: 'U1', pins: [
                    { pinId: 'in1', netId: 'a' }, { pinId: 'out', netId: 'y' }] },
                { id: 'rl', type: 'resistor', designator: 'R1', value: '1k', pins: [
                    { pinId: '1', netId: 'y' }, { pinId: '2', netId: 'gnd' }] },
            ],
            nets: [{ id: 'a', name: 'A' }, { id: 'y', name: 'Y' }, { id: 'gnd', name: 'GND', isGround: true }],
        };
        const nodeMap = nodeMapOf(c);
        const plan = planMixedSignal(c, nodeMap);
        expect(plan.nodeOverride.get('u1:out')).toBe('ny_d');
        expect(plan.deviceLines.some((l) => /axsyn\d+ \[ny_d\] \[ny\] CFD_DAC/.test(l))).toBe(true);
        const netlist = generateNetlist(c, TRAN);
        expect(deviceLine(netlist, 'AU1')).toContain('ny_d'); // gate drives the digital node
        expect(deviceLine(netlist, 'R1')).toContain(' ny '); // resistor reads the analog node
    });

    it('bridges a PROBED pure-digital output net to an analog node for observation', () => {
        // Pure-digital gate output (no analog pin on it) still gets a dac bridge so wrdata can sample it.
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'logic_and', designator: 'U1', pins: [
                    { pinId: 'in1', netId: 'a' }, { pinId: 'in2', netId: 'b' }, { pinId: 'out', netId: 'y' }] },
            ],
            nets: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'y', name: 'Y' }],
        };
        const nodeMap = nodeMapOf(c);
        const plan = planMixedSignal(c, nodeMap);
        expect(plan.probeNodeForNet.get('y')).toBe('ny_p');
        expect(plan.deviceLines.some((l) => /axsyn\d+ \[ny\] \[ny_p\] CFD_DAC/.test(l))).toBe(true);
        // The gate keeps driving the raw digital node "ny"; only the probe twin is new.
        expect(plan.nodeOverride.has('u1:out')).toBe(false);
    });
});

describe('analog-only NO-OP guarantee', () => {
    const rc: CircuitJson = {
        version: '1.0',
        components: [
            { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [
                { pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
            { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [
                { pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
            { id: 'c1', type: 'capacitor', designator: 'C1', value: '1u', pins: [
                { pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
        ],
        nets: [{ id: 'in', name: 'IN' }, { id: 'out', name: 'OUT' }, { id: 'gnd', name: 'GND', isGround: true }],
    };

    it('planMixedSignal is inactive (no bridges, no overrides) with zero digital components', () => {
        const plan = planMixedSignal(rc, nodeMapOf(rc));
        expect(plan.active).toBe(false);
        expect(plan.deviceLines).toHaveLength(0);
        expect(plan.modelCards).toHaveLength(0);
        expect(plan.nodeOverride.size).toBe(0);
        expect(plan.probeNodeForNet.size).toBe(0);
        expect(plan.lowRailNode).toBeNull();
    });

    it('an analog-only netlist contains none of the digital/bridge artifacts', () => {
        const netlist = generateNetlist(rc, TRAN);
        for (const token of ['axsyn', 'vxsyn', 'CFD_ADC', 'CFD_DAC', 'dlogic_lo', 'd_and', 'd_dff', 'Digital / bridge']) {
            expect(netlist).not.toContain(token);
        }
    });
});

describe('digital ERC', () => {
    it('flags a gate with too few inputs (DIGITAL_PIN_SHAPE)', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'logic_and', designator: 'U1', pins: [
                    { pinId: 'in1', netId: 'a' }, { pinId: 'out', netId: 'y' }] }, // AND needs >=2 inputs
                { id: 'vd', type: 'voltage_source', designator: 'V1', value: 'PULSE(0 5 0 1n 1n 1u 2u)', pins: [
                    { pinId: '+', netId: 'a' }, { pinId: '-', netId: 'gnd' }] },
            ],
            nets: [{ id: 'a', name: 'A' }, { id: 'y', name: 'Y' }, { id: 'gnd', name: 'GND', isGround: true }],
        };
        expect(runErc(c).issues.some((i) => i.code === ErcCode.DIGITAL_PIN_SHAPE && i.relatedIds.includes('u1'))).toBe(true);
    });

    it('flags a flip-flop missing a required pin (DIGITAL_PIN_SHAPE)', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'dff', designator: 'U1', pins: [
                    { pinId: 'd', netId: 'din' }, { pinId: 'clk', netId: 'clk' }, { pinId: 'q', netId: 'q' }] }, // no qb
            ],
            nets: [{ id: 'din', name: 'D' }, { id: 'clk', name: 'CLK' }, { id: 'q', name: 'Q' }],
        };
        const shape = runErc(c).issues.filter((i) => i.code === ErcCode.DIGITAL_PIN_SHAPE && i.relatedIds.includes('u1'));
        expect(shape.length).toBeGreaterThan(0);
        expect(shape.some((i) => /qb/.test(i.message))).toBe(true);
    });

    it('flags a digital input net with no driver (FLOATING_DIGITAL_INPUT)', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                // "fin" is touched only by the inverter input — undriven => unknown 'U'.
                { id: 'u1', type: 'logic_not', designator: 'U1', pins: [
                    { pinId: 'in1', netId: 'fin' }, { pinId: 'out', netId: 'y' }] },
            ],
            nets: [{ id: 'fin', name: 'FIN' }, { id: 'y', name: 'Y' }],
        };
        expect(runErc(c).issues.some((i) => i.code === ErcCode.FLOATING_DIGITAL_INPUT && i.relatedIds.includes('fin'))).toBe(true);
    });

    it('does NOT flag a grounded digital input as floating', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'logic_and', designator: 'U1', pins: [
                    { pinId: 'in1', netId: 'a' }, { pinId: 'in2', netId: 'gnd' }, { pinId: 'out', netId: 'y' }] },
                { id: 'vd', type: 'voltage_source', designator: 'V1', value: 'PULSE(0 5 0 1n 1n 1u 2u)', pins: [
                    { pinId: '+', netId: 'a' }, { pinId: '-', netId: 'gnd' }] },
            ],
            nets: [{ id: 'a', name: 'A' }, { id: 'y', name: 'Y' }, { id: 'gnd', name: 'GND', isGround: true }],
        };
        expect(runErc(c).issues.some((i) => i.code === ErcCode.FLOATING_DIGITAL_INPUT)).toBe(false);
    });

    it('flags two digital outputs on one net (DIGITAL_BUS_CONTENTION)', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'logic_buffer', designator: 'U1', pins: [
                    { pinId: 'in1', netId: 'a' }, { pinId: 'out', netId: 'bus' }] },
                { id: 'u2', type: 'logic_buffer', designator: 'U2', pins: [
                    { pinId: 'in1', netId: 'b' }, { pinId: 'out', netId: 'bus' }] },
            ],
            nets: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'bus', name: 'BUS' }],
        };
        expect(runErc(c).issues.some((i) => i.code === ErcCode.DIGITAL_BUS_CONTENTION && i.relatedIds.includes('bus'))).toBe(true);
    });

    it('flags a digital output fighting an analog source on one net (MIXED_DRIVER_CONFLICT)', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'logic_buffer', designator: 'U1', pins: [
                    { pinId: 'in1', netId: 'a' }, { pinId: 'out', netId: 'm' }] },
                { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [
                    { pinId: '+', netId: 'm' }, { pinId: '-', netId: 'gnd' }] },
            ],
            nets: [{ id: 'a', name: 'A' }, { id: 'm', name: 'M' }, { id: 'gnd', name: 'GND', isGround: true }],
        };
        expect(runErc(c).issues.some((i) => i.code === ErcCode.MIXED_DRIVER_CONFLICT && i.relatedIds.includes('m'))).toBe(true);
    });

    it('passes a well-formed mixed-signal circuit (no digital ERC errors)', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'vclk', type: 'voltage_source', designator: 'V1', value: 'PULSE(0 5 0 1n 1n 50u 100u)', pins: [
                    { pinId: '+', netId: 'clk' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'vd', type: 'voltage_source', designator: 'V2', value: 'DC 5', pins: [
                    { pinId: '+', netId: 'din' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'u1', type: 'dff', designator: 'U1', pins: [
                    { pinId: 'd', netId: 'din' }, { pinId: 'clk', netId: 'clk' },
                    { pinId: 'q', netId: 'q' }, { pinId: 'qb', netId: 'qb' }] },
            ],
            nets: [{ id: 'clk', name: 'CLK' }, { id: 'din', name: 'D' }, { id: 'q', name: 'Q' },
                { id: 'qb', name: 'QB' }, { id: 'gnd', name: 'GND', isGround: true }],
        };
        const digitalCodes = new Set([
            ErcCode.DIGITAL_PIN_SHAPE, ErcCode.FLOATING_DIGITAL_INPUT,
            ErcCode.DIGITAL_BUS_CONTENTION, ErcCode.MIXED_DRIVER_CONFLICT,
        ]);
        expect(runErc(c).issues.filter((i) => digitalCodes.has(i.code))).toHaveLength(0);
    });
});

/** The `wrdata output.csv ...` probe line from a full netlist. */
function wrdataLine(netlist: string): string {
    return netlist.split('\n').find((l) => l.trim().startsWith('wrdata')) ?? '';
}

describe('digital review fixes', () => {
    // #1/#2 — a CALLER-supplied probe on a pure-digital source net must redirect to the analog "_p" twin
    // (the version-sim path always passes explicit probes), exactly like the default-probe path does.
    describe('caller-supplied probe on a pure-digital net redirects to the analog _p twin', () => {
        const andOnY: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'logic_and', designator: 'U1', pins: [
                    { pinId: 'in1', netId: 'a' }, { pinId: 'in2', netId: 'b' }, { pinId: 'out', netId: 'q' }] },
            ],
            nets: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'q', name: 'Q' }],
        };
        it.each([['net id', 'v(q)'], ['net name', 'v(Q)'], ['sanitized node', 'v(nq)']])(
            'rewrites %s probe %s -> v(nq_p)',
            (_label, probe) => {
                const netlist = generateNetlist(andOnY, TRAN, { probes: [probe] });
                expect(wrdataLine(netlist)).toContain('v(nq_p)');
                expect(wrdataLine(netlist)).not.toMatch(/v\(nq\)/); // never the raw digital event node
            },
        );
        it('default probes still resolve the same twin (unchanged behavior)', () => {
            expect(wrdataLine(generateNetlist(andOnY, TRAN))).toContain('v(nq_p)');
        });
    });

    // #3 — an over-connected not/buffer emits a valid SCALAR line (first input only) AND is flagged by ERC.
    it('a not gate with >1 input emits a scalar line (first input) and ERC flags DIGITAL_PIN_SHAPE', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'logic_not', designator: 'U1', pins: [
                    { pinId: 'in1', netId: 'a' }, { pinId: 'in2', netId: 'b' }, { pinId: 'out', netId: 'y' }] },
            ],
            nets: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'y', name: 'Y' }],
        };
        // Emission must NOT spill both inputs into the line (that would shift out/model columns).
        expect(deviceLine(generateNetlist(c, TRAN), 'AU1')).toBe('AU1 na ny CFD_NOT');
        expect(runErc(c).issues.some((i) => i.code === ErcCode.DIGITAL_PIN_SHAPE && i.relatedIds.includes('u1'))).toBe(true);
    });

    // #8 — a duplicate input pinId would silently collapse to one net; ERC must flag it.
    it('flags a gate with a duplicate input pinId (DIGITAL_PIN_SHAPE)', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'logic_and', designator: 'U1', pins: [
                    { pinId: 'in1', netId: 'a' }, { pinId: 'in1', netId: 'b' }, { pinId: 'out', netId: 'y' }] },
            ],
            nets: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'y', name: 'Y' }],
        };
        const shape = runErc(c).issues.filter((i) => i.code === ErcCode.DIGITAL_PIN_SHAPE && i.relatedIds.includes('u1'));
        expect(shape.length).toBeGreaterThan(0);
        expect(shape.some((i) => /duplicate/i.test(i.message))).toBe(true);
    });

    // #4/#5 — a controlled/behavioral analog driver (vcvs/vccs/bsource) contending with a digital output.
    it.each(['vcvs', 'vccs', 'bsource'])('flags a %s contending with a digital output (MIXED_DRIVER_CONFLICT)', (kind) => {
        const driver =
            kind === 'bsource'
                ? { id: 's1', type: kind, designator: 'B1', value: 'V=5', pins: [{ pinId: '+', netId: 'm' }, { pinId: '-', netId: 'gnd' }] }
                : { id: 's1', type: kind, designator: kind === 'vcvs' ? 'E1' : 'G1', value: '2', pins: [
                    { pinId: '+', netId: 'm' }, { pinId: '-', netId: 'gnd' }, { pinId: 'c+', netId: 'a' }, { pinId: 'c-', netId: 'gnd' }] };
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'logic_buffer', designator: 'U1', pins: [{ pinId: 'in1', netId: 'a' }, { pinId: 'out', netId: 'm' }] },
                driver as CircuitJson['components'][number],
            ],
            nets: [{ id: 'a', name: 'A' }, { id: 'm', name: 'M' }, { id: 'gnd', name: 'GND', isGround: true }],
        };
        expect(runErc(c).issues.some((i) => i.code === ErcCode.MIXED_DRIVER_CONFLICT && i.relatedIds.includes('m'))).toBe(true);
    });

    // #9 — a driven digital output observed on its own net is not a dead end.
    it('does NOT flag a terminal digital output as NET_HAS_SINGLE_PIN', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'vclk', type: 'voltage_source', designator: 'V1', value: 'PULSE(0 5 0 1n 1n 1u 2u)', pins: [
                    { pinId: '+', netId: 'clk' }, { pinId: '-', netId: 'gnd' }] },
                // qb fed back to d (toggle); q observed on its own terminal net.
                { id: 'u1', type: 'dff', designator: 'U1', pins: [
                    { pinId: 'd', netId: 'qb' }, { pinId: 'clk', netId: 'clk' },
                    { pinId: 'q', netId: 'qout' }, { pinId: 'qb', netId: 'qb' }] },
            ],
            nets: [{ id: 'clk', name: 'CLK' }, { id: 'qb', name: 'QB' }, { id: 'qout', name: 'QOUT' }, { id: 'gnd', name: 'GND', isGround: true }],
        };
        const single = runErc(c).issues.filter((i) => i.code === ErcCode.NET_HAS_SINGLE_PIN && i.relatedIds.includes('qout'));
        expect(single).toHaveLength(0);
    });

    // #10 — a gate pin on an undeclared net must hard-throw (mirror the analog path), not silently vanish.
    it('throws when a digital pin references an undeclared net', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'logic_and', designator: 'U1', pins: [
                    { pinId: 'in1', netId: 'a' }, { pinId: 'in2', netId: 'GHOST' }, { pinId: 'out', netId: 'y' }] },
            ],
            nets: [{ id: 'a', name: 'A' }, { id: 'y', name: 'Y' }], // no 'GHOST'
        };
        expect(() => generateNetlist(c, TRAN)).toThrow(/Net not found: GHOST/);
    });

    // #6 — a synthesized model name can no longer collide with a caller-supplied model (it is namespaced).
    it('does not collide with a caller model that uses an old generic bridge name', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'vclk', type: 'voltage_source', designator: 'V1', value: 'PULSE(0 5 0 1n 1n 1u 2u)', pins: [
                    { pinId: '+', netId: 'clk' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'u1', type: 'dff', designator: 'U1', pins: [
                    { pinId: 'd', netId: 'din' }, { pinId: 'clk', netId: 'clk' },
                    { pinId: 'q', netId: 'q' }, { pinId: 'qb', netId: 'qb' }] },
            ],
            nets: [{ id: 'clk', name: 'CLK' }, { id: 'din', name: 'D' }, { id: 'q', name: 'Q' },
                { id: 'qb', name: 'QB' }, { id: 'gnd', name: 'GND', isGround: true }],
            models: [{ name: 'ADCBRIDGE', device: 'digital', body: '.model ADCBRIDGE adc_bridge(in_low=1 in_high=4)' }],
        };
        expect(() => generateNetlist(c, TRAN)).not.toThrow();
    });

    // #7 — a synthesized device name must not abort the run when a user designator occupies it.
    it('renames a synthesized bridge device that collides with a user designator (no duplicate-device abort)', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                // 'axsyn0' is exactly the name planMixedSignal would use for its first synthesized bridge.
                { id: 'u1', type: 'dff', designator: 'axsyn0', pins: [
                    { pinId: 'd', netId: 'din' }, { pinId: 'clk', netId: 'clk' },
                    { pinId: 'q', netId: 'q' }, { pinId: 'qb', netId: 'qb' }] },
            ],
            nets: [{ id: 'din', name: 'D' }, { id: 'clk', name: 'CLK' }, { id: 'q', name: 'Q' }, { id: 'qb', name: 'QB' }],
        };
        let netlist = '';
        expect(() => { netlist = generateNetlist(c, TRAN); }).not.toThrow();
        expect(deviceLine(netlist, 'axsyn0')).toContain('CFD_DFF'); // the real dff keeps the name
        expect(netlist).toContain('axsyn0_1'); // the colliding synth bridge was renamed
    });
});
