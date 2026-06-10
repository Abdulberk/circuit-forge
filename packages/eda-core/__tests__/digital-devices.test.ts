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

    describe('bsource expression refs on a pure-digital net redirect to the analog _p twin', () => {
        // A behavioral expression v(<digital net>) must read the bridged ANALOG copy: the sanitized name
        // belongs to the XSPICE event node, which no analog element pins — referencing it from a B-source
        // leaves that node singular in the analog matrix (gmin-degraded garbage + "singular matrix" warnings;
        // found by the pairwise sweep on gate-out -> bsource-expr). Probes already redirect; expressions must too.
        const gateFeedsBsource: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'vd', type: 'voltage_source', designator: 'VD1', value: 'DC 5', pins: [
                    { pinId: '+', netId: 'vdd' }, { pinId: '-', netId: '0' }] },
                { id: 'va', type: 'voltage_source', designator: 'VA1', value: 'PULSE(0 5 0 10n 10n 5u 10u)', pins: [
                    { pinId: '+', netId: 'a' }, { pinId: '-', netId: '0' }] },
                { id: 'u1', type: 'logic_not', designator: 'U1', pins: [
                    { pinId: 'in1', netId: 'a' }, { pinId: 'out', netId: 'q' }] },
                { id: 'b1', type: 'bsource', designator: 'B1', value: 'V=v(q)*0.5+1', pins: [
                    { pinId: '+', netId: 'bout' }, { pinId: '-', netId: '0' }] },
                { id: 'rl', type: 'resistor', designator: 'RL1', value: '1k', pins: [
                    { pinId: '1', netId: 'bout' }, { pinId: '2', netId: '0' }] },
            ],
            nets: [
                { id: 'vdd', name: 'vdd' }, { id: 'a', name: 'a' }, { id: 'q', name: 'q' },
                { id: 'bout', name: 'bout' }, { id: '0', name: '0', isGround: true },
            ],
        };
        it('rewrites v(q) in the B-source value to the analog twin v(nq_p), never the raw event node', () => {
            const netlist = generateNetlist(gateFeedsBsource, TRAN);
            const bLine = netlist.split('\n').find((l) => l.startsWith('B1 '))!;
            expect(bLine).toContain('V(nq_p)'); // expression reads the DAC-bridged analog copy
            expect(bLine).not.toMatch(/V\(nq\)/); // the raw digital node would be singular in the analog matrix
        });
        it('an expression ref to a plain ANALOG net is untouched (no twin, normal sanitized node)', () => {
            const analog: CircuitJson = {
                version: '1.0',
                components: [
                    { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'SIN(0 2 1k)', pins: [
                        { pinId: '+', netId: 'sig' }, { pinId: '-', netId: '0' }] },
                    { id: 'b1', type: 'bsource', designator: 'B1', value: 'V=v(sig)*2', pins: [
                        { pinId: '+', netId: 'bout' }, { pinId: '-', netId: '0' }] },
                    { id: 'rl', type: 'resistor', designator: 'RL1', value: '1k', pins: [
                        { pinId: '1', netId: 'bout' }, { pinId: '2', netId: '0' }] },
                ],
                nets: [{ id: 'sig', name: 'sig' }, { id: 'bout', name: 'bout' }, { id: '0', name: '0', isGround: true }],
            };
            const bLine = generateNetlist(analog, TRAN).split('\n').find((l) => l.startsWith('B1 '))!;
            expect(bLine).toContain('V(nsig)');
            expect(bLine).not.toContain('_p');
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

/** The `.model <name> ...` card line from a netlist. */
function modelCard(netlist: string, name: string): string {
    return netlist.split('\n').find((l) => l.trim().startsWith(`.model ${name} `)) ?? '';
}

describe('logic voltage (auto-detect + override)', () => {
    // A mixed inverter whose clock/input swings 0..3.3 V — the bridges must scale to 3.3 V, not 5 V.
    const mixed3v3: CircuitJson = {
        version: '1.0',
        components: [
            { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'PULSE(0 3.3 0 10n 10n 2u 4u)', pins: [
                { pinId: '+', netId: 'a' }, { pinId: '-', netId: 'gnd' }] },
            { id: 'u1', type: 'logic_not', designator: 'U1', pins: [{ pinId: 'in1', netId: 'a' }, { pinId: 'out', netId: 'y' }] },
            { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'y' }, { pinId: '2', netId: 'gnd' }] },
        ],
        nets: [{ id: 'a', name: 'A' }, { id: 'y', name: 'Y' }, { id: 'gnd', name: 'GND', isGround: true }],
    };

    it('auto-detects the logic rail from the digital stimulus (3.3 V → 0/3.3 V swing, 30%/70% thresholds)', () => {
        const netlist = generateNetlist(mixed3v3, TRAN);
        expect(modelCard(netlist, 'CFD_DAC')).toBe('.model CFD_DAC dac_bridge(out_low=0 out_high=3.3)');
        expect(modelCard(netlist, 'CFD_ADC')).toBe('.model CFD_ADC adc_bridge(in_low=0.99 in_high=2.31)');
    });

    it('an explicit logicVoltage override wins over auto-detection', () => {
        const netlist = generateNetlist(mixed3v3, TRAN, { logicVoltage: 1.8 });
        expect(modelCard(netlist, 'CFD_DAC')).toBe('.model CFD_DAC dac_bridge(out_low=0 out_high=1.8)');
        expect(modelCard(netlist, 'CFD_ADC')).toBe('.model CFD_ADC adc_bridge(in_low=0.54 in_high=1.26)');
    });

    it('defaults to 5 V when no analog source drives the digital domain', () => {
        // Pure-digital AND (no analog stimulus on a digital net) → the rail is abstract → default 5 V.
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'logic_and', designator: 'U1', pins: [
                    { pinId: 'in1', netId: 'a' }, { pinId: 'in2', netId: 'b' }, { pinId: 'out', netId: 'y' }] },
            ],
            nets: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'y', name: 'Y' }],
        };
        const netlist = generateNetlist(c, TRAN); // probed digital output → CFD_DAC twin emitted
        expect(modelCard(netlist, 'CFD_DAC')).toBe('.model CFD_DAC dac_bridge(out_low=0 out_high=5)');
    });

    it('picks the highest digital-domain supply when a 5 V clock and a 3.3 V data line coexist', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'vclk', type: 'voltage_source', designator: 'V1', value: 'PULSE(0 5 0 1n 1n 50u 100u)', pins: [
                    { pinId: '+', netId: 'clk' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'vd', type: 'voltage_source', designator: 'V2', value: 'DC 3.3', pins: [
                    { pinId: '+', netId: 'din' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'u1', type: 'dff', designator: 'U1', pins: [
                    { pinId: 'd', netId: 'din' }, { pinId: 'clk', netId: 'clk' },
                    { pinId: 'q', netId: 'q' }, { pinId: 'qb', netId: 'qb' }] },
            ],
            nets: [{ id: 'clk', name: 'CLK' }, { id: 'din', name: 'D' }, { id: 'q', name: 'Q' },
                { id: 'qb', name: 'QB' }, { id: 'gnd', name: 'GND', isGround: true }],
        };
        expect(modelCard(generateNetlist(c, TRAN), 'CFD_DAC')).toBe('.model CFD_DAC dac_bridge(out_low=0 out_high=5)');
    });

    it('ignores an analog-only supply rail that does not touch the digital domain', () => {
        // A 12 V rail powering only an analog load must NOT be mistaken for the 3.3 V logic level.
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'v12', type: 'voltage_source', designator: 'V1', value: 'DC 12', pins: [
                    { pinId: '+', netId: 'hv' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'rload', type: 'resistor', designator: 'R1', value: '1k', pins: [
                    { pinId: '1', netId: 'hv' }, { pinId: '2', netId: 'gnd' }] },
                { id: 'vclk', type: 'voltage_source', designator: 'V2', value: 'PULSE(0 3.3 0 1n 1n 1u 2u)', pins: [
                    { pinId: '+', netId: 'a' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'u1', type: 'logic_buffer', designator: 'U1', pins: [{ pinId: 'in1', netId: 'a' }, { pinId: 'out', netId: 'y' }] },
            ],
            nets: [{ id: 'hv', name: 'HV' }, { id: 'a', name: 'A' }, { id: 'y', name: 'Y' }, { id: 'gnd', name: 'GND', isGround: true }],
        };
        // 3.3 V (the source driving the digital input), not 12 V (the analog-only rail).
        expect(modelCard(generateNetlist(c, TRAN), 'CFD_DAC')).toBe('.model CFD_DAC dac_bridge(out_low=0 out_high=3.3)');
    });
});

describe('parametric digital timing (per-component, properties-driven)', () => {
    const gate = (id: string, designator: string, properties?: Record<string, unknown>): CircuitJson['components'][number] => ({
        id, type: 'logic_and', designator, properties,
        pins: [{ pinId: 'in1', netId: `${id}a` }, { pinId: 'in2', netId: `${id}b` }, { pinId: 'out', netId: `${id}y` }],
    });
    const wrap = (...comps: CircuitJson['components']): CircuitJson => ({
        version: '1.0',
        components: comps,
        nets: comps.flatMap((c) => c.pins.map((p) => ({ id: p.netId, name: p.netId.toUpperCase() }))),
    });

    it('a default gate keeps the clean base model name + the canonical card', () => {
        const netlist = generateNetlist(wrap(gate('u1', 'U1')), TRAN);
        expect(deviceLine(netlist, 'AU1')?.endsWith(' CFD_AND')).toBe(true);
        expect(modelCard(netlist, 'CFD_AND')).toBe('.model CFD_AND d_and(rise_delay=1n fall_delay=1n input_load=0.5p)');
    });

    it('a gate with custom delays gets its OWN model that the device line references', () => {
        const netlist = generateNetlist(wrap(gate('u1', 'U1', { riseDelay: '4n', fallDelay: '6n' })), TRAN);
        const dev = deviceLine(netlist, 'AU1')!;
        const name = dev.split(/\s+/).pop()!; // last token = model name
        expect(name).toBe('CFD_AND_1'); // not the base name
        expect(modelCard(netlist, name)).toBe('.model CFD_AND_1 d_and(rise_delay=4n fall_delay=6n input_load=0.5p)');
    });

    it('two gates with IDENTICAL custom timing share one model; different timing → distinct models', () => {
        const netlist = generateNetlist(
            wrap(
                gate('u1', 'U1', { riseDelay: '2n' }),
                gate('u2', 'U2', { riseDelay: '2n' }), // same as U1 → shares
                gate('u3', 'U3', { riseDelay: '9n' }), // different → its own
                gate('u4', 'U4'), // default → base name
            ),
            TRAN,
        );
        const nameOf = (inst: string) => deviceLine(netlist, inst)!.split(/\s+/).pop();
        expect(nameOf('AU1')).toBe(nameOf('AU2')); // shared
        expect(nameOf('AU1')).not.toBe(nameOf('AU3')); // distinct timing
        expect(nameOf('AU4')).toBe('CFD_AND'); // default keeps base
        // Exactly two custom variants emitted (U1/U2 share one, U3 the other) + the base.
        expect(netlist.match(/\.model CFD_AND(_\d+)? d_and\(/g)?.length).toBe(3);
    });

    it('a flip-flop with ic=1 starts HIGH via its own model; default dff stays byte-identical', () => {
        const dff = (id: string, designator: string, properties?: Record<string, unknown>): CircuitJson['components'][number] => ({
            id, type: 'dff', designator, properties,
            pins: [{ pinId: 'd', netId: `${id}d` }, { pinId: 'clk', netId: `${id}c` },
                { pinId: 'q', netId: `${id}q` }, { pinId: 'qb', netId: `${id}qb` }],
        });
        const netlist = generateNetlist(wrap(dff('u1', 'U1', { ic: '1' }), dff('u2', 'U2')), TRAN);
        const u1model = deviceLine(netlist, 'AU1')!.split(/\s+/).pop()!;
        expect(modelCard(netlist, u1model)).toContain(' ic=1)');
        expect(deviceLine(netlist, 'AU2')!.split(/\s+/).pop()).toBe('CFD_DFF');
        expect(modelCard(netlist, 'CFD_DFF')).toBe('.model CFD_DFF d_dff(clk_delay=1n set_delay=1n reset_delay=1n rise_delay=1n fall_delay=1n)');
    });

    it('rejects a malformed/injection delay and falls back to the default (stays the base model)', () => {
        const netlist = generateNetlist(wrap(gate('u1', 'U1', { riseDelay: '1n) evil .end' }), gate('u2', 'U2', { fallDelay: 'abc' })), TRAN);
        // Both bad values were rejected → both resolve to the all-default config → the clean base model.
        expect(deviceLine(netlist, 'AU1')!.split(/\s+/).pop()).toBe('CFD_AND');
        expect(deviceLine(netlist, 'AU2')!.split(/\s+/).pop()).toBe('CFD_AND');
        expect(netlist).not.toContain('evil'); // nothing injected into the netlist
        expect(modelCard(netlist, 'CFD_AND')).toBe('.model CFD_AND d_and(rise_delay=1n fall_delay=1n input_load=0.5p)');
    });
});

describe('subsystem audit hardening fixes', () => {
    const src = (id: string, des: string, value: string, net: string): CircuitJson['components'][number] =>
        ({ id, type: 'voltage_source', designator: des, value, pins: [{ pinId: '+', netId: net }, { pinId: '-', netId: 'gnd' }] });
    const res = (id: string, des: string, a: string, b: string): CircuitJson['components'][number] =>
        ({ id, type: 'resistor', designator: des, value: '1k', pins: [{ pinId: '1', netId: a }, { pinId: '2', netId: b }] });
    const netsOf = (...ids: string[]): CircuitJson['nets'] =>
        ids.map((id) => (id === 'gnd' ? { id: 'gnd', name: 'GND', isGround: true } : { id, name: id.toUpperCase() }));

    // #1 — mixed 3.3 V + 5 V digital domains: bridges calibrate to one rail, so warn.
    it('warns MIXED_LOGIC_LEVELS when 3.3 V and 5 V sources drive the digital domain', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                src('v1', 'V1', 'DC 5', 'ck5'), src('v2', 'V2', 'DC 3.3', 'd33'),
                { id: 'u1', type: 'logic_and', designator: 'U1', pins: [
                    { pinId: 'in1', netId: 'ck5' }, { pinId: 'in2', netId: 'd33' }, { pinId: 'out', netId: 'y' }] },
                res('r1', 'R1', 'y', 'gnd'),
            ],
            nets: netsOf('ck5', 'd33', 'y', 'gnd'),
        };
        expect(runErc(c).issues.some((i) => i.code === ErcCode.MIXED_LOGIC_LEVELS)).toBe(true);
    });

    // #8 — a negative-rail digital stimulus can't cross the positive adc thresholds: warn.
    it('warns MIXED_LOGIC_LEVELS for a negative-rail (PULSE 0 -5) digital stimulus', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                src('v1', 'V1', 'PULSE(0 -5 0 1n 1n 1u 2u)', 'a'),
                { id: 'u1', type: 'logic_buffer', designator: 'U1', pins: [{ pinId: 'in1', netId: 'a' }, { pinId: 'out', netId: 'y' }] },
                res('r1', 'R1', 'y', 'gnd'),
            ],
            nets: netsOf('a', 'y', 'gnd'),
        };
        expect(runErc(c).issues.some((i) => i.code === ErcCode.MIXED_LOGIC_LEVELS && /negative/i.test(i.message))).toBe(true);
    });

    // #8b — a legitimate logic-LOW input (DC 0, reaches 0 but never goes negative) must NOT warn.
    it('does NOT warn MIXED_LOGIC_LEVELS for a DC-0 logic-low input', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                src('v1', 'V1', 'DC 5', 'a'), src('v0', 'V2', 'DC 0', 'b'), // a=1, b=0 — both single-rail (5V family)
                { id: 'u1', type: 'logic_and', designator: 'U1', pins: [{ pinId: 'in1', netId: 'a' }, { pinId: 'in2', netId: 'b' }, { pinId: 'out', netId: 'y' }] },
                res('r1', 'R1', 'y', 'gnd'),
            ],
            nets: netsOf('a', 'b', 'y', 'gnd'),
        };
        expect(runErc(c).issues.some((i) => i.code === ErcCode.MIXED_LOGIC_LEVELS)).toBe(false);
    });

    // #2a — two real nets whose nodes differ only by case would silently MERGE in ngspice: fail loud.
    it('throws on two nets whose SPICE nodes collide case-insensitively', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [res('r1', 'R1', 'sig', 'gnd'), res('r2', 'R2', 'SIG', 'gnd'), src('v1', 'V1', 'DC 5', 'sig')],
            nets: netsOf('sig', 'SIG', 'gnd'),
        };
        expect(() => generateNetlist(c, TRAN)).toThrow(/node-name collision/i);
    });

    // #2b — a synthesized digital twin node must not case-collide with a real net node (uniqueNode renames).
    it('renames a synthesized digital node that would case-collide with a real net node', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'logic_buffer', designator: 'U1', pins: [{ pinId: 'in1', netId: 'a' }, { pinId: 'out', netId: 'y' }] },
                res('r1', 'R1', 'y', 'gnd'), // makes net y mixed → digital twin node "ny_d"
                src('v2', 'V2', 'DC 3', 'Y_d'), res('r2', 'R2', 'Y_d', 'gnd'), // real net Y_d → node "nY_d"
            ],
            nets: netsOf('a', 'y', 'Y_d', 'gnd'),
        };
        const netlist = generateNetlist(c, TRAN);
        expect(netlist).toContain('nY_d'); // the real net's node, intact
        expect(netlist).toContain('ny_d_1'); // the twin was renamed to avoid the case-collision
        expect(deviceLine(netlist, 'AU1')).toContain('ny_d_1');
    });

    // #3 — a vcvs that only SENSES a logic output (c+ on the digital net) is NOT a driver conflict.
    it('does NOT flag MIXED_DRIVER_CONFLICT when a vcvs only senses a logic output', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                src('v1', 'V1', 'PULSE(0 5 0 1n 1n 1u 2u)', 'a'),
                { id: 'u1', type: 'logic_buffer', designator: 'U1', pins: [{ pinId: 'in1', netId: 'a' }, { pinId: 'out', netId: 'sig' }] },
                { id: 'e1', type: 'vcvs', designator: 'E1', value: '2', pins: [
                    { pinId: '+', netId: 'outp' }, { pinId: '-', netId: 'gnd' }, { pinId: 'c+', netId: 'sig' }, { pinId: 'c-', netId: 'gnd' }] },
                res('r1', 'R1', 'outp', 'gnd'),
            ],
            nets: netsOf('a', 'sig', 'outp', 'gnd'),
        };
        expect(runErc(c).issues.some((i) => i.code === ErcCode.MIXED_DRIVER_CONFLICT)).toBe(false);
    });

    // #4 — a bsource V=3.3 driving the digital domain sets the rail (was ignored → wrongly 5 V).
    it('auto-detects the logic rail from a bsource V=3.3 driving the digital domain', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'b1', type: 'bsource', designator: 'B1', value: 'V=3.3', pins: [{ pinId: '+', netId: 'a' }, { pinId: '-', netId: 'gnd' }] },
                { id: 'u1', type: 'logic_buffer', designator: 'U1', pins: [{ pinId: 'in1', netId: 'a' }, { pinId: 'out', netId: 'y' }] },
                res('r1', 'R1', 'y', 'gnd'),
            ],
            nets: netsOf('a', 'y', 'gnd'),
        };
        expect(modelCard(generateNetlist(c, TRAN), 'CFD_DAC')).toBe('.model CFD_DAC dac_bridge(out_low=0 out_high=3.3)');
    });

    // #7 — EXP() stimulus peak sets the rail (was mis-read as the 0 V initial value).
    it('auto-detects the logic rail from an EXP() stimulus peak', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                src('v1', 'V1', 'EXP(0 3.3 1n 2n 3n 4n)', 'a'),
                { id: 'u1', type: 'logic_buffer', designator: 'U1', pins: [{ pinId: 'in1', netId: 'a' }, { pinId: 'out', netId: 'y' }] },
                res('r1', 'R1', 'y', 'gnd'),
            ],
            nets: netsOf('a', 'y', 'gnd'),
        };
        expect(modelCard(generateNetlist(c, TRAN), 'CFD_DAC')).toBe('.model CFD_DAC dac_bridge(out_low=0 out_high=3.3)');
    });

    // #5 — an i() current probe on a digital a-device is dropped (it would abort the whole wrdata line).
    it('drops an i() current probe on a digital device but keeps sibling v() probes', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                src('v1', 'V1', 'PULSE(0 5 0 1n 1n 1u 2u)', 'a'), src('v2', 'V2', 'PULSE(0 5 0 1n 1n 1u 2u)', 'b'),
                { id: 'u1', type: 'logic_and', designator: 'U1', pins: [
                    { pinId: 'in1', netId: 'a' }, { pinId: 'in2', netId: 'b' }, { pinId: 'out', netId: 'q' }] },
            ],
            nets: netsOf('a', 'b', 'q', 'gnd'),
        };
        const netlist = generateNetlist(c, TRAN, { probes: ['i(U1)', 'v(q)'] });
        expect(wrdataLine(netlist)).not.toMatch(/i\s*\(/i); // the meaningless a-device current probe is gone
        expect(wrdataLine(netlist)).toContain('v(nq_p)'); // the sibling probe survived (redirected to the twin)
    });

    // #6a — a gate pin that is neither in* nor out is silently dropped at emission: flag it.
    it('flags a gate pin that is neither in* nor out (DIGITAL_PIN_SHAPE)', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                src('v1', 'V1', 'DC 5', 'a'), src('v2', 'V2', 'DC 5', 'b'), src('v3', 'V3', 'DC 5', 'cc'),
                { id: 'u1', type: 'logic_and', designator: 'U1', pins: [
                    { pinId: 'in1', netId: 'a' }, { pinId: 'in2', netId: 'b' }, { pinId: 'en', netId: 'cc' }, { pinId: 'out', netId: 'y' }] },
                res('r1', 'R1', 'y', 'gnd'),
            ],
            nets: netsOf('a', 'b', 'cc', 'y', 'gnd'),
        };
        expect(runErc(c).issues.some((i) => i.code === ErcCode.DIGITAL_PIN_SHAPE && i.relatedIds.includes('u1') && /unexpected/i.test(i.message))).toBe(true);
    });

    // #6b — a dff with a duplicate pin id silently drops a connection: flag it.
    it('flags a dff with a duplicate pin id (DIGITAL_PIN_SHAPE)', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'u1', type: 'dff', designator: 'U1', pins: [
                    { pinId: 'd', netId: 'din' }, { pinId: 'clk', netId: 'clk' },
                    { pinId: 'q', netId: 'q1' }, { pinId: 'q', netId: 'q2' }, { pinId: 'qb', netId: 'qb' }] },
            ],
            nets: netsOf('din', 'clk', 'q1', 'q2', 'qb'),
        };
        expect(runErc(c).issues.some((i) => i.code === ErcCode.DIGITAL_PIN_SHAPE && /duplicate/i.test(i.message))).toBe(true);
    });
});
