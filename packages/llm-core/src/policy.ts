/**
 * Pure retry/timeout/budget policy for the model call loop.
 *
 * Kept dependency-free (no SDK, no eda-core) so the decisions are unit-testable in isolation:
 *  - which model errors are worth ONE retry (transient: 5xx / overload / timeout / connection drop /
 *    the zentio gateway's transient Turkish rejection) vs terminal (4xx validation, auth, user-abort);
 *  - how to accumulate token usage and when a cumulative per-request budget is spent.
 */

/** Per-request wall-clock timeout for a single model call (ms). The SDK aborts and throws past this. */
export const DEFAULT_TIMEOUT_MS = 90_000;
/**
 * Cumulative input+output token budget for ONE callModel invocation (across its tool-use loop). A
 * safety ceiling on a pathological tool loop (each round re-sends a growing context at up to max_tokens
 * out); generous by design — the tight per-route limits are maxToolIters + the API throttler. Once spent,
 * the loop stops offering tools and forces a final tool-less answer rather than spending another round.
 */
export const DEFAULT_TOKEN_BUDGET = 300_000;

/**
 * Is this model error transient enough to be worth exactly one retry with the identical payload?
 *
 * Retryable: HTTP 5xx, 529/overloaded, an SDK connection/timeout error (the client's own wall-clock
 * timeout surfaces as APIConnectionTimeoutError), low-level socket timeouts/resets, and the zentio
 * gateway's transient operational rejection (observed to succeed on immediate retry).
 * NOT retryable: 4xx validation/auth, and a deliberate caller abort (APIUserAbortError) — retrying that
 * would defeat the cancellation.
 */
export function isRetryableModelError(e: unknown): boolean {
    const status = (e as { status?: number } | null | undefined)?.status;
    const name = (e as { name?: string } | null | undefined)?.name ?? '';
    const msg = e instanceof Error ? e.message : String(e);

    if (typeof status === 'number' && status >= 500) return true;
    if (status === 529 || /overloaded/i.test(msg)) return true;
    // SDK connection / wall-clock-timeout errors (NOT APIUserAbortError — a deliberate cancel).
    if (/^(APIConnectionTimeoutError|APIConnectionError)$/.test(name)) return true;
    if (/timed out|ETIMEDOUT|ECONNRESET|socket hang up|network|connection error/i.test(msg)) return true;
    // zentio gateway's transient Turkish operational rejection + request id (clean on identical retry).
    return /İşlem gerçekleştirilemiyor|İlgili modele erişim yok|request id: \d/u.test(msg);
}

/** Sum input+output tokens from an Anthropic usage block, tolerating missing/partial fields. */
export function tokensUsed(usage: { input_tokens?: number; output_tokens?: number } | null | undefined): number {
    if (!usage) return 0;
    return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

/** True once cumulative tokens have reached/exceeded the budget → stop offering tools, force a final answer. */
export function budgetExceeded(cumulativeTokens: number, budget: number): boolean {
    return cumulativeTokens >= budget;
}
