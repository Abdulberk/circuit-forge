import { ComponentSchema } from '../src';

describe('Component sourcing fields (1.1.0, additive)', () => {
    const base = {
        id: 'r1',
        type: 'resistor' as const,
        designator: 'R1',
        value: '10k',
        pins: [
            { pinId: '1', netId: 'n1' },
            { pinId: '2', netId: 'n2' },
        ],
    };

    it('accepts a component without the new fields (backward compatible)', () => {
        expect(ComponentSchema.safeParse(base).success).toBe(true);
    });

    it('accepts mpn / manufacturer / footprint / sourcing', () => {
        const r = ComponentSchema.safeParse({
            ...base,
            mpn: '0603WAF1002T5E',
            manufacturer: 'UNI-ROYAL',
            footprint: '0603',
            sourcing: {
                supplier: 'tme',
                supplierId: 'C25804',
                unitCost: 0.0017,
                currency: 'EUR',
                stock: 100,
                datasheetUrl: 'https://example.com/ds.pdf',
            },
        });
        expect(r.success).toBe(true);
    });

    it('rejects sourcing without a supplier', () => {
        const r = ComponentSchema.safeParse({
            ...base,
            sourcing: { supplierId: 'C25804' },
        });
        expect(r.success).toBe(false);
    });
});
