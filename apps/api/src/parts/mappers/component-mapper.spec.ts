import type { CatalogPart } from '../provider/part-provider.interface';

import { ComponentMapper } from './component-mapper';

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

    describe('tolerance capture from the catalog (a datasheet fact, tagged source=catalog)', () => {
        it('captures a resistor ±1% tolerance as 0.01 with source catalog', () => {
            const r = mapper.toComponent(part({ category: 'Resistors', parameters: [{ name: 'Resistance', value: '10kΩ' }, { name: 'Tolerance', value: '±1%' }] }));
            expect(r.component?.tolerance).toBeCloseTo(0.01);
            expect(r.component?.toleranceSource).toBe('catalog');
        });

        it('captures a capacitor ±10% tolerance as 0.10', () => {
            const c = mapper.toComponent(part({ category: 'Capacitors', parameters: [{ name: 'Capacitance', value: '100nF' }, { name: 'Tolerance', value: '±10%' }] }));
            expect(c.component?.tolerance).toBeCloseTo(0.1);
            expect(c.component?.toleranceSource).toBe('catalog');
        });

        it('leaves tolerance unset when the catalog has no Tolerance parameter', () => {
            const r = mapper.toComponent(part({ category: 'Resistors', parameters: [{ name: 'Resistance', value: '10kΩ' }] }));
            expect(r.component?.tolerance).toBeUndefined();
            expect(r.component?.toleranceSource).toBeUndefined();
        });

        it('does NOT capture an asymmetric or absolute tolerance (no single fractional form)', () => {
            const asym = mapper.toComponent(part({ category: 'Capacitors', parameters: [{ name: 'Capacitance', value: '100nF' }, { name: 'Tolerance', value: '+80/-20%' }] }));
            expect(asym.component?.tolerance).toBeUndefined();
            const abs = mapper.toComponent(part({ category: 'Capacitors', parameters: [{ name: 'Capacitance', value: '10pF' }, { name: 'Tolerance', value: '±0.25pF' }] }));
            expect(abs.component?.tolerance).toBeUndefined();
        });

        it('does NOT mistake the temperature-coefficient row for tolerance', () => {
            const r = mapper.toComponent(part({ category: 'Resistors', parameters: [{ name: 'Resistance', value: '10kΩ' }, { name: 'Temperature coefficient', value: '100ppm/°C' }] }));
            expect(r.component?.tolerance).toBeUndefined();
        });
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

    it('maps a Zener (category 100257) WITH a breakdown voltage to a simulatable zener carrying Vz', () => {
        const r = mapper.toComponent(part({
            category: 'Zener diodes', categoryId: '100257', description: 'BZX 5.1V Zener',
            parameters: [{ name: 'Zener voltage Vz', value: '5.1V' }],
        }));
        expect(r.component?.type).toBe('zener');
        expect(r.simulatable).toBe(true);
        expect(r.component?.value).toBe('5.1V'); // raw Vz; the netlist generator builds the model from it
    });

    it('maps a Zener with NO usable voltage to a catalog-only (non-simulatable) zener, never a plain diode', () => {
        // categoryId 100257 is authoritative -> 'zener' (not the 'diode' the text would suggest). Without
        // a parseable Vz we cannot build a breakdown model, so it stays placeable-but-not-simulatable.
        const r = mapper.toComponent(part({ category: 'Zener diodes', categoryId: '100257', description: 'BZX Zener diode' }));
        expect(r.component?.type).toBe('zener');
        expect(r.simulatable).toBe(false);
        expect(r.reason).toMatch(/breakdown voltage/i);
    });

    it('picks the breakdown voltage (VBR), not a TVS reverse stand-off (VRWM)', () => {
        const r = mapper.toComponent(part({
            category: 'Unidirectional TVS SMD diodes', categoryId: '112801', description: 'SMAJ',
            parameters: [
                { name: 'Reverse stand-off voltage VRWM', value: '5.0V' },
                { name: 'Breakdown voltage VBR', value: '6.4V' },
            ],
        }));
        expect(r.component?.type).toBe('zener');
        expect(r.simulatable).toBe(true);
        expect(r.component?.value).toBe('6.4V'); // VBR, NOT the 5.0V stand-off
    });

    it('does NOT build a Zener from a rectifier max-reverse (VRRM) parameter', () => {
        const r = mapper.toComponent(part({
            category: 'Zener diodes', categoryId: '100257',
            parameters: [{ name: 'Maximum reverse voltage VRRM', value: '75V' }],
        }));
        expect(r.component?.type).toBe('zener');
        expect(r.simulatable).toBe(false); // VRRM is not a Zener voltage -> not picked
    });

    it('ignores a tolerance row and picks the actual Zener voltage', () => {
        const r = mapper.toComponent(part({
            category: 'Zener diodes', categoryId: '100257',
            parameters: [
                { name: 'Tolerance of Zener voltage', value: '5%' },
                { name: 'Zener voltage Vz', value: '5.1V' },
            ],
        }));
        expect(r.component?.value).toBe('5.1V');
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
describe('LEDs (diode + color-class generic model)', () => {
        it('maps a THT red LED (category 112896) to diode + LEDRED with the modelDef attached', () => {
            const r = mapper.toComponent(
                part({
                    mpn: 'L-53ID',
                    manufacturer: 'KINGBRIGHT',
                    categoryId: '112896',
                    category: 'THT LEDs Round',
                    description: 'LED; red; 5mm; 12.5÷80mcd; 60°; Front: convex; 2÷2.5VDC',
                }),
            );
            expect(r.simulatable).toBe(true);
            expect(r.component?.type).toBe('diode');
            expect(r.component?.model).toBe('LEDRED');
            expect(r.modelDef?.name).toBe('LEDRED');
            expect(r.modelDef?.body).toContain('.model LEDRED D(');
        });

        it('maps an SMD green LED (category 113363) to LEDGRN, blue/white to LEDBLU, amber to LEDYEL', () => {
            const grn = mapper.toComponent(part({ categoryId: '113363', category: 'SMD colour LEDs', description: 'LED; green; 0603' }));
            expect(grn.component?.model).toBe('LEDGRN');
            const blu = mapper.toComponent(part({ categoryId: '113363', category: 'SMD colour LEDs', description: 'LED; white; 1206' }));
            expect(blu.component?.model).toBe('LEDBLU');
            const yel = mapper.toComponent(part({ categoryId: '112896', category: 'THT LEDs Round', description: 'LED; amber; 3mm' }));
            expect(yel.component?.model).toBe('LEDYEL');
        });

        it('keeps a colorless or multi-color LED catalog-only (never a silent DDEFAULT diode)', () => {
            const noColor = mapper.toComponent(part({ categoryId: '112896', category: 'THT LEDs Round', description: 'LED; 5mm; 60°' }));
            expect(noColor.simulatable).toBe(false);
            expect(noColor.component?.type).toBe('generic');
            expect(noColor.reason).toMatch(/color/i);
            const rgb = mapper.toComponent(part({ categoryId: '113363', category: 'SMD colour LEDs', description: 'LED; RGB; 5mm; red green blue' }));
            expect(rgb.simulatable).toBe(false);
        });

        it('classifies an unmapped LED leaf by category NAME, but never LED accessories', () => {
            const byName = mapper.toComponent(part({ categoryId: '999999', category: 'THT LEDs rectangular', description: 'LED; yellow; 5x2mm' }));
            expect(byName.component?.model).toBe('LEDYEL');
            const driver = mapper.toComponent(part({ categoryId: '999998', category: 'LED drivers', description: 'LED driver; 350mA' }));
            expect(driver.component?.model).toBeUndefined();
            expect(driver.simulatable).toBe(false);
        });
    });
});
