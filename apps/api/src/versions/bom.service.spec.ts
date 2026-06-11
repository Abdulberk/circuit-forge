import { BomService } from './bom.service';
import type { CircuitJson } from '@circuit-forge/eda-core';

const bom = new BomService();

/** A realistic mixed circuit: 3× the same sourced resistor, 1 sourced diode, 1 unsourced cap, ground. */
const circuit: CircuitJson = {
    version: '1.0',
    components: [
        ...[1, 2, 3].map((n) => ({
            id: `r${n}`,
            type: 'resistor' as const,
            designator: `R${n}`,
            value: '330',
            footprint: '0603',
            mpn: 'RC0603FR-07330RL',
            manufacturer: 'YAGEO',
            sourcing: { supplier: 'tme', supplierId: 'RC0603FR-07330R', unitCost: 0.07, currency: 'EUR', stock: 105378 },
            pins: [{ pinId: '1', netId: 'a' }, { pinId: '2', netId: 'b' }],
        })),
        {
            id: 'd1',
            type: 'diode' as const,
            designator: 'D1',
            mpn: '1N4148',
            manufacturer: 'ONSEMI',
            sourcing: { supplier: 'tme', supplierId: '1N4148', unitCost: 0.02, currency: 'EUR', stock: 0 },
            pins: [{ pinId: 'anode', netId: 'a' }, { pinId: 'cathode', netId: 'b' }],
        },
        {
            id: 'c1',
            type: 'capacitor' as const,
            designator: 'C1',
            value: '100n',
            pins: [{ pinId: '1', netId: 'b' }, { pinId: '2', netId: 'g' }],
        },
        { id: 'g1', type: 'ground' as const, designator: 'GND1', pins: [{ pinId: '1', netId: 'g' }] },
    ],
    nets: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
        { id: 'g', name: 'G', isGround: true },
    ],
};

describe('BomService', () => {
    it('aggregates identical sourced parts into one line with summed quantity and line cost', () => {
        const b = bom.build(circuit);
        const r = b.lines.find((l) => l.mpn === 'RC0603FR-07330RL')!;
        expect(r.quantity).toBe(3);
        expect(r.designators).toEqual(['R1', 'R2', 'R3']);
        expect(r.lineCost).toBeCloseTo(0.21);
        expect(r.stock).toBe(105378);
        expect(r.unsourced).toBe(false);
    });

    it('excludes ground symbols, keeps unsourced parts as flagged lines, totals per currency', () => {
        const b = bom.build(circuit);
        expect(b.totals.components).toBe(5); // 3R + 1D + 1C, ground excluded
        expect(b.totals.uniqueParts).toBe(3);
        expect(b.totals.unsourcedLines).toBe(1);
        const cap = b.lines.find((l) => l.type === 'capacitor')!;
        expect(cap.unsourced).toBe(true);
        expect(cap.mpn).toBeNull();
        // EUR total = 3×0.07 + 1×0.02 (the unpriced cap contributes nothing)
        expect(b.totals.costByCurrency.EUR).toBeCloseTo(0.23);
        // sourced lines sort before unsourced
        expect(b.lines[b.lines.length - 1]!.unsourced).toBe(true);
    });

    it('renders CSV with a header, quoted fields and one row per line', () => {
        const csv = bom.toCsv(bom.build(circuit));
        const rows = csv.trim().split('\n');
        expect(rows[0]).toContain('designators,quantity,type');
        expect(rows).toHaveLength(1 + 3);
        expect(csv).toContain('R1 R2 R3,3,resistor,330,RC0603FR-07330RL,YAGEO,0603,0.07,EUR,0.21,105378,tme');
    });
});
