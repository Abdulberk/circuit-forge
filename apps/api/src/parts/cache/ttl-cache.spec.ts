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
});
