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

    /** Default market params (country/language/currency) for providers to merge into queries. */
    get defaults(): { country: string; language: string; currency: string } {
        const { country, language, currency } = this.conf;
        return { country, language, currency };
    }

    /** GET a TME endpoint and return the unwrapped `data`. Runs through the concurrency limiter. */
    async get<T = unknown>(path: string, query: Query = {}): Promise<T> {
        return this.pool.run(() => this.request<T>(path, query, true));
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

        throw new TmeApiError(
            json?.code ?? `E_HTTP_${res.status}`,
            res.status,
            json?.message ?? `TME request failed (${res.status})`,
            json?.error_data,
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
