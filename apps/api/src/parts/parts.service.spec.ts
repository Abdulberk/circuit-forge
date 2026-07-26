import type { ConfigService } from '@nestjs/config';

import { TtlCache } from './cache/ttl-cache';
import type { ComponentMapper } from './mappers/component-mapper';
import { PartsService } from './parts.service';
import type { CatalogPart, PartProvider } from './provider/part-provider.interface';

/** Minimal real-ish part; the mapper is stubbed so its exact shape doesn't matter. */
const PART = {
    mpn: 'WR06X1002FTL',
    supplierId: 'WR06X1002FTL',
    manufacturer: 'WALSIN',
    parameters: [],
    priceBreaks: [],
    supplier: 'tme',
} as unknown as CatalogPart;

function config(): ConfigService {
    const v: Record<string, string> = { TME_PRODUCT_TTL_MS: '300000' };
    return { get: (k: string) => v[k] } as unknown as ConfigService;
}

describe('PartsService product caching', () => {
    function setup() {
        const provider = { getProduct: jest.fn().mockResolvedValue(PART) } as unknown as PartProvider;
        const mapper = { toComponent: jest.fn().mockReturnValue({ simulatable: true }) } as unknown as ComponentMapper;
        const svc = new PartsService(provider, new TtlCache(), config(), mapper);
        return { svc, provider, mapper };
    }

    it('caches getProduct: repeated lookups of the same symbol hit TME once', async () => {
        const { svc, provider } = setup();
        await svc.getProduct('WR06X1002FTL');
        await svc.getProduct('WR06X1002FTL');
        expect(provider.getProduct).toHaveBeenCalledTimes(1); // second served from cache — no extra TME hit
    });

    it('getComponent reuses the cached getProduct fetch', async () => {
        const { svc, provider, mapper } = setup();
        await svc.getProduct('WR06X1002FTL'); // warms the cache
        const comp = await svc.getComponent('WR06X1002FTL'); // must NOT re-fetch
        expect(provider.getProduct).toHaveBeenCalledTimes(1);
        expect(mapper.toComponent).toHaveBeenCalledWith(PART);
        expect(comp).toEqual({ simulatable: true });
    });

    it('fetches distinct symbols independently', async () => {
        const { svc, provider } = setup();
        await svc.getProduct('WR06X1002FTL');
        await svc.getProduct('CRCW060310K0FKTABC');
        expect(provider.getProduct).toHaveBeenCalledTimes(2);
    });

    it('rejects an invalid symbol before touching the provider', async () => {
        const { svc, provider } = setup();
        await expect(svc.getProduct('bad symbol!')).rejects.toThrow();
        expect(provider.getProduct).not.toHaveBeenCalled();
    });
});
