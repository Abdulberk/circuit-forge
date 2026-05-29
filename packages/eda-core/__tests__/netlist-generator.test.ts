/**
 * Netlist Generator Tests
 */
import { generateNetlist, getNodeNames, validateNetlist } from '../src/netlist/generator';
import type { NetlistOptions } from '../src/netlist/generator';
import type { CircuitJson, Component, Net } from '../src/types/circuit';
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

            expect(netlist).toContain('v(vcc)');
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