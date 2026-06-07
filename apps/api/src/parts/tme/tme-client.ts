/**
 * Low-level TME v2 transport. Handles Bearer auth (via TmeTokenCache), PHP-style array query
 * params (`scope[0]=...`), request timeouts, a shared concurrency limiter, one-shot 401 retry,
 * and unwrapping the `{ status: "OK", data }` envelope (throwing TmeApiError on `{ code: "E_..." }`).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requireTmeConfig, type TmeConfig } from './tme.config';
import { TmeTokenCache } from './tme-token-cache';
import { TmeApiError, TmeNetworkError } from './tme-errors';
import { createLimiter, type Limiter } from './concurrency-limiter';

export type QueryValue = string | number | boolean | undefined | Array<string | number>;
export type Query = Record<string, QueryValue>;

/** Upper bound on a single inter-retry wait, incl. a server-supplied Retry-After. Keeps a transient
 *  rate-limit/outage from parking a request (and a concurrency slot) for the server's full window. */
const MAX_RETRY_WAIT_MS = 5_000;

interface TmeEnvelope<T> {
    status?: string;
    data?: T;
    code?: string;
    message?: string;
    error_data?: unknown;
}

@Injectable()
export class TmeClient {
    private cfg?: TmeConfig;
    private limiter?: Limiter;

    constructor(
        private readonly config: ConfigService,
        private readonly tokens: TmeTokenCache,
    ) {}

    private get conf(): TmeConfig {
        if (!this.cfg) this.cfg = requireTmeConfig(this.config);
        return this.cfg;
    }

    private get pool(): Limiter {
        if (!this.limiter) this.limiter = createLimiter(this.conf.maxConcurrency);
        return this.limiter;
    }

    /** Default market params + safety caps for providers to merge into queries. */
    get defaults(): { country: string; language: string; currency: string; maxManufacturers: number } {
        const { country, language, currency, maxManufacturers } = this.conf;
        return { country, language, currency, maxManufacturers };
    }

    /** GET a TME endpoint and return the unwrapped `data`, with transient retries (5xx / network / 429
     *  rate-limit) on top of the in-request one-shot 401 retry. A 429 honours the server's Retry-After
     *  (capped — see withRetry); the catalog is business-critical, so a transient rate-limit/outage must
     *  not surface as a hard failure to the AI design loop. Retry runs OUTSIDE the concurrency limiter so
     *  the backoff sleep never holds a slot — only the actual fetch occupies one, so a handful of
     *  rate-limited calls can't stall all catalog traffic. */
    async get<T = unknown>(path: string, query: Query = {}): Promise<T> {
        return this.withRetry(() => this.pool.run(() => this.request<T>(path, query, true)));
    }

    private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
        const attempts = this.conf.maxRetries;
        let lastErr: unknown;
        for (let i = 0; i < attempts; i++) {
            try {
                return await fn();
            } catch (err) {
                lastErr = err;
                // Retry network errors, 5xx, and 429 (rate limit). NOT other 4xx (incl. WAF 403) — those
                // are deterministic, and a search 403 is handled (swallowed to empty) one layer up.
                const transient =
                    err instanceof TmeNetworkError ||
                    (err instanceof TmeApiError && (err.httpStatus >= 500 || err.httpStatus === 429));
                if (!transient || i === attempts - 1) throw err;
                // Honour Retry-After on a 429; otherwise capped exponential backoff + jitter. The wait is
                // CLAMPED to MAX_RETRY_WAIT_MS: a server can legally send a huge Retry-After (60/3600/…),
                // and we must fail fast rather than park the request (and the AI loop) for minutes/hours.
                const retryAfter = err instanceof TmeApiError ? err.retryAfterMs : undefined;
                const backoff = Math.min(200 * 2 ** i, 2000) + Math.floor(Math.random() * 100);
                const delay = Math.min(retryAfter ?? backoff, MAX_RETRY_WAIT_MS);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
        throw lastErr;
    }

    /** Parse a `Retry-After` header (delta-seconds or an HTTP-date) into ms; undefined if absent/invalid. */
    private parseRetryAfter(res: Response): number | undefined {
        const raw = res.headers?.get?.('retry-after');
        if (!raw) return undefined;
        const secs = Number(raw);
        if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
        const when = Date.parse(raw);
        return Number.isFinite(when) ? Math.max(0, when - Date.now()) : undefined;
    }

    private async request<T>(path: string, query: Query, retryOn401: boolean): Promise<T> {
        const url = `${this.conf.baseUrl}${path}${this.buildQuery(query)}`;
        const token = await this.tokens.getToken();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.conf.timeoutMs);

        let res: Response;
        try {
            res = await fetch(url, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Accept-Language': this.conf.language,
                },
                signal: controller.signal,
            });
        } catch (err) {
            throw new TmeNetworkError(`TME request failed: ${path}`, err);
        } finally {
            clearTimeout(timer);
        }

        // Token may have expired between refresh-ahead and use: invalidate and retry once.
        if (res.status === 401 && retryOn401) {
            this.tokens.invalidate();
            return this.request<T>(path, query, false);
        }

        const text = await res.text();
        let json: TmeEnvelope<T> | null = null;
        try {
            json = JSON.parse(text) as TmeEnvelope<T>;
        } catch {
            json = null;
        }

        if (res.ok && json?.status === 'OK') {
            return (json.data ?? ({} as T)) as T;
        }
        // A 2xx with an unparseable body is a distinct failure from an error envelope.
        if (res.ok && json === null) {
            throw new TmeApiError('E_INVALID_JSON', res.status, `TME returned a non-JSON ${res.status} body`);
        }

        throw new TmeApiError(
            json?.code ?? `E_HTTP_${res.status}`,
            res.status,
            json?.message ?? `TME request failed (${res.status})`,
            json?.error_data,
            this.parseRetryAfter(res),
        );
    }

    /** Build a query string with PHP-style indexed arrays: `scope[0]=products&scope[1]=parameters`. */
    private buildQuery(query: Query): string {
        const parts: string[] = [];
        const enc = encodeURIComponent;
        for (const [key, value] of Object.entries(query)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
                value.forEach((v, i) => parts.push(`${enc(key)}[${i}]=${enc(String(v))}`));
            } else {
                parts.push(`${enc(key)}=${enc(String(value))}`);
            }
        }
        return parts.length > 0 ? `?${parts.join('&')}` : '';
    }
}
