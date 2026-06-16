import {
    isRetryableModelError,
    tokensUsed,
    budgetExceeded,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_TOKEN_BUDGET,
} from './policy';

/** Build an error with an optional HTTP status + name, like the Anthropic SDK throws. */
function err(message: string, extra: { status?: number; name?: string } = {}): Error {
    const e = new Error(message);
    if (extra.name) e.name = extra.name;
    if (extra.status !== undefined) (e as Error & { status?: number }).status = extra.status;
    return e;
}

describe('isRetryableModelError', () => {
    it('retries on 5xx server errors', () => {
        expect(isRetryableModelError(err('boom', { status: 500 }))).toBe(true);
        expect(isRetryableModelError(err('bad gateway', { status: 502 }))).toBe(true);
        expect(isRetryableModelError(err('unavailable', { status: 503 }))).toBe(true);
    });

    it('retries on 529 / overloaded', () => {
        expect(isRetryableModelError(err('x', { status: 529 }))).toBe(true);
        expect(isRetryableModelError(err('Model is overloaded, try again'))).toBe(true);
    });

    it('retries on SDK connection/timeout errors (the client wall-clock timeout)', () => {
        expect(isRetryableModelError(err('aborted by timeout', { name: 'APIConnectionTimeoutError' }))).toBe(true);
        expect(isRetryableModelError(err('connection error', { name: 'APIConnectionError' }))).toBe(true);
    });

    it('retries on low-level socket timeouts/resets', () => {
        expect(isRetryableModelError(err('Request timed out'))).toBe(true);
        expect(isRetryableModelError(err('socket hang up'))).toBe(true);
        expect(isRetryableModelError(err('read ECONNRESET'))).toBe(true);
        expect(isRetryableModelError(err('connect ETIMEDOUT'))).toBe(true);
    });

    it('retries on the zentio gateway transient operational rejection', () => {
        expect(isRetryableModelError(err('İşlem gerçekleştirilemiyor'))).toBe(true);
        expect(isRetryableModelError(err('İlgili modele erişim yok'))).toBe(true);
        expect(isRetryableModelError(err('rejected (request id: 4815162342)'))).toBe(true);
    });

    it('does NOT retry on 4xx validation / auth errors', () => {
        expect(isRetryableModelError(err('Invalid request: bad schema', { status: 400 }))).toBe(false);
        expect(isRetryableModelError(err('Unauthorized', { status: 401 }))).toBe(false);
        expect(isRetryableModelError(err('Forbidden', { status: 403 }))).toBe(false);
        expect(isRetryableModelError(err('Too Many Requests', { status: 429 }))).toBe(false);
    });

    it('does NOT retry a deliberate caller abort (APIUserAbortError)', () => {
        expect(isRetryableModelError(err('Request was aborted.', { name: 'APIUserAbortError' }))).toBe(false);
    });

    it('does NOT retry a generic non-transient error, or null/undefined', () => {
        expect(isRetryableModelError(err('unexpected token in JSON'))).toBe(false);
        expect(isRetryableModelError(null)).toBe(false);
        expect(isRetryableModelError(undefined)).toBe(false);
        expect(isRetryableModelError('a bare string')).toBe(false);
    });
});

describe('tokensUsed', () => {
    it('sums input + output tokens', () => {
        expect(tokensUsed({ input_tokens: 100, output_tokens: 50 })).toBe(150);
    });

    it('tolerates a missing field', () => {
        expect(tokensUsed({ input_tokens: 100 })).toBe(100);
        expect(tokensUsed({ output_tokens: 50 })).toBe(50);
        expect(tokensUsed({})).toBe(0);
    });

    it('returns 0 for null/undefined usage', () => {
        expect(tokensUsed(null)).toBe(0);
        expect(tokensUsed(undefined)).toBe(0);
    });
});

describe('budgetExceeded', () => {
    it('is false below the budget', () => {
        expect(budgetExceeded(0, 300_000)).toBe(false);
        expect(budgetExceeded(299_999, 300_000)).toBe(false);
    });

    it('is true at or above the budget (boundary is inclusive)', () => {
        expect(budgetExceeded(300_000, 300_000)).toBe(true);
        expect(budgetExceeded(300_001, 300_000)).toBe(true);
    });
});

describe('defaults', () => {
    it('exposes sane timeout + budget defaults', () => {
        expect(DEFAULT_TIMEOUT_MS).toBe(90_000);
        expect(DEFAULT_TOKEN_BUDGET).toBe(300_000);
    });
});
