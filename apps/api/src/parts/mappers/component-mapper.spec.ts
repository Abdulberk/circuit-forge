import { ComponentMapper } from './component-mapper';
import type { CatalogPart } from '../provider/part-provider.interface';

const mapper = new ComponentMapper();

function part(over: Partial<CatalogPart>): CatalogPart {
    return {
        mpn: 'X',
        manufacturer: 'M',
        description: '',
        parameters: [],
        priceBreaks: [],
        supplier: 'tme',
        supplierId: 'X',
        ...over,
    };
}

describe('ComponentMapper', () => {
    it('maps a resistor with normalized value, footprint and sourcing', () => {
        const r = mapper.toComponent(
            part({
                category: 'Resistors',
                footprint: '0603',
                parameters: [{ name: 'Resistance', value: '10kΩ' }],
                unitCost: 0.0017,
                currency: 'EUR',
                stock: 100,
                datasheetUrl: 'https://d/x.pdf',
            }),
        );
        expect(r.simulatable).toBe(true);
        expect(r.component?.type).toBe('resistor');
        expect(r.component?.value).toBe('10K');
        expect(r.component?.footprint).toBe('0603');
        expect(r.component?.sourcing).toMatchObject({
            supplier: 'tme',
            supplierId: 'X',
            unitCost: 0.0017,
            currency: 'EUR',
            stock: 100,
            datasheetUrl: 'https://d/x.pdf',
        });
    });

    it('normalizes a capacitor value (100nF -> 100n)', () => {
        const r = mapper.toComponent(part({ category: 'Capacitors', parameters: [{ name: 'Capacitance', value: '100nF' }] }));
        expect(r.component?.type).toBe('capacitor');
        expect(r.component?.value).toBe('100n');
    });

    it('marks an IC (NE555) as catalog-only / not simulatable', () => {
        const r = mapper.toComponent(part({ category: 'Watchdog and reset circuits', description: 'IC: RC timer' }));
        expect(r.simulatable).toBe(false);
        expect(r.component).toBeUndefined();
        expect(r.reason).toMatch(/catalog-only/i);
    });

    it('returns metadata but not simulatable when a passive has no value', () => {
        const r = mapper.toComponent(part({ category: 'Resistors', parameters: [] }));
        expect(r.simulatable).toBe(false);
        expect(r.component?.type).toBe('resistor');
        expect(r.reason).toMatch(/value/i);
    });

    it('maps a diode (value-less, model-based) as simulatable', () => {
        const r = mapper.toComponent(part({ category: 'Universal diodes', description: '1N4148 diode' }));
        expect(r.simulatable).toBe(true);
        expect(r.component?.type).toBe('diode');
        expect(r.component?.value).toBeUndefined();
    });
});
