/**
 * ERC (Electrical Rule Check) Tests
 */
import { runErc } from '../src/erc/checker';
import { ErcCode } from '../src/types/erc';
import type { CircuitJson, Component, Net } from '../src/types/circuit';

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

describe('ErcChecker', () => {
    describe('Ground Check', () => {
        it('should report error when no ground node exists', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', '5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: 'gnd' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'vcc' },
                        { pinId: '2', netId: 'gnd' },
                    ]),
                ],
                nets: [
                    createNet('vcc', 'vcc'),
                    createNet('gnd', 'gnd'), // Not named '0', so no ground
                ],
            };

            const result = runErc(circuit);

            expect(result.passed).toBe(false);
            expect(result.issues.some(i => i.code === ErcCode.NO_GROUND)).toBe(true);
        });

        it('should pass when ground node (0) exists', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', '5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'vcc' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [
                    createNet('vcc', 'vcc'),
                    createNet('0', '0'),
                ],
            };

            const result = runErc(circuit);

            expect(result.issues.some(i => i.code === ErcCode.NO_GROUND)).toBe(false);
        });

        it('should accept isGround flag as ground', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', '5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: 'gnd' },
                    ]),
                ],
                nets: [
                    createNet('vcc', 'vcc'),
                    createNet('gnd', 'GND', true), // isGround = true
                ],
            };

            const result = runErc(circuit);

            expect(result.issues.some(i => i.code === ErcCode.NO_GROUND)).toBe(false);
        });
    });

    describe('Floating Node Check', () => {
        it('should detect floating nodes (connected to only one pin)', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', '5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'vcc' },
                        { pinId: '2', netId: 'floating_node' },
                    ]),
                ],
                nets: [
                    createNet('vcc', 'vcc'),
                    createNet('0', '0'),
                    createNet('floating_node', 'floating_node'),
                ],
            };

            const result = runErc(circuit);

            expect(result.issues.some(i => i.code === ErcCode.NET_HAS_SINGLE_PIN)).toBe(true);
            const floatingIssue = result.issues.find(i => i.code === ErcCode.NET_HAS_SINGLE_PIN);
            expect(floatingIssue?.relatedIds).toContain('floating_node');
        });

        it('should not flag properly connected nodes', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', '5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'vcc' },
                        { pinId: '2', netId: 'mid' },
                    ]),
                    createComponent('R2', 'resistor', 'R2', '1k', [
                        { pinId: '1', netId: 'mid' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [
                    createNet('vcc', 'vcc'),
                    createNet('mid', 'mid'),
                    createNet('0', '0'),
                ],
            };

            const result = runErc(circuit);

            expect(result.issues.some(i => i.code === ErcCode.NET_HAS_SINGLE_PIN)).toBe(false);
        });

        it('flags a node with no DC path (only capacitor connections) as FLOATING_NODE', () => {
            // A capacitive-divider mid-node touches only capacitors → caps are open at DC → no operating
            // point (singular .op). Warn (ERC010) suggesting initialConditions, instead of letting ngspice
            // limp through gmin with a DC-offset artifact.
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'AC 1', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('C1', 'capacitor', 'C1', '1u', [
                        { pinId: '1', netId: 'in' },
                        { pinId: '2', netId: 'mid' },
                    ]),
                    createComponent('C2', 'capacitor', 'C2', '1u', [
                        { pinId: '1', netId: 'mid' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('mid', 'mid'), createNet('0', '0')],
            };

            const result = runErc(circuit);
            const floating = result.issues.filter(i => i.code === ErcCode.FLOATING_NODE);
            expect(floating.some(i => i.relatedIds.includes('mid'))).toBe(true);
        });

        it('does NOT flag a node that has a resistor (DC path) alongside a capacitor', () => {
            // False-positive guard: an RC node has a DC path through R, so it is NOT a floating node.
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'in' },
                        { pinId: '2', netId: 'out' },
                    ]),
                    createComponent('C1', 'capacitor', 'C1', '1u', [
                        { pinId: '1', netId: 'out' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('out', 'out'), createNet('0', '0')],
            };

            const result = runErc(circuit);
            expect(result.issues.some(i => i.code === ErcCode.FLOATING_NODE)).toBe(false);
        });
    });

    describe('Voltage Source Short Circuit Check', () => {
        it('should detect parallel voltage sources with different values', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', '5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('V2', 'voltage_source', 'V2', '10', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                ],
                nets: [
                    createNet('vcc', 'vcc'),
                    createNet('0', '0'),
                ],
            };

            const result = runErc(circuit);

            expect(result.issues.some(i => i.code === ErcCode.PARALLEL_VOLTAGE_SOURCES)).toBe(true);
        });

        it('should not flag single voltage source', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', '5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'vcc' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [
                    createNet('vcc', 'vcc'),
                    createNet('0', '0'),
                ],
            };

            const result = runErc(circuit);

            expect(result.issues.some(i => i.code === ErcCode.VOLTAGE_SOURCE_SHORT)).toBe(false);
        });

        it('flags a vcvs output paralleled with a voltage source on the same net (over-determined)', () => {
            // Two voltage-FORCING devices across the same pair (V1 and the vcvs E1 both drive out↔0) make
            // ngspice's matrix singular. ERC must catch it pre-sim, even though E1 is not a plain voltage_source.
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'DC 5', [
                        { pinId: '+', netId: 'out' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('E1', 'vcvs', 'E1', '2', [
                        { pinId: '+', netId: 'out' },
                        { pinId: '-', netId: '0' },
                        { pinId: 'c+', netId: 'in' },
                        { pinId: 'c-', netId: '0' },
                    ]),
                    createComponent('VIN', 'voltage_source', 'VIN', 'DC 1', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                ],
                nets: [createNet('out', 'out'), createNet('in', 'in'), createNet('0', '0')],
            };

            const result = runErc(circuit);

            expect(result.issues.some(i => i.code === ErcCode.PARALLEL_VOLTAGE_SOURCES)).toBe(true);
        });

        it('does NOT flag a single vcvs driving its own net while sensing another (no parallel)', () => {
            // False-positive guard: a vcvs in a normal role — sensing `in` (high-Z c+/c-), driving `out` —
            // is the ONLY driver on out↔0, so it must not be mistaken for a parallel-source conflict.
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('VIN', 'voltage_source', 'VIN', 'DC 1', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('E1', 'vcvs', 'E1', '2', [
                        { pinId: '+', netId: 'out' },
                        { pinId: '-', netId: '0' },
                        { pinId: 'c+', netId: 'in' },
                        { pinId: 'c-', netId: '0' },
                    ]),
                    createComponent('RL', 'resistor', 'RL', '1k', [
                        { pinId: '1', netId: 'out' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [createNet('in', 'in'), createNet('out', 'out'), createNet('0', '0')],
            };

            const result = runErc(circuit);

            expect(result.issues.some(i => i.code === ErcCode.PARALLEL_VOLTAGE_SOURCES)).toBe(false);
        });
    });

    describe('Pin Count Validation', () => {
        it('should detect components with missing pins', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'vcc' }, // Missing pin 2
                    ]),
                ],
                nets: [
                    createNet('vcc', 'vcc'),
                    createNet('0', '0'),
                ],
            };

            const result = runErc(circuit);

            expect(result.issues.some(i => i.code === ErcCode.PIN_COUNT_MISMATCH)).toBe(true);
        });

        it('should validate voltage source has both pins', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', '5', [
                        { pinId: '+', netId: 'vcc' }, // Missing negative
                    ]),
                ],
                nets: [
                    createNet('vcc', 'vcc'),
                    createNet('0', '0'),
                ],
            };

            const result = runErc(circuit);

            expect(result.issues.some(i => i.code === ErcCode.PIN_COUNT_MISMATCH)).toBe(true);
        });
    });

    describe('ERC Result Structure', () => {
        it('should return proper result structure', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', '5', [
                        { pinId: '+', netId: 'vcc' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'vcc' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [
                    createNet('vcc', 'vcc'),
                    createNet('0', '0'),
                ],
            };

            const result = runErc(circuit);

            expect(result).toHaveProperty('passed');
            expect(result).toHaveProperty('issues');
            expect(result).toHaveProperty('summary');
            expect(Array.isArray(result.issues)).toBe(true);
        });

        it('should include severity in issues', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'floating' },
                        { pinId: '2', netId: 'gnd' },
                    ]),
                ],
                nets: [
                    createNet('floating', 'floating'),
                    createNet('gnd', 'gnd'),
                ],
            };

            const result = runErc(circuit);

            result.issues.forEach(issue => {
                expect(['error', 'warning', 'info']).toContain(issue.severity);
            });
        });
    });

    describe('Empty Circuit', () => {
        it('should handle empty components array', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [],
                nets: [],
            };

            const result = runErc(circuit);

            // Empty circuit should have no ground error and empty circuit error
            expect(result.issues.some(i => i.code === ErcCode.EMPTY_CIRCUIT)).toBe(true);
        });
    });

    describe('Complex Circuits', () => {
        it('should validate a typical RC filter circuit', () => {
            const circuit: CircuitJson = {
                version: '1.0',
                components: [
                    createComponent('V1', 'voltage_source', 'V1', 'SIN(0 1 1k)', [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ]),
                    createComponent('R1', 'resistor', 'R1', '1k', [
                        { pinId: '1', netId: 'in' },
                        { pinId: '2', netId: 'out' },
                    ]),
                    createComponent('C1', 'capacitor', 'C1', '100n', [
                        { pinId: '1', netId: 'out' },
                        { pinId: '2', netId: '0' },
                    ]),
                ],
                nets: [
                    createNet('in', 'in'),
                    createNet('out', 'out'),
                    createNet('0', '0'),
                ],
            };

            const result = runErc(circuit);

            expect(result.passed).toBe(true);
            expect(result.issues.filter(i => i.severity === 'error')).toHaveLength(0);
        });
    });
});