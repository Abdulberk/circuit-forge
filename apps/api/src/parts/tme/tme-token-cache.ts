/**
 * OAuth2 client_credentials token lifecycle for the TME v2 API.
 *
 * TME access tokens live ~300s. We refresh ~30s ahead of expiry and use a single-flight guard so
 * that, under concurrent load, only ONE `/auth/token` request is in flight at a time.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requireTmeConfig, type TmeConfig } from './tme.config';
import { TmeApiError, TmeNetworkError } from './tme-errors';

const REFRESH_AHEAD_MS = 30_000;

interface TokenResponse {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
}

interface ErrorEnvelope {
    code?: string;
    message?: string;
    error_data?: unknown;
}

@Injectable()
export class TmeTokenCache {
    private cfg?: TmeConfig;
    private accessToken: string | null = null;
    private expiresAtMs = 0;
    private inflight: Promise<string> | null = null;

    constructor(private readonly config: ConfigService) {}

    private get conf(): TmeConfig {
        if (!this.cfg) this.cfg = requireTmeConfig(this.config);
        return this.cfg;
    }

    /** Drop the cached token (called after a 401 so the next call re-authenticates). */
    invalidate(): void {
        this.accessToken = null;
        this.expiresAtMs = 0;
    }

    async getToken(): Promise<string> {
        if (this.accessToken && Date.now() < this.expiresAtMs - REFRESH_AHEAD_MS) {
            return this.accessToken;
        }
        // Single-flight: concurrent callers share one in-flight token request.
        if (this.inflight) return this.inflight;
        this.inflight = this.fetchToken().finally(() => {
            this.inflight = null;
        });
        return this.inflight;
    }

    private async fetchToken(): Promise<string> {
        const { token, secret, baseUrl, timeoutMs } = this.conf;
        const basic = Buffer.from(`${token}:${secret}`).toString('base64');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let res: Response;
        try {
            res = await fetch(`${baseUrl}/auth/token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Authorization: `Basic ${basic}`,
                },
                body: 'grant_type=client_credentials',
                signal: controller.signal,
            });
        } catch (err) {
            throw new TmeNetworkError('TME token request failed', err);
        } finally {
            clearTimeout(timer);
        }

        const text = await res.text();
        let json: (TokenResponse & ErrorEnvelope) | null = null;
        try {
            json = JSON.parse(text) as TokenResponse & ErrorEnvelope;
        } catch {
            json = null;
        }

        if (!res.ok || !json?.access_token) {
            throw new TmeApiError(
                json?.code ?? 'E_AUTHORIZATION_FAILED',
                res.status,
                json?.message ?? 'Failed to obtain TME access token',
                json?.error_data,
            );
        }

        this.accessToken = json.access_token;
        const expiresIn = Number(json.expires_in ?? 300);
        this.expiresAtMs = Date.now() + expiresIn * 1000;
        return this.accessToken;
    }
}
