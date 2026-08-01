/**
 * The client, under the conditions that actually break clients.
 *
 * Every test here is a race or a failure mode that a manual click-through cannot produce: several requests
 * expiring at the same instant, a response that arrives after its component is gone, a body that is empty.
 * These are the bugs that ship, because the only way to meet them by hand is to be unlucky at the right
 * moment — and the only way to meet them on purpose is this.
 *
 * The server is a function, not a mocking framework: it records what it was asked and answers. A stubbed
 * `fetch` that returns a fixed value cannot show that the SECOND refresh never happened, and that is the
 * whole assertion.
 */
import { ApiClient } from './client';
import { ApiError } from './errors';
import { memoryTokenStore } from './tokens';

type Handler = (url: URL, init: RequestInit) => Promise<Response> | Response;

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A slow response that HONOURS the signal.
 *
 * The first version of this helper just slept and returned, ignoring `init.signal` — so aborting did
 * nothing, the request resolved, and the two cancellation tests failed against correct code. A fake server
 * that ignores cancellation cannot be used to test cancellation; it only proves the fake is unfaithful.
 */
const slow = (ms: number, then: () => Response) => (_url: URL, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
        const signal = init.signal;
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve(then());
        }, ms);
        function onAbort() {
            clearTimeout(timer);
            // Exactly what a real `fetch` does when its signal fires.
            reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });

/** Install a fetch implementation and record every call. */
function server(handler: Handler) {
    const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
    const impl = async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(String(input));
        const headers = new Headers(init.headers);
        calls.push({
            url: url.pathname,
            method: init.method ?? 'GET',
            body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
            auth: headers.get('authorization'),
        });
        return handler(url, init);
    };
    global.fetch = impl as unknown as typeof fetch;
    return {
        calls,
        countTo: (path: string) => calls.filter((c) => c.url === path).length,
    };
}

const clientWith = (tokens = { accessToken: 'access-1', refreshToken: 'refresh-1' }, onSessionLost?: () => void) => {
    const store = memoryTokenStore(tokens);
    return {
        store,
        client: new ApiClient({ baseUrl: 'http://api.test', store, onSessionLost, timeoutMs: 2_000 }),
    };
};

describe('an expired session under concurrency', () => {
    it('refreshes ONCE for many simultaneous 401s, and every caller succeeds', async () => {
        // The bug this locks: refreshing per-401 sends N refreshes with the same token. The API rotates on
        // use, so the first succeeds and the rest present a token the server has retired — reported to the
        // user as being randomly signed out, and impossible to reproduce by clicking.
        const { client, store } = clientWith();
        const net = server(async (url, init) => {
            if (url.pathname === '/auth/refresh') {
                await new Promise((r) => setTimeout(r, 20)); // a real refresh is not instant
                return json(200, { accessToken: 'access-2', refreshToken: 'refresh-2' });
            }
            const auth = new Headers(init.headers).get('authorization');
            return auth === 'Bearer access-2' ? json(200, { ok: url.pathname }) : json(401, { message: 'expired' });
        });

        const paths = ['/orgs', '/projects/a', '/projects/b', '/layouts', '/versions/v1'];
        const results = await Promise.all(paths.map((p) => client.request<{ ok: string }>(p)));

        expect(results.map((r) => r.ok)).toEqual(paths);
        expect(net.countTo('/auth/refresh')).toBe(1);
        expect(store.read()).toEqual({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    });

    it('refreshes again on a LATER expiry — the shared promise is not left behind', async () => {
        // If the in-flight promise were cached rather than cleared, the second expiry would reuse a token
        // that has already been rotated away, and the app would be stuck signed out until reload.
        // The server accepts only `access-<generation>`; bumping the counter expires whatever the client
        // holds. It starts at 2 so the FIRST request is already stale — an earlier version of this test began
        // at 1, so the opening call succeeded outright and only one refresh ever happened.
        let generation = 2;
        const { client } = clientWith();
        const net = server(async (url, init) => {
            if (url.pathname === '/auth/refresh') {
                return json(200, { accessToken: `access-${generation}`, refreshToken: `refresh-${generation}` });
            }
            const auth = new Headers(init.headers).get('authorization');
            return auth === `Bearer access-${generation}` ? json(200, {}) : json(401, { message: 'expired' });
        });

        await client.request('/first');
        generation += 1; // the server expires the token it just issued
        await client.request('/second');

        expect(net.countTo('/auth/refresh')).toBe(2);
    });

    it('stops after one retry rather than looping when the fresh token is also refused', async () => {
        const { client, store } = clientWith();
        const lost = jest.fn();
        const c = new ApiClient({ baseUrl: 'http://api.test', store, onSessionLost: lost, timeoutMs: 2_000 });
        const net = server((url) =>
            url.pathname === '/auth/refresh'
                ? json(200, { accessToken: 'access-2', refreshToken: 'refresh-2' })
                : json(401, { message: 'nope' }),
        );

        await expect(c.request('/orgs')).rejects.toMatchObject({ kind: 'unauthenticated' });
        // Two attempts at the resource, one refresh. A missing terminal guard shows up here as a hang.
        expect(net.countTo('/orgs')).toBe(2);
        expect(net.countTo('/auth/refresh')).toBe(1);
        expect(store.read()).toBeNull();
        expect(lost).toHaveBeenCalled();
        expect(client).toBeDefined();
    });

    it('ends the session when the refresh token itself is rejected', async () => {
        const lost = jest.fn();
        const { client, store } = clientWith(undefined, lost);
        server((url) => (url.pathname === '/auth/refresh' ? json(401, { message: 'revoked' }) : json(401, {})));

        await expect(client.request('/orgs')).rejects.toBeInstanceOf(ApiError);
        expect(store.read()).toBeNull();
        expect(lost).toHaveBeenCalledTimes(1);
    });

    it('fails without a round trip when there is no session at all', async () => {
        const { client } = clientWith();
        client.store.clear();
        const net = server(() => json(200, {}));

        await expect(client.request('/orgs')).rejects.toMatchObject({ kind: 'unauthenticated' });
        expect(net.calls).toHaveLength(0);
    });
});

describe('cancellation is not failure', () => {
    it('reports an aborted request as aborted, never as a network error', async () => {
        // React 19 strict mode mounts every effect twice in development, so this happens on the first render
        // of every screen. Misclassified, the app opens with an error banner it caused itself.
        const { client } = clientWith();
        server(slow(500, () => json(200, {})));

        const controller = new AbortController();
        const pending = client.request('/orgs', { signal: controller.signal });
        controller.abort();

        await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    });

    it('reports its own timeout as a network failure, with the budget named', async () => {
        const store = memoryTokenStore({ accessToken: 'a', refreshToken: 'r' });
        const client = new ApiClient({ baseUrl: 'http://api.test', store, timeoutMs: 40 });
        server(slow(400, () => json(200, {})));

        await expect(client.request('/orgs')).rejects.toMatchObject({
            kind: 'network',
            message: expect.stringContaining('40 ms'),
        });
    });

    it('leaves no abort listener on a caller signal that outlives the request', async () => {
        // A page that polls holds ONE signal across hundreds of requests. A listener added per request and
        // never removed is a leak that grows for as long as the tab is open.
        const { client } = clientWith();
        server(() => json(200, {}));

        const controller = new AbortController();
        let live = 0;
        const add = controller.signal.addEventListener.bind(controller.signal);
        const remove = controller.signal.removeEventListener.bind(controller.signal);
        controller.signal.addEventListener = ((...a: Parameters<typeof add>) => {
            live += 1;
            return add(...a);
        }) as typeof add;
        controller.signal.removeEventListener = ((...a: Parameters<typeof remove>) => {
            live -= 1;
            return remove(...a);
        }) as typeof remove;

        for (let i = 0; i < 50; i++) await client.request('/orgs', { signal: controller.signal });
        expect(live).toBe(0);
    });
});

describe('reading a response', () => {
    it('accepts an empty body instead of failing on JSON that is not there', async () => {
        // DELETE and logout answer 204. `response.json()` throws on an empty body, and the resulting
        // "Unexpected end of JSON input" would be reported as a server fault on a call that succeeded.
        const { client } = clientWith();
        server(() => new Response(null, { status: 204 }));

        await expect(client.request('/projects/x/working-copy', { method: 'DELETE' })).resolves.toBeUndefined();
    });

    it('classifies each status by the recovery it needs, and keeps the API code', async () => {
        const cases: Array<[number, string]> = [
            [400, 'invalid'],
            [403, 'forbidden'],
            [404, 'not-found'],
            [409, 'conflict'],
            [429, 'throttled'],
            [500, 'server'],
            [418, 'unexpected'],
        ];
        for (const [status, kind] of cases) {
            const { client } = clientWith();
            server(() => json(status, { message: 'no', code: 'WORKING_COPY_CONFLICT' }));
            await expect(client.request('/x')).rejects.toMatchObject({ kind, status, code: 'WORKING_COPY_CONFLICT' });
        }
    });

    it('keeps every validation message rather than flattening them into one line', async () => {
        // A form puts each message next to its own field; a joined string cannot be taken apart again.
        const { client } = clientWith();
        server(() => json(400, { message: ['name must not be empty', 'orgId must be a UUID'] }));

        const err = (await client.request('/projects').catch((e: unknown) => e)) as ApiError;
        expect(err.details).toEqual(['name must not be empty', 'orgId must be a UUID']);
        expect(err.message).toBe('name must not be empty');
    });

    it('marks a conflict as NOT retryable — the precondition is known false', async () => {
        const { client } = clientWith();
        server(() => json(409, { message: 'changed', code: 'WORKING_COPY_CONFLICT' }));

        const err = (await client.request('/x', { method: 'PUT' }).catch((e: unknown) => e)) as ApiError;
        expect(err.retryable).toBe(false);
        expect(new ApiError('network', 'x').retryable).toBe(true);
    });
});

describe('signing out', () => {
    it('clears the local session even when the server call fails', async () => {
        // The alternative leaves a user who pressed "sign out" still signed in, which is the worse failure.
        const { client, store } = clientWith();
        server(() => {
            throw new TypeError('offline');
        });

        await client.signOut();
        expect(store.read()).toBeNull();
    });
});
