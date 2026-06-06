/**
 * Netlist Generator Tests
 */
import { generateNetlist, getNodeNames, validateNetlist } from '../src/netlist/generator';
import type { NetlistOptions } from '../src/netlist/generator';
import type { CircuitJson, Component, Net } from '../src/types/circuit';
import { isSimulatable } from '../src/types/circuit';
import type { TranAnalysis, AcAnalysis, DcAnalysis, OpAnalysis } from '../src/types/analysis';

// Helper to create a component
function createComponent(
    id: string,
    type: Component['type'],
    designator: string,
    value: string | undefined,
    pins: Array<{ pinId: string; netId: string }>,
): Component {
    return { id, type, designator, value, pins };
}

// Helper to create a net
function createNet(id: string, name: string, isGround = false): Net {
    return { id, name, isGround };
}

describe('NetlistGenerator', () => {
    describe('generateNetlist', () => {
        it('should generate a basic RC circuit netlist', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'vcc' },
                        { pinId: '2', netId: 'out' },
                    ]),
                    createComponent('C1', 'capacitor', 'C1', '100n', [
                        { pinId: '1', netId: 'out' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [
                    createNet('vcc', 'vcc'),
                    createNet('out', 'out'),
                    createNet('0', '0', true),
                ],
            };

            const analysis: TranAnalysis = {
                type: 'tran',
                stopTime: '10m',
            };

            const netlist = generateNetlist(circuit, analysis);

            expect(netlist).toContain('V1');
            expect(netlist).toContain('R1');
            expect(netlist).toContain('C1');
            expect(netlist).toContain('.tran');
            expect(netlist).toContain('.end');
        });

        it('should include title in netlist', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                ],
                nets: [
                    createNet('vcc', 'vcc'),
                    createNet('0', '0', true),
                ],
            };

            const analysis: TranAnalysis = { type: 'tran', stopTime: '1m' };
            const options: NetlistOptions = { title: 'My Test Circuit' };

            const netlist = generateNetlist(circuit, analysis, options);

            expect(netlist).toContain('My Test Circuit');
        });

        it('should add default diode model when needed', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('D1', 'diode', 'D1', undefined, [
                        { pinId: 'anode', netId: 'vcc' },
                        { pinId: 'cathode', netId: '0' },
                    ]),
                ],
                nets: [
                    createNet('vcc', 'vcc'),
                    createNet('0', '0', true),
                ],
            };

            const analysis: TranAnalysis = { type: 'tran', stopTime: '1m' };

            const netlist = generateNetlist(circuit, analysis);

            expect(netlist).toContain('.model DDEFAULT');
            expect(netlist).toContain('D1');
        });

        it('should include custom probes', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                ],
                nets: [
                    createNet('vcc', 'vcc'),
                    createNet('0', '0', true),
                ],
            };

            const analysis: TranAnalysis = { type: 'tran', stopTime: '1m' };
            const options: NetlistOptions = { probes: ['v(vcc)', 'i(V1)'] };

            const netlist = generateNetlist(circuit, analysis, options);

            // "vcc" is a reserved word, so its node is sanitized to "x_vcc"; the caller's v(vcc) probe is
            // remapped to v(x_vcc) (else it would resolve to "no such vector" in ngspice).
            expect(netlist).toContain('v(x_vcc)');
            expect(netlist).toContain('i(V1)');
        });

        it('should generate AC analysis command', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'AC 1', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                ],
                nets: [
                    createNet('in', 'in'),
                    createNet('0', '0', true),
                ],
            };

            const analysis: AcAnalysis = {
                type: 'ac',
                variation: 'dec',
                points: 10,
                startFreq: '1',
                stopFreq: '1MEG',
            };

            const netlist = generateNetlist(circuit, analysis);

            expect(netlist).toContain('.ac dec 10 1 1MEG');
        });

        it('should generate DC analysis command', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 0', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                ],
                nets: [
                    createNet('in', 'in'),
                    createNet('0', '0', true),
                ],
            };

            const analysis: DcAnalysis = {
                type: 'dc',
                source: 'V1',
                startVal: '0',
                stopVal: '5',
                increment: '0.1',
            };

            const netlist = generateNetlist(circuit, analysis);

            expect(netlist).toContain('.dc V1 0 5 0.1');
        });

        it('should generate OP analysis command', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                ],
                nets: [
                    createNet('vcc', 'vcc'),
                    createNet('0', '0', true),
                ],
            };

            const analysis: OpAnalysis = { type: 'op' };

            const netlist = generateNetlist(circuit, analysis);

            expect(netlist).toContain('.op');
        });

        it('should include files when specified', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                ],
                nets: [
                    createNet('vcc', 'vcc'),
                    createNet('0', '0', true),
                ],
            };

            const analysis: TranAnalysis = { type: 'tran', stopTime: '1m' };
            const options: NetlistOptions = {
                includeFiles: ['model.lib'],
                jobDir: '/tmp/job',
            };

            const netlist = generateNetlist(circuit, analysis, options);

            expect(netlist).toContain('.include "model.lib"');
        });

        it('should skip catalog-only generic components without throwing', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'vcc' },
                        { pinId: '2', netId: '0' },
                    ]),
                    // A real catalog part with no simulatable model (e.g. an IC): must not break netlisting.
                    {
                        id: 'U1',
                        type: 'generic',
                        designator: 'U1',
                        pins: [
                            { pinId: '1', netId: 'vcc' },
                            { pinId: '2', netId: '0' },
                        ],
                    },
                ],
                nets: [createNet('vcc', 'vcc'), createNet('0', '0', true)],
            };

            const analysis: TranAnalysis = { type: 'tran', stopTime: '1m' };

            expect(() => generateNetlist(circuit, analysis)).not.toThrow();
            const netlist = generateNetlist(circuit, analysis);
            expect(netlist).toContain('R1');
            // U1 is catalog-only → not emitted as a SPICE element line.
            expect(netlist).not.toMatch(/^U1 /m);
        });

        it('emits the correct SPICE device letter when a designator does not match the prefix', () => {
            // SPICE keys a device on its first letter. A Zener's device letter is 'D', but its natural
            // designator is "Z1" — emitting "Z1 …" verbatim is an invalid element (no 'Z' device exists),
            // so the generator must prepend 'D' -> "DZ1". A diode designated "CR1" must become "DCR1"
            // (else it parses as a capacitor). Conventional designators (already starting with the prefix)
            // must pass through UNCHANGED.
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('z1', 'zener', 'Z1', '5.1', [
                        { pinId: 'anode', netId: '0' },
                        { pinId: 'cathode', netId: 'in' },
                    ]),
                    createComponent('d1', 'diode', 'CR1', undefined, [
                        { pinId: 'anode', netId: 'in' },
                        { pinId: 'cathode', netId: 'out' },
                    ]),
                    createComponent('d2', 'diode', 'D9', undefined, [
                        { pinId: 'anode', netId: 'out' },
                        { pinId: 'cathode', netId: '0' },
                    ]),
                    createComponent('r1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'in' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('out', 'out'), createNet('0', '0', true)],
            };
            const netlist = generateNetlist(circuit, { type: 'tran', stopTime: '1m' });
            // Zener: "Z1" -> "DZ1", referencing its generated breakdown model (a real 'D' device).
            const zLine = netlist.split('\n').find((l) => /DZ1\s/i.test(l) && /Z1/i.test(l));
            expect(zLine).toBeTruthy();
            expect(zLine!.startsWith('DZ1')).toBe(true);
            expect(netlist).not.toMatch(/^Z1 /m); // never an invalid bare 'Z' device
            // Diode "CR1" -> "DCR1" (would otherwise parse as a capacitor).
            expect(netlist).toMatch(/^DCR1 /m);
            expect(netlist).not.toMatch(/^CR1 /m);
            // Conventional designators are untouched.
            expect(netlist).toMatch(/^D9 /m);
            expect(netlist).toMatch(/^R1 /m);
        });

        it('remaps i(<designator>) probes to the emitted (prefixed) device name', () => {
            // An inductor designated "FB1" (ferrite-bead convention) emits as "LFB1"; a caller-supplied
            // current probe i(FB1) must be rewritten to i(LFB1) or ngspice reports "i(FB1) not available".
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('v1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'a' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('l1', 'inductor', 'FB1', '1u', [
                        { pinId: '1', netId: 'a' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('a', 'a'), createNet('0', '0', true)],
            };
            const netlist = generateNetlist(circuit, { type: 'tran', stopTime: '1m' }, {
                probes: ['i(FB1)', 'v(a)', 'i(V1)'],
            });
            expect(netlist).toMatch(/^LFB1 /m); // device emitted prefixed
            expect(netlist).toMatch(/wrdata .*i\(LFB1\)/); // probe remapped to the emitted name
            expect(netlist).not.toMatch(/i\(FB1\)/); // the un-prefixed reference must not survive
            expect(netlist).toMatch(/i\(V1\)/); // conventional designator left as-is
            expect(netlist).toMatch(/v\(na\)/); // node probe v(a) remapped to its sanitized node "na"
        });

        it('remaps a .dc sweep source to the emitted (prefixed) device name', () => {
            // A voltage source designated "BAT1" emits as "VBAT1"; the sweep card must name VBAT1, not
            // BAT1, else ngspice aborts with "BAT1 is not in the circuit".
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('v1', 'voltage_source', 'BAT1', 'DC 0', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('r1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'in' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('0', '0', true)],
            };
            const dc: DcAnalysis = { type: 'dc', source: 'BAT1', startVal: '0', stopVal: '5', increment: '1' };
            const netlist = generateNetlist(circuit, dc);
            expect(netlist).toMatch(/^VBAT1 /m); // device emitted prefixed
            expect(netlist).toMatch(/^\.dc VBAT1 /m); // sweep references the emitted name
            expect(netlist).not.toMatch(/\.dc BAT1 /m);
        });

        it('throws on case-insensitive duplicate device names (ngspice is case-insensitive)', () => {
            // "d1" and "D1" are distinct strings but the same ngspice device — must be caught at generation
            // with a clear error, not leak to ngspice's opaque "device already exists, bail out".
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('v1', 'voltage_source', 'V1', 'DC 1', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('d1', 'diode', 'd1', undefined, [
                        { pinId: 'anode', netId: 'in' },
                        { pinId: 'cathode', netId: 'mid' },
                    ]),
                    createComponent('d2', 'diode', 'D1', undefined, [
                        { pinId: 'anode', netId: 'mid' },
                        { pinId: 'cathode', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('mid', 'mid'), createNet('0', '0', true)],
            };
            expect(() => generateNetlist(circuit, { type: 'tran', stopTime: '1m' })).toThrow(/[Dd]uplicate device name/);
        });

        it('remaps caller-supplied v(<net>) probes to the sanitized node (id, name, reserved word, differential)', () => {
            // A caller writes v(rail)/v(out) using the circuit's net id, but ngspice only knows the
            // sanitized node ("rail"->"nrail", reserved "out"->"x_out"). The probe must be remapped, or it
            // resolves to "no such vector". Differential v(a,b) and a probe already using the node are also
            // handled. (i(...) and unknown args are left untouched.)
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('v1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'rail' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('r1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'rail' },
                        { pinId: '2', netId: 'out' },
                    ]),
                    createComponent('r2', 'resistor', 'R2', '1k', [
                        { pinId: '1', netId: 'out' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('rail', 'rail'), createNet('out', 'out'), createNet('0', '0', true)],
            };
            const netlist = generateNetlist(circuit, { type: 'tran', stopTime: '1m' }, {
                probes: ['v(rail)', 'v(out)', 'v(rail,out)', 'v(nrail)', 'i(V1)'],
            });
            const wr = netlist.split('\n').find((l) => l.includes('wrdata'))!;
            expect(wr).toContain('v(nrail)'); // net id "rail" -> node "nrail"
            expect(wr).toContain('v(x_out)'); // reserved-word net "out" -> node "x_out"
            expect(wr).toContain('v(nrail,x_out)'); // differential, both args remapped
            expect(wr).toContain('i(V1)'); // current probe untouched here
            expect(wr).not.toMatch(/v\(rail\)/); // raw net id must not survive
            expect(wr).not.toMatch(/v\(out\)/);
        });

        it('strips token-breaking characters from a designator (no phantom node)', () => {
            // "C 1" would otherwise emit `C 1 <n1> <n2> 100n`, parsed as device C wired to a phantom node
            // "1"; sanitization yields a single-token "C1".
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('v1', 'voltage_source', 'V1', 'DC 1', [
                        { pinId: '+', netId: 'a' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('c1', 'capacitor', 'C 1', '100n', [
                        { pinId: '1', netId: 'a' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('a', 'a'), createNet('0', '0', true)],
            };
            const netlist = generateNetlist(circuit, { type: 'tran', stopTime: '1m' });
            expect(netlist).toMatch(/^C1 na 0 100n$/m); // single token, correct nodes
            expect(netlist).not.toMatch(/^C 1 /m);
        });
    });

    describe('isSimulatable', () => {
        it('is false for catalog-only generic parts, true for SPICE primitives', () => {
            expect(isSimulatable({ type: 'generic' })).toBe(false);
            expect(isSimulatable({ type: 'resistor' })).toBe(true);
            expect(isSimulatable({ type: 'diode' })).toBe(true);
            expect(isSimulatable({ type: 'voltage_source' })).toBe(true);
        });
    });

    describe('getNodeNames', () => {
        it('should return all node names', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [],
                nets: [
                    createNet('vcc', 'vcc'),
                    createNet('out', 'out'),
                    createNet('0', '0', true),
                ],
            };

            const nodes = getNodeNames(circuit);

            expect(nodes).toContain('0');
            expect(nodes.length).toBe(3);
        });
    });

    describe('validateNetlist', () => {
        it('should validate a correct netlist', () => {
            const netlist = `* Test
V1 in 0 DC 5
R1 in out 1k
.tran 1u 1m
.end`;

            const result = validateNetlist(netlist);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it('should detect missing .end', () => {
            const netlist = `* Test
V1 in 0 DC 5
.tran 1u 1m`;

            const result = validateNetlist(netlist);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('.end'))).toBe(true);
        });

        it('should detect missing analysis', () => {
            const netlist = `* Test
V1 in 0 DC 5
.end`;

            const result = validateNetlist(netlist);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('analysis'))).toBe(true);
        });
    });
});