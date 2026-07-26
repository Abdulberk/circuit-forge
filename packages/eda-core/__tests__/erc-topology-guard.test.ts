/**
 * Topology-guard ERC (Faz B-3): duplicate-designator (a real collision the generator would otherwise abort
 * on) + dimensional-unit sanity (ngspice reads only the number, so "4.7uF" on a resistor silently means
 * 4.7uΩ) + the schema accepting multi-section refdes (U1A) that it previously rejected.
 */
import { runErc } from '../src/erc/checker';
import { CircuitJsonSchema } from '../src/schemas/circuit.schema';
import type { CircuitJson, Component } from '../src/types/circuit';
import { ErcCode } from '../src/types/erc';

const C = (
    id: string,
    type: Component['type'],
    designator: string,
    value: string | undefined,
    nets: string[],
): Component => ({
    id,
    type,
    designator,
    value,
    pins: nets.map((netId, i) => ({ pinId: String(i + 1), netId })),
});
const has = (c: CircuitJson, code: ErcCode) => runErc(c).issues.some((i) => i.code === code);

describe('ERC — duplicate designator', () => {
    it('flags two components that share a designator (case-insensitively)', () => {
        const circuit: CircuitJson = {
            version: '1.0',
            components: [
                C('v1', 'voltage_source', 'V1', 'DC 5', ['in', '0']),
                C('r1', 'resistor', 'R1', '1k', ['in', 'out']),
                C('r2', 'resistor', 'r1', '2k', ['out', '0']), // duplicate of R1 (case-insensitive)
            ],
            nets: [
                { id: 'in', name: 'in' },
                { id: 'out', name: 'out' },
                { id: '0', name: '0', isGround: true },
            ],
        };
        const dup = runErc(circuit).issues.find((i) => i.code === ErcCode.DUPLICATE_DESIGNATOR);
        expect(dup).toBeDefined();
        expect(dup!.severity).toBe('error');
        expect(dup!.relatedIds.sort()).toEqual(['r1', 'r2']); // both colliding components named
    });
    it('does NOT flag unique designators', () => {
        const circuit: CircuitJson = {
            version: '1.0',
            components: [
                C('v1', 'voltage_source', 'V1', 'DC 5', ['in', '0']),
                C('r1', 'resistor', 'R1', '1k', ['in', 'out']),
                C('r2', 'resistor', 'R2', '2k', ['out', '0']),
            ],
            nets: [
                { id: 'in', name: 'in' },
                { id: 'out', name: 'out' },
                { id: '0', name: '0', isGround: true },
            ],
        };
        expect(has(circuit, ErcCode.DUPLICATE_DESIGNATOR)).toBe(false);
    });
});

describe('ERC — dimensional-unit sanity', () => {
    const mk = (type: Component['type'], value: string): CircuitJson => ({
        version: '1.0',
        components: [
            C('v1', 'voltage_source', 'V1', 'DC 5', ['in', '0']),
            C('x1', type, type === 'resistor' ? 'R1' : type === 'capacitor' ? 'C1' : 'L1', value, ['in', '0']),
        ],
        nets: [
            { id: 'in', name: 'in' },
            { id: '0', name: '0', isGround: true },
        ],
    });
    it('flags a resistor whose value is in farads / henries', () => {
        expect(has(mk('resistor', '4.7uF'), ErcCode.WRONG_VALUE_UNIT)).toBe(true);
        expect(has(mk('resistor', '10mH'), ErcCode.WRONG_VALUE_UNIT)).toBe(true);
    });
    it('flags a capacitor in ohms and an inductor in farads', () => {
        expect(has(mk('capacitor', '10kOhm'), ErcCode.WRONG_VALUE_UNIT)).toBe(true);
        expect(has(mk('inductor', '10uF'), ErcCode.WRONG_VALUE_UNIT)).toBe(true);
    });
    it('does NOT flag a correct unit or a bare (unit-less) value', () => {
        expect(has(mk('resistor', '4.7k'), ErcCode.WRONG_VALUE_UNIT)).toBe(false); // bare → base unit (ohms)
        expect(has(mk('resistor', '4.7kOhm'), ErcCode.WRONG_VALUE_UNIT)).toBe(false);
        expect(has(mk('capacitor', '100n'), ErcCode.WRONG_VALUE_UNIT)).toBe(false);
        expect(has(mk('capacitor', '100nF'), ErcCode.WRONG_VALUE_UNIT)).toBe(false);
        expect(has(mk('inductor', '1mH'), ErcCode.WRONG_VALUE_UNIT)).toBe(false);
    });
});

describe('CircuitJson schema — multi-section reference designators', () => {
    const oneComp = (designator: string) => ({
        version: '1.0',
        components: [
            {
                id: 'u1',
                type: 'resistor',
                designator,
                value: '1k',
                pins: [
                    { pinId: '1', netId: 'a' },
                    { pinId: '2', netId: '0' },
                ],
            },
        ],
        nets: [
            { id: 'a', name: 'a' },
            { id: '0', name: '0', isGround: true },
        ],
    });
    it('accepts U1A / K1A / R1 (section letter optional)', () => {
        expect(CircuitJsonSchema.safeParse(oneComp('U1A')).success).toBe(true);
        expect(CircuitJsonSchema.safeParse(oneComp('K1A')).success).toBe(true);
        expect(CircuitJsonSchema.safeParse(oneComp('R1')).success).toBe(true);
    });
    it('still rejects a designator with no number', () => {
        expect(CircuitJsonSchema.safeParse(oneComp('R')).success).toBe(false);
    });
});
