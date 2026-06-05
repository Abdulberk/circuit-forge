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

    it('marks an IC (NE555) as a catalog-only generic component (placeable, not simulatable)', () => {
        const r = mapper.toComponent(part({ category: 'Watchdog and reset circuits', description: 'IC: RC timer' }));
        expect(r.simulatable).toBe(false);
        expect(r.component?.type).toBe('generic');
        expect(r.component?.mpn).toBe('X'); // still carries catalog metadata so it can be placed
        expect(r.reason).toMatch(/catalog-only/i);
    });

    it('classifies by stable category id, independent of the localized description text', () => {
        // Polish category name that the English text heuristic would NOT match, but categoryId 100300
        // ("SMD resistors") is authoritative -> still classified as a resistor.
        const r = mapper.toComponent(part({ category: 'Rezystory SMD', categoryId: '100300' }));
        expect(r.component?.type).toBe('resistor');
    });

    it('does NOT misclassify a Zener as a plain diode (the category map overrides the text fallback)', () => {
        // Text "diode" would wrongly hit the diode branch; categoryId 100257 (Zener) maps to generic.
        const r = mapper.toComponent(part({ category: 'Zener diodes', categoryId: '100257', description: 'BZX Zener diode' }));
        expect(r.component?.type).toBe('generic');
        expect(r.simulatable).toBe(false);
    });

    it('text fallback refuses to guess a clamp/network part even with an UNMAPPED category id', () => {
        // No mapped id -> text fallback. "diode" is present, but the clamp keyword guards it to generic
        // (a Zener simulated as a plain DDEFAULT rectifier would be physically wrong).
        const zener = mapper.toComponent(part({ category: 'Some New Zener Leaf', categoryId: '999999', description: 'BZX Zener diode' }));
        expect(zener.component?.type).toBe('generic');
        // A resistor network likewise must not become a single 2-terminal resistor.
        const net = mapper.toComponent(part({ category: 'Resistor network array', description: '8x 10k resistor network' }));
        expect(net.component?.type).toBe('generic');
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

    it('maps an NPN transistor (category 112833) to a simulatable bjt with a generic model', () => {
        const r = mapper.toComponent(part({ category: 'NPN SMD transistors', categoryId: '112833', description: 'BC847 NPN' }));
        expect(r.simulatable).toBe(true);
        expect(r.component?.type).toBe('bjt');
        expect(r.component?.model).toBe('QGENNPN'); // polarity from the category -> NPN generic model
        expect(r.modelDef?.name).toBe('QGENNPN'); // body returned so the assembler can add it to circuit.models
        expect(r.modelDef?.device).toBe('bjt');
    });

    it('maps a P-channel MOSFET (category 112828) to a simulatable mosfet with a PMOS model', () => {
        const r = mapper.toComponent(part({ category: 'SMD P channel transistors', categoryId: '112828' }));
        expect(r.component?.type).toBe('mosfet');
        expect(r.component?.model).toBe('MGENPMOS');
        expect(r.modelDef?.name).toBe('MGENPMOS');
    });

    it('rejects a range value (not a single SPICE value)', () => {
        const r = mapper.toComponent(part({ category: 'Resistors', parameters: [{ name: 'Resistance', value: '4.5...16' }] }));
        expect(r.simulatable).toBe(false);
        expect(r.component?.value).toBeUndefined();
    });

    it('extracts the nominal value, ignoring a tolerance suffix', () => {
        const r = mapper.toComponent(part({ category: 'Resistors', parameters: [{ name: 'Resistance', value: '10kΩ ±1%' }] }));
        expect(r.simulatable).toBe(true);
        expect(r.component?.value).toBe('10K');
    });

    it('does not emit Infinity for an overflowing value', () => {
        const huge = '1' + '0'.repeat(320) + 'K';
        const r = mapper.toComponent(part({ category: 'Resistors', parameters: [{ name: 'Resistance', value: huge }] }));
        expect(r.simulatable).toBe(false);
        expect(r.component?.value).toBeUndefined();
    });
});
