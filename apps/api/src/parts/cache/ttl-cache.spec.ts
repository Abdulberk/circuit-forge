import { TtlCache } from './ttl-cache';

describe('TtlCache', () => {
    it('caches within TTL', async () => {
        const cache = new TtlCache();
        const loader = jest.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b');
        expect(await cache.getOrLoad('k', 1000, loader)).toBe('a');
        expect(await cache.getOrLoad('k', 1000, loader)).toBe('a');
        expect(loader).toHaveBeenCalledTimes(1);
    });

    it('reloads after TTL expiry', async () => {
        const cache = new TtlCache();
        const loader = jest.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b');
        expect(await cache.getOrLoad('k', 5, loader)).toBe('a');
        await new Promise((r) => setTimeout(r, 25));
        expect(await cache.getOrLoad('k', 5, loader)).toBe('b');
        expect(loader).toHaveBeenCalledTimes(2);
    });

    it('single-flights concurrent loads (one loader call)', async () => {
        const cache = new TtlCache();
        let calls = 0;
        const loader = () =>
            new Promise<string>((r) => {
                calls++;
                setTimeout(() => r('x'), 10);
            });
        const results = await Promise.all([
            cache.getOrLoad('k', 1000, loader),
            cache.getOrLoad('k', 1000, loader),
            cache.getOrLoad('k', 1000, loader),
        ]);
        expect(results).toEqual(['x', 'x', 'x']);
        expect(calls).toBe(1);
    });

    it('evicts oldest entries beyond the size cap', async () => {
        const cache = new TtlCache();
        for (let i = 0; i < 1100; i++) {
            await cache.getOrLoad('k' + i, 60_000, async () => i);
        }
        // k0 was inserted first and should have been evicted past the 1000-entry cap → reloads.
        const loader = jest.fn().mockResolvedValue('reloaded');
        expect(await cache.getOrLoad('k0', 60_000, loader)).toBe('reloaded');
        expect(loader).toHaveBeenCalledTimes(1);
    });
});
