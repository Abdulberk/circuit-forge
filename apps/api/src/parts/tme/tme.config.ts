/**
 * TME configuration resolution. Mirrors GenerationService.requireLlmConfig(): credentials are
 * server-side only and missing config surfaces as a 503 (the app still boots without them).
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface TmeConfig {
    /** 50-char application token (OAuth Basic-auth username). */
    token: string;
    /** 20-char application secret (OAuth Basic-auth password). */
    secret: string;
    baseUrl: string;
    /** Default market: affects pricing/availability shown. */
    country: string;
    language: string;
    currency: string;
    timeoutMs: number;
    maxConcurrency: number;
    /** TTL for reference data (manufacturers, categories). */
    referenceTtlMs: number;
    /** TTL for search-result caching. */
    searchTtlMs: number;
}

function num(config: ConfigService, key: string, fallback: number): number {
    const raw = config.get<string>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

export function requireTmeConfig(config: ConfigService): TmeConfig {
    const token = config.get<string>('TME_TOKEN');
    const secret = config.get<string>('TME_SECRET');
    if (!token || !secret) {
        throw new ServiceUnavailableException(
            'Component catalog is not configured (TME_TOKEN/TME_SECRET are not set).',
        );
    }
    return {
        token,
        secret,
        baseUrl: config.get<string>('TME_BASE_URL') ?? 'https://api.tme.eu',
        country: config.get<string>('TME_DEFAULT_COUNTRY') ?? 'PL',
        language: config.get<string>('TME_DEFAULT_LANGUAGE') ?? 'en',
        currency: config.get<string>('TME_DEFAULT_CURRENCY') ?? 'EUR',
        timeoutMs: num(config, 'TME_TIMEOUT_MS', 10_000),
        maxConcurrency: num(config, 'TME_MAX_CONCURRENCY', 4),
        referenceTtlMs: num(config, 'TME_REF_TTL_MS', 24 * 60 * 60 * 1000),
        searchTtlMs: num(config, 'TME_SEARCH_TTL_MS', 60 * 1000),
    };
}
