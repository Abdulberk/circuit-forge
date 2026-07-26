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

/** A non-OK response carrying an error envelope + an optional Retry-After header. */
function err(status: number, body: unknown, retryAfter?: string) {
    return {
        ok: false,
        status,
        text: async () => JSON.stringify(body),
        headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null) },
    };
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

    it('retries a 429 rate-limit (honouring Retry-After) then succeeds', async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(err(429, { code: 'E_HTTP_429', message: 'rate limited' }, '0')) // Retry-After: 0s
            .mockResolvedValueOnce(ok({ ok: true }));
        global.fetch = fetchMock as unknown as typeof fetch;
        const client = new TmeClient(cfg(), tokens());
        await expect(client.get('/x')).resolves.toEqual({ ok: true });
        expect(fetchMock).toHaveBeenCalledTimes(2); // one 429, one retry that succeeded
    });

    it('gives up with TmeApiError after exhausting retries on a persistent 429', async () => {
        const fetchMock = jest.fn().mockResolvedValue(err(429, { code: 'E_HTTP_429', message: 'rate limited' }, '0'));
        global.fetch = fetchMock as unknown as typeof fetch;
        const client = new TmeClient(cfg(), tokens()); // default TME_MAX_RETRIES = 3
        await expect(client.get('/x')).rejects.toBeInstanceOf(TmeApiError);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('clamps a huge Retry-After (never parks the request for the server-specified hour)', async () => {
        // Record every scheduled delay and fire it immediately so the test doesn't actually wait.
        const delays: number[] = [];
        const realSetTimeout = global.setTimeout;
        (global as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number) => {
            delays.push(ms ?? 0);
            return realSetTimeout(fn, 0);
        }) as unknown as typeof setTimeout;
        try {
            const fetchMock = jest
                .fn()
                .mockResolvedValueOnce(err(429, { code: 'E_HTTP_429', message: 'rate limited' }, '3600')) // Retry-After: 1 hour
                .mockResolvedValueOnce(ok({ ok: true }));
            global.fetch = fetchMock as unknown as typeof fetch;
            const client = new TmeClient(cfg(), tokens());
            await expect(client.get('/x')).resolves.toEqual({ ok: true });
            // The 10000ms entries are the per-fetch abort timers; the retry wait is everything else and
            // must be clamped to the cap (5000ms), NOT the server's 3_600_000ms.
            const retryWaits = delays.filter((d) => d !== 10000);
            expect(Math.max(...retryWaits)).toBeLessThanOrEqual(5000);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        } finally {
            global.setTimeout = realSetTimeout;
        }
    });

    it('does NOT retry a 4xx (e.g. WAF 403) — deterministic, handled one layer up', async () => {
        const fetchMock = jest.fn().mockResolvedValue(err(403, { code: 'E_HTTP_403', message: 'blocked' }));
        global.fetch = fetchMock as unknown as typeof fetch;
        const client = new TmeClient(cfg(), tokens());
        await expect(client.get('/x')).rejects.toBeInstanceOf(TmeApiError);
        expect(fetchMock).toHaveBeenCalledTimes(1); // no retry on a non-transient 4xx
    });
});
