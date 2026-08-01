/**
 * The one way the studio talks to the API.
 *
 * Two things here are load-bearing, and both are about failures that only appear under concurrency — the
 * kind that never reproduce in a click-through and are then blamed on "the network".
 *
 * SINGLE-FLIGHT REFRESH. The API rotates refresh tokens: using one invalidates it and issues a new pair. An
 * editor opens a project by firing several requests at once, so an expired access token produces several
 * 401s at the same instant. A client that refreshes per 401 sends N refreshes with the SAME token; the first
 * rotates it and the rest present a token the server has already retired, so they fail — and because the
 * failure is a 401 on a refresh, the natural handling is to log the user out. The bug reads as "it randomly
 * signs me out", which is exactly the report nobody can reproduce. So a refresh is a single shared promise:
 * the first 401 starts it, every other 401 awaits the same one, and all of them retry with one new token.
 *
 * ABORT IS NOT AN ERROR. Every request composes the caller's signal with a timeout. A component that
 * unmounts aborts its work, and that must arrive as `kind: 'aborted'`, not as a red banner — an editor
 * re-renders constantly, so treating cancellation as failure means the UI is permanently full of errors it
 * caused itself.
 */
import { ApiError, describeBody, kindForStatus } from './errors';
import { browserTokenStore, type TokenStore, type Tokens } from './tokens';

export interface ApiClientOptions {
    baseUrl: string;
    store?: TokenStore;
    /** Ceiling on a single request. LRO polling uses many short requests, never one long one. */
    timeoutMs?: number;
    /** Called whenever the session is lost, so the shell can route to sign-in from one place. */
    onSessionLost?: () => void;
}

interface RequestOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    signal?: AbortSignal;
    /** Set false for the endpoints that must not carry a bearer token (login, register, refresh). */
    authenticated?: boolean;
    query?: Record<string, string | number | boolean | undefined>;
}

/**
 * Combine signals with explicit teardown.
 *
 * `AbortSignal.any` does this natively but only landed in Safari 17.4, and a client that throws
 * `AbortSignal.any is not a function` on an older browser fails in a way that looks like the API is down.
 * The listeners are removed in `release`, which every caller runs in a `finally` — an abort listener left on
 * a long-lived caller signal is a leak that grows with every request the editor makes.
 */
function combineSignals(signals: AbortSignal[]): { signal: AbortSignal; release: () => void } {
    const controller = new AbortController();
    const onAbort = (e: Event) => controller.abort((e.target as AbortSignal).reason);
    const already = signals.find((s) => s.aborted);
    if (already) {
        controller.abort(already.reason);
        return { signal: controller.signal, release: () => {} };
    }
    for (const s of signals) s.addEventListener('abort', onAbort);
    return {
        signal: controller.signal,
        release: () => {
            for (const s of signals) s.removeEventListener('abort', onAbort);
        },
    };
}

export class ApiClient {
    private readonly baseUrl: string;
    private readonly timeoutMs: number;
    private readonly onSessionLost?: () => void;
    readonly store: TokenStore;

    /** The in-flight refresh, shared by every request that hits a 401 while it runs. */
    private refreshing: Promise<Tokens> | null = null;

    constructor(options: ApiClientOptions) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
        this.store = options.store ?? browserTokenStore();
        this.timeoutMs = options.timeoutMs ?? 30_000;
        this.onSessionLost = options.onSessionLost;
    }

    get authenticated(): boolean {
        return this.store.read() !== null;
    }

    /**
     * End the session, at most once per session.
     *
     * Edge-triggered, not level-triggered. One expiry reaches three places that each know the session is
     * gone: the refresh call's own 401, the catch around it, and the original request's 401 falling through.
     * Firing the callback from each would route to sign-in three times for one event — and a callback that
     * says "this happened" when it did not is how a UI ends up with three toasts and a doubled navigation.
     * Clearing an already-empty store is the signal that this is a repeat.
     */
    private endSession(): void {
        if (this.store.read() === null) return;
        this.store.clear();
        this.onSessionLost?.();
    }

    /**
     * Perform a request, refreshing once if the access token has expired.
     *
     * `retried` makes the retry terminal: if the server still answers 401 with a token it has just issued,
     * the problem is not staleness, and looping would turn one bad session into an infinite request storm.
     */
    async request<T>(path: string, options: RequestOptions = {}, retried = false): Promise<T> {
        const { method = 'GET', body, signal, authenticated = true, query } = options;

        const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
        for (const [k, v] of Object.entries(query ?? {})) {
            if (v !== undefined) url.searchParams.set(k, String(v));
        }

        const headers: Record<string, string> = { Accept: 'application/json' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (authenticated) {
            const tokens = this.store.read();
            // No session at all is `unauthenticated` BEFORE a round trip: the request cannot succeed, and
            // sending it anyway spends a request to be told what we already know.
            if (!tokens) throw new ApiError('unauthenticated', 'Not signed in.');
            headers.Authorization = `Bearer ${tokens.accessToken}`;
        }

        const timeout = AbortSignal.timeout(this.timeoutMs);
        const { signal: composed, release } = combineSignals(signal ? [signal, timeout] : [timeout]);

        let response: Response;
        try {
            response = await fetch(url, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: composed,
            });
        } catch (cause) {
            // Distinguish the three ways `fetch` rejects. Conflating them produces "check your connection"
            // for a request the app itself cancelled.
            if (signal?.aborted) throw new ApiError('aborted', 'Request cancelled.');
            if (timeout.aborted) throw new ApiError('network', `Timed out after ${this.timeoutMs} ms.`);
            throw new ApiError('network', 'Could not reach the server.', { body: cause });
        } finally {
            release();
        }

        if (response.status === 401 && authenticated && !retried) {
            const refreshed = await this.refreshSession();
            if (refreshed) return this.request<T>(path, options, true);
        }

        return this.interpret<T>(response);
    }

    /** Read the response, turning any non-2xx into a classified `ApiError`. */
    private async interpret<T>(response: Response): Promise<T> {
        // 204, and any empty body, must not go through `json()` — it throws, and the resulting "Unexpected
        // end of JSON input" would be reported as a server fault on a call that in fact succeeded.
        const text = await response.text();
        let parsed: unknown;
        if (text.length > 0) {
            try {
                parsed = JSON.parse(text);
            } catch {
                if (response.ok) {
                    throw new ApiError('unexpected', 'The server sent a response that is not JSON.', {
                        status: response.status,
                        body: text.slice(0, 512),
                    });
                }
            }
        }

        if (response.ok) return parsed as T;

        const kind = kindForStatus(response.status);
        const { message, details } = describeBody(parsed, `Request failed (${response.status}).`);
        const retryAfter = Number(response.headers.get('retry-after'));

        if (kind === 'unauthenticated') this.endSession();

        throw new ApiError(kind, message, {
            status: response.status,
            code:
                typeof (parsed as { code?: unknown })?.code === 'string'
                    ? (parsed as { code: string }).code
                    : undefined,
            details,
            retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
            body: parsed,
        });
    }

    /**
     * Exchange the refresh token for a new pair, at most once concurrently.
     *
     * Returns false when there is nothing to refresh with or the refresh itself was rejected — the caller
     * then lets the original 401 through, which is the truthful outcome.
     */
    private async refreshSession(): Promise<boolean> {
        const existing = this.store.read();
        if (!existing) return false;

        this.refreshing ??= (async () => {
            const tokens = await this.request<Tokens>(
                '/auth/refresh',
                { method: 'POST', body: { refreshToken: existing.refreshToken }, authenticated: false },
                true, // never let a refresh recurse into refreshing
            );
            this.store.write(tokens);
            return tokens;
        })();

        try {
            await this.refreshing;
            return true;
        } catch {
            // The refresh token is spent, revoked or expired: this session is over. Ended here as well as in
            // `interpret`, because the refresh call is unauthenticated and never passes through that path —
            // and `endSession` makes the overlap harmless.
            this.endSession();
            return false;
        } finally {
            // Cleared unconditionally: leaving a settled promise in place would make every later 401 reuse a
            // token that has already been rotated away.
            this.refreshing = null;
        }
    }

    // ---- Session --------------------------------------------------------------------------------------

    async signIn(email: string, password: string, signal?: AbortSignal): Promise<void> {
        const tokens = await this.request<Tokens>('/auth/login', {
            method: 'POST',
            body: { email, password },
            authenticated: false,
            signal,
        });
        this.store.write(tokens);
    }

    async signOut(signal?: AbortSignal): Promise<void> {
        const tokens = this.store.read();
        // Cleared locally FIRST, and unconditionally. If the network call fails, the user has still signed
        // out of this browser — a sign-out that silently leaves the session in place is the worse failure.
        this.store.clear();
        if (!tokens) return;
        try {
            await this.request<void>('/auth/logout', {
                method: 'POST',
                body: { refreshToken: tokens.refreshToken },
                authenticated: false,
                signal,
            });
        } catch {
            // Best effort: the local session is already gone, and the refresh token expires on its own.
        }
    }
}
