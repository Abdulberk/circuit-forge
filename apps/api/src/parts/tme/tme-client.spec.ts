import { ConfigService } from '@nestjs/config';
import { TmeClient } from './tme-client';
import { TmeApiError } from './tme-errors';
import type { TmeTokenCache } from './tme-token-cache';

function cfg(): ConfigService {
    const values: Record<string, string> = {
        TME_TOKEN: 't',
        TME_SECRET: 's',
        TME_BASE_URL: 'https://api.tme.eu',
        TME_DEFAULT_LANGUAGE: 'en',
        TME_MAX_CONCURRENCY: '4',
    };
    return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function tokens(): TmeTokenCache {
    return { getToken: jest.fn().mockResolvedValue('bearer'), invalidate: jest.fn() } as unknown as TmeTokenCache;
}

function ok(data: unknown) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'OK', data }) };
}

describe('TmeClient', () => {
    const realFetch = global.fetch;
    afterEach(() => {
        global.fetch = realFetch;
        jest.clearAllMocks();
    });

    it('unwraps the { status: "OK", data } envelope', async () => {
        global.fetch = jest.fn().mockResolvedValue(ok({ x: 1 })) as unknown as typeof fetch;
        const client = new TmeClient(cfg(), tokens());
        await expect(client.get('/products/x')).resolves.toEqual({ x: 1 });
    });

    it('encodes array params PHP-style (scope[0]=...)', async () => {
        const fetchMock = jest.fn().mockResolvedValue(ok({}));
        global.fetch = fetchMock as unknown as typeof fetch;
        const client = new TmeClient(cfg(), tokens());
        await client.get('/products/search', { phrase: 'NE555', scope: ['products', 'parameters'] });
        const url = fetchMock.mock.calls[0][0] as string;
        expect(url).toContain('phrase=NE555');
        expect(url).toContain('scope[0]=products');
        expect(url).toContain('scope[1]=parameters');
    });

    it('throws TmeApiError on an E_ error envelope', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 400,
            text: async () => JSON.stringify({ code: 'E_INPUT_PARAMS_VALIDATION_ERROR', message: 'bad' }),
        }) as unknown as typeof fetch;
        const client = new TmeClient(cfg(), tokens());
        await expect(client.get('/x')).rejects.toBeInstanceOf(TmeApiError);
    });

    it('invalidates token and retries once on 401', async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce({ ok: false, status: 401, text: async () => '{}' })
            .mockResolvedValueOnce(ok({ ok: true }));
        global.fetch = fetchMock as unknown as typeof fetch;
        const tok = tokens();
        const client = new TmeClient(cfg(), tok);
        await expect(client.get('/x')).resolves.toEqual({ ok: true });
        expect(tok.invalidate).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
