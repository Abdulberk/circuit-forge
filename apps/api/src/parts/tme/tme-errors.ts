/**
 * TME API error types. Thrown by the low-level client/token cache and mapped to HTTP
 * responses by PartsService.mapError().
 */

/** A structured error returned by the TME API (`{ code: "E_...", message }`) or a non-OK HTTP status. */
export class TmeApiError extends Error {
    constructor(
        public readonly code: string,
        public readonly httpStatus: number,
        message: string,
        public readonly errorData?: unknown,
        /** Parsed from the `Retry-After` header on a 429/503, in ms — how long to wait before retrying. */
        public readonly retryAfterMs?: number,
    ) {
        super(message);
        this.name = 'TmeApiError';
    }
}

/** A transport-level failure (network error, timeout/abort) reaching the TME API. */
export class TmeNetworkError extends Error {
    constructor(
        message: string,
        public readonly cause?: unknown,
    ) {
        super(message);
        this.name = 'TmeNetworkError';
    }
}
