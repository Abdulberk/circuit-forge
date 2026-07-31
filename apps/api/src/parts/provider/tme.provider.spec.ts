import type { TmeClient } from '../tme/tme-client';

import { TmeProvider } from './tme.provider';

/** Minimal TmeClient stub exposing just what TmeProvider.getManufacturers touches. */
function makeClient(
    manufacturers: Array<{ id: number; name: string; products_count?: number }>,
    maxManufacturers: number,
): TmeClient {
    return {
        defaults: { country: 'PL', language: 'en', currency: 'EUR', maxManufacturers },
        get: async () => ({ manufacturers: { elements: manufacturers } }),
    } as unknown as TmeClient;
}

describe('TmeProvider.getManufacturers', () => {
    it('sorts by product count DESC then caps — keeps the largest, not an arbitrary slice', async () => {
        // Deliberately unsorted input + a cap smaller than the list: the old bug (slice-before-sort)
        // would keep [Small, Huge] (input order); the fix keeps the top-2 by count [Huge, Mid].
        const client = makeClient(
            [
                { id: 1, name: 'Small', products_count: 10 },
                { id: 2, name: 'Huge', products_count: 1000 },
                { id: 3, name: 'Mid', products_count: 100 },
            ],
            2,
        );
        const result = await new TmeProvider(client).getManufacturers();
        expect(result.map((m) => m.name)).toEqual(['Huge', 'Mid']);
        expect(result).toHaveLength(2);
    });

    it('returns the full sorted list when under the cap', async () => {
        const client = makeClient(
            [
                { id: 1, name: 'A', products_count: 5 },
                { id: 2, name: 'B', products_count: 50 },
            ],
            5000,
        );
        const result = await new TmeProvider(client).getManufacturers();
        expect(result.map((m) => m.name)).toEqual(['B', 'A']);
        expect(result).toHaveLength(2);
    });
});

/** One routed endpoint: a literal response body, or a thunk (so a route can reject on demand). */
type Route = Record<string, unknown> | (() => Promise<unknown>);

/** A client that records the queries it was asked for and answers each endpoint from a table. */
function makeRoutedClient(
    routes: Record<string, Route>,
    maxManufacturers = 5000,
): { client: TmeClient; calls: Array<{ path: string; query: Record<string, unknown> }> } {
    const calls: Array<{ path: string; query: Record<string, unknown> }> = [];
    const client = {
        defaults: { country: 'PL', language: 'en', currency: 'EUR', maxManufacturers },
        get: async (path: string, query: Record<string, unknown> = {}) => {
            calls.push({ path, query });
            const route = routes[path];
            if (typeof route === 'function') return (route as () => Promise<unknown>)();
            if (route === undefined) throw new Error(`unrouted path ${path}`);
            return route;
        },
    } as unknown as TmeClient;
    return { client, calls };
}

const SEARCH_EL = {
    symbol: 'NE555P',
    manufacturer: 'TI',
    description: 'timer',
    manufacturer_symbols: ['NE555P'],
    category_id: 100,
    category: 'ICs',
};

describe('TmeProvider.search', () => {
    it('sends the NORMALIZED page upstream, not the raw one', async () => {
        // These used to diverge: the response reported the clamped page while the raw value went to TME.
        // Safe today only because the DTO refuses anything below 1 — a service must not depend on its
        // caller happening to be careful.
        const { client, calls } = makeRoutedClient({ '/products/search': { products: { elements: [], amount: 0 } } });
        const r = await new TmeProvider(client).search({ q: 'x', page: 0 });
        expect(calls[0]!.query.page).toBe(1);
        expect(r.page).toBe(1);
    });

    it('reports how many items THIS page returned, not a page capacity', async () => {
        // A short final page is normal. The field used to be called pageSize, so a caller paging on it
        // would read a 1-item last page as "the page size shrank" and could stop early.
        const { client } = makeRoutedClient({
            '/products/search': { products: { elements: [SEARCH_EL], amount: 41 } },
        });
        const r = await new TmeProvider(client).search({ q: 'NE555', page: 3 });
        expect(r).toMatchObject({ page: 3, returned: 1, total: 41 });
        expect(r.items).toHaveLength(1);
    });

    it('an empty result set is a result, not an error', async () => {
        const { client } = makeRoutedClient({ '/products/search': {} }); // TME omits `products` entirely
        const r = await new TmeProvider(client).search({ q: 'zzzz' });
        expect(r).toMatchObject({ items: [], page: 1, returned: 0 });
    });
});

describe('TmeProvider.getCategories', () => {
    it('returns the top-level children of the synthetic root', async () => {
        const { client } = makeRoutedClient({
            '/products/categories/tree': {
                elements: {
                    id: 0,
                    name: 'root',
                    children: [
                        { id: 1, name: 'Passives', total_products: 10, children: [] },
                        { id: 2, name: 'Semis', total_products: 20, children: [] },
                    ],
                },
            },
        });
        const cats = await new TmeProvider(client).getCategories();
        expect(cats.map((c) => c.name)).toEqual(['Passives', 'Semis']);
    });

    it('a missing root is reported as empty, never as a crash', async () => {
        const { client } = makeRoutedClient({ '/products/categories/tree': {} });
        await expect(new TmeProvider(client).getCategories()).resolves.toEqual([]);
    });
});

describe('TmeProvider.getProduct — a failed enrichment lookup is recorded, never swallowed', () => {
    const routesWithAll = () => ({
        '/products/search': { products: { elements: [SEARCH_EL] } },
        '/products/parameters': { elements: [{ symbol: 'NE555P', parameters: { elements: [] } }] },
        '/products/data': {
            elements: [{ symbol: 'NE555P', stock_quantity: 42, prices: { currency: 'EUR', elements: [] } }],
        },
        '/products/files': { elements: [{ symbol: 'NE555P', documents: { elements: [] } }] },
    });

    it('a part whose lookups all answered carries no `unavailable` flag', async () => {
        const { client } = makeRoutedClient(routesWithAll());
        const part = await new TmeProvider(client).getProduct('NE555P');
        expect(part.unavailable).toBeUndefined();
        expect(part.stock).toBe(42);
    });

    it('a pricing failure is NAMED — "no price" and "could not ask" must not look the same', async () => {
        // The defect: this returned a part with no price and no stock, indistinguishable from a part the
        // supplier genuinely does not price. A sourcing decision would be made on a blip.
        const routes = { ...routesWithAll(), '/products/data': () => Promise.reject(new Error('502 upstream')) };
        const { client } = makeRoutedClient(routes);
        const part = await new TmeProvider(client).getProduct('NE555P');
        expect(part.unavailable).toEqual(['pricing']);
        expect(part.stock).toBeUndefined();
        expect(part.mpn).toBe('NE555P'); // still usable — degraded, not failed
    });

    it('a parameters failure is NAMED — it is the one that silently costs tolerance and footprint', async () => {
        // Tolerance and footprint both come from parameters. Losing them silently drops the part out of the
        // Monte-Carlo spread and drops it back to the default power rating, with nothing to notice.
        const routes = { ...routesWithAll(), '/products/parameters': () => Promise.reject(new Error('timeout')) };
        const { client } = makeRoutedClient(routes);
        const part = await new TmeProvider(client).getProduct('NE555P');
        expect(part.unavailable).toEqual(['parameters']);
        expect(part.parameters).toEqual([]);
        expect(part.footprint).toBeUndefined();
    });

    it('records EVERY lookup that failed, not just the first', async () => {
        const routes = {
            ...routesWithAll(),
            '/products/parameters': () => Promise.reject(new Error('a')),
            '/products/data': () => Promise.reject(new Error('b')),
            '/products/files': () => Promise.reject(new Error('c')),
        };
        const { client } = makeRoutedClient(routes);
        const part = await new TmeProvider(client).getProduct('NE555P');
        expect(part.unavailable!.sort()).toEqual(['documents', 'parameters', 'pricing']);
    });

    it('the BASE lookup is not best-effort — its failure surfaces', async () => {
        // Degrading on the primary record would invent a part out of nothing.
        const routes = { ...routesWithAll(), '/products/search': () => Promise.reject(new Error('502')) };
        const { client } = makeRoutedClient(routes);
        await expect(new TmeProvider(client).getProduct('NE555P')).rejects.toThrow('502');
    });
});
