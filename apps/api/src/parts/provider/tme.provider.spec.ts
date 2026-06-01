import { TmeProvider } from './tme.provider';
import type { TmeClient } from '../tme/tme-client';

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
