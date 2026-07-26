/**
 * IEC 60063 E-series snapping tests (Faz B-1). Pure number/string math — closed-form expected values.
 */
import type { CircuitJson } from '../src/types/circuit';
import { nearestESeries, isESeriesValue, snapValueString, snapCircuitToESeries } from '../src/utils/eseries';

describe('nearestESeries', () => {
    it('snaps a computed value to the nearest E24 preferred value (in log space)', () => {
        expect(nearestESeries(3270, 'E24')).toBe(3300); // divider output 3.27k -> 3.3k
        expect(nearestESeries(1591.5, 'E24')).toBe(1600); // RC filter 1591.5 -> 1.6k
        expect(nearestESeries(15915, 'E24')).toBe(16000);
    });
    it('leaves an exact preferred value unchanged', () => {
        expect(nearestESeries(4700, 'E24')).toBe(4700);
        expect(nearestESeries(2200, 'E24')).toBe(2200);
    });
    it('snaps up across a decade boundary (9.9 -> 10)', () => {
        expect(nearestESeries(9.9, 'E24')).toBe(10);
        expect(nearestESeries(9900, 'E24')).toBe(10000);
    });
    it('respects the chosen series granularity', () => {
        expect(nearestESeries(3270, 'E12')).toBe(3300); // E12 has 3.3
        expect(nearestESeries(3270, 'E96')).toBe(3240); // E96 has 3.24 and 3.32; 3.27 is nearer 3.24 in log
    });
    it('passes through non-positive / non-finite input untouched', () => {
        expect(nearestESeries(0, 'E24')).toBe(0);
        expect(nearestESeries(-5, 'E24')).toBe(-5);
        expect(nearestESeries(NaN, 'E24')).toBeNaN();
    });
});

describe('isESeriesValue', () => {
    it('accepts an exact preferred value and rejects a computed near-miss', () => {
        expect(isESeriesValue(4700, 'E24')).toBe(true);
        expect(isESeriesValue(1591.5, 'E24')).toBe(false); // ~0.5% off 1.6k -> not manufacturable as-is
        expect(isESeriesValue(3270, 'E24')).toBe(false);
        expect(isESeriesValue(3300, 'E12')).toBe(true);
    });
});

describe('snapValueString', () => {
    it('snaps a SPICE value string and reformats it, preserving the unit', () => {
        expect(snapValueString('3.27k', 'E24')).toBe('3.3K');
        expect(snapValueString('1591.5', 'E24')).toBe('1.6K');
        expect(snapValueString('100n', 'E24')).toBe('100n'); // already standard
    });
    it('returns null for an unparseable value (caller keeps the original)', () => {
        expect(snapValueString('not-a-number', 'E24')).toBeNull();
        expect(snapValueString('', 'E24')).toBeNull();
    });
});

describe('snapCircuitToESeries — circuit-level "make it sourceable" transform', () => {
    const circuit: CircuitJson = {
        version: '1.0',
        components: [
            {
                id: 'v1',
                type: 'voltage_source',
                designator: 'V1',
                value: 'DC 10',
                pins: [
                    { pinId: '+', netId: 'in' },
                    { pinId: '-', netId: '0' },
                ],
            },
            {
                id: 'r1',
                type: 'resistor',
                designator: 'R1',
                value: '3.27k',
                pins: [
                    { pinId: '1', netId: 'in' },
                    { pinId: '2', netId: 'out' },
                ],
            },
            {
                id: 'r2',
                type: 'resistor',
                designator: 'R2',
                value: '4.7k',
                pins: [
                    { pinId: '1', netId: 'out' },
                    { pinId: '2', netId: '0' },
                ],
            }, // already preferred
            {
                id: 'c1',
                type: 'capacitor',
                designator: 'C1',
                value: '1591.5',
                pins: [
                    { pinId: '1', netId: 'out' },
                    { pinId: '2', netId: '0' },
                ],
            },
        ],
        nets: [
            { id: 'in', name: 'in' },
            { id: 'out', name: 'out' },
            { id: '0', name: '0', isGround: true },
        ],
    };

    it('snaps only the off-grid passives, leaves preferred values + sources untouched, and reports each change', () => {
        const { circuit: snapped, changes } = snapCircuitToESeries(circuit, 'E24');
        const byId = Object.fromEntries(snapped.components.map((c) => [c.id, c.value]));
        expect(byId.r1).toBe('3.3K'); // 3.27k → 3.3k (E24)
        expect(byId.c1).toBe('1.6K'); // 1591.5 → 1.6k
        expect(byId.r2).toBe('4.7k'); // already preferred → unchanged
        expect(byId.v1).toBe('DC 10'); // a source value is never snapped
        const ids = changes.map((c) => c.id).sort();
        expect(ids).toEqual(['c1', 'r1']);
        const r1c = changes.find((c) => c.id === 'r1')!;
        expect(r1c.from).toBe('3.27k');
        expect(r1c.to).toBe('3.3K');
        expect(r1c.deltaPct).toBeCloseTo(((3300 - 3270) / 3270) * 100, 3); // ≈ +0.92%
    });

    it('does not mutate the input circuit', () => {
        const before = circuit.components.find((c) => c.id === 'r1')!.value;
        snapCircuitToESeries(circuit, 'E24');
        expect(circuit.components.find((c) => c.id === 'r1')!.value).toBe(before); // still 3.27k
    });

    it('an already-sourceable circuit yields zero changes', () => {
        const clean: CircuitJson = {
            version: '1.0',
            components: [{ id: 'r', type: 'resistor', designator: 'R1', value: '10k', pins: [] }],
            nets: [],
        };
        expect(snapCircuitToESeries(clean, 'E24').changes).toHaveLength(0);
    });
});
