import { ConfigService } from '@nestjs/config';

import { TmeTokenCache } from './tme-token-cache';

function cfg(overrides: Record<string, string> = {}): ConfigService {
    const values: Record<string, string> = {
        TME_TOKEN: 't',
        TME_SECRET: 's',
        TME_BASE_URL: 'https://api.tme.eu',
        ...overrides,
    };
    return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function tokenResponse(token: string, expiresIn = 300, delayMs = 0) {
    return jest.fn().mockImplementation(
        () =>
            new Promise((resolve) => {
                setTimeout(
                    () =>
                        resolve({
                            ok: true,
                            status: 200,
                            text: async () =>
                                JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: expiresIn }),
                        }),
                    delayMs,
                );
            }),
    );
}

describe('TmeTokenCache', () => {
    const realFetch = global.fetch;
    afterEach(() => {
        global.fetch = realFetch;
        jest.clearAllMocks();
    });

    it('fetches once and caches the token', async () => {
        const fetchMock = tokenResponse('tok1');
        global.fetch = fetchMock as unknown as typeof fetch;
        const cache = new TmeTokenCache(cfg());
        expect(await cache.getToken()).toBe('tok1');
        expect(await cache.getToken()).toBe('tok1');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('single-flights concurrent getToken calls (one request)', async () => {
        const fetchMock = tokenResponse('tok2', 300, 15);
        global.fetch = fetchMock as unknown as typeof fetch;
        const cache = new TmeTokenCache(cfg());
        const results = await Promise.all([cache.getToken(), cache.getToken(), cache.getToken()]);
        expect(results).toEqual(['tok2', 'tok2', 'tok2']);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('re-authenticates after invalidate()', async () => {
        const fetchMock = tokenResponse('tok3');
        global.fetch = fetchMock as unknown as typeof fetch;
        const cache = new TmeTokenCache(cfg());
        await cache.getToken();
        cache.invalidate();
        await cache.getToken();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws TmeApiError on auth failure', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 403,
            text: async () => JSON.stringify({ code: 'E_AUTHORIZATION_FAILED', message: 'denied' }),
        }) as unknown as typeof fetch;
        const cache = new TmeTokenCache(cfg());
        await expect(cache.getToken()).rejects.toMatchObject({ name: 'TmeApiError', httpStatus: 403 });
    });
});
