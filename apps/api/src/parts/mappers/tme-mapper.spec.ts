import {
    absoluteUrl,
    datasheetFromFiles,
    footprintFromParameters,
    mapCategoryNode,
    mapManufacturer,
    mapParameters,
    mapPriceBreaks,
    mapSearchElementToPart,
} from './tme-mapper';

describe('tme-mapper', () => {
    it('makes protocol-relative URLs absolute https', () => {
        expect(absoluteUrl('//cdn/x.jpg')).toBe('https://cdn/x.jpg');
        expect(absoluteUrl('https://cdn/x.jpg')).toBe('https://cdn/x.jpg');
        expect(absoluteUrl(undefined)).toBeUndefined();
    });

    it('maps a search element (mpn from manufacturer_symbols, absolute photo)', () => {
        const part = mapSearchElementToPart({
            symbol: 'NE555P',
            manufacturer_symbols: ['NE555P'],
            manufacturer: { id: 77, name: 'TEXAS INSTRUMENTS' },
            description: 'timer',
            category: { id: 1, name: 'Watchdog' },
            assets: { primary_photo: { thumbnail: '//cdn/x.jpg' } },
        });
        expect(part.mpn).toBe('NE555P');
        expect(part.manufacturer).toBe('TEXAS INSTRUMENTS');
        expect(part.category).toBe('Watchdog');
        expect(part.categoryId).toBe('1'); // stable id carried for classification
        expect(part.photo).toBe('https://cdn/x.jpg');
        expect(part.supplier).toBe('tme');
        expect(part.supplierId).toBe('NE555P');
    });

    it('falls back mpn to symbol when manufacturer_symbols is empty', () => {
        expect(mapSearchElementToPart({ symbol: 'X1' }).mpn).toBe('X1');
    });

    it('flattens parameters and finds the Case footprint', () => {
        const params = mapParameters({
            symbol: 'R',
            parameters: {
                elements: [
                    { id: 35, name: 'Case', values: [{ id: 1, value: '0603' }] },
                    { id: 1, name: 'Resistance', values: [{ id: 2, value: '10k' }] },
                    {
                        id: 2,
                        name: 'Kind',
                        values: [
                            { id: 3, value: 'a' },
                            { id: 4, value: 'b' },
                        ],
                    },
                ],
            },
        });
        expect(params).toEqual([
            { name: 'Case', value: '0603' },
            { name: 'Resistance', value: '10k' },
            { name: 'Kind', value: 'a, b' },
        ]);
        expect(footprintFromParameters(params)).toBe('0603');
    });

    it('extracts footprint from "Case" (prefers inch; ignores "Kind of package" packaging)', () => {
        expect(
            footprintFromParameters([
                { name: 'Case - mm', value: '1608' },
                { name: 'Case - inch', value: '0603' },
                { name: 'Resistance', value: '10kΩ' },
            ]),
        ).toBe('0603');
        // "Kind of package" (bulk/tape/reel) must NOT win over the real "Case" footprint.
        expect(
            footprintFromParameters([
                { name: 'Kind of package', value: 'bulk, tape' },
                { name: 'Case', value: 'DO35' },
            ]),
        ).toBe('DO35');
        expect(footprintFromParameters([{ name: 'Resistance', value: '10k' }])).toBeUndefined();
    });

    it('maps price breaks, stock and unit cost (qty 1)', () => {
        const r = mapPriceBreaks(
            {
                symbol: 'x',
                stock_quantity: 100,
                prices: {
                    currency: 'EUR',
                    elements: [
                        { amount: 1, price: 0.44 },
                        { amount: 10, price: 0.33 },
                    ],
                },
            },
            'PLN',
        );
        expect(r.stock).toBe(100);
        expect(r.unitCost).toBe(0.44);
        expect(r.currency).toBe('EUR');
        expect(r.priceBreaks).toHaveLength(2);
        expect(r.priceBreaks.every((b) => b.currency === 'EUR')).toBe(true);
    });

    it('falls back to the provided currency when a tier lacks one (never empty string)', () => {
        const r = mapPriceBreaks({ symbol: 'x', prices: { elements: [{ amount: 1, price: 1 }] } }, 'EUR');
        expect(r.currency).toBe('EUR');
        expect(r.priceBreaks[0]?.currency).toBe('EUR');
    });

    it('picks a PDF datasheet (English preferred)', () => {
        const url = datasheetFromFiles({
            symbol: 'x',
            documents: {
                elements: [
                    { url: '//d/link.txt', type: 'LNK', file_name: 'link.txt', language: 'EN' },
                    { url: '//d/ne555.pdf', type: 'DTE', file_name: 'ne555.pdf', language: 'EN' },
                ],
            },
        });
        expect(url).toBe('https://d/ne555.pdf');
    });

    it('maps manufacturer and category nodes', () => {
        expect(mapManufacturer({ id: 36, name: 'VISHAY', products_count: 60627 })).toEqual({
            id: '36',
            name: 'VISHAY',
            productsCount: 60627,
        });
        const node = mapCategoryNode({
            id: 1,
            parent_id: 1,
            products_count: 5,
            children: [{ id: 2, parent_id: 1, name: 'Sub', products_count: 3, children: [] }],
        });
        expect(node.parentId).toBeNull();
        expect(node.children[0]).toMatchObject({ id: '2', parentId: '1', name: 'Sub', productsCount: 3 });
    });
});
