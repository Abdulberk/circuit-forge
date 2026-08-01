/**
 * What a failed call means, as a type rather than a string to be matched at the call site.
 *
 * Every failure the studio can see arrives here in one shape, because the alternative — each caller reading
 * `err.message` and guessing — produces a UI that says "Something went wrong" for a stale edit, an expired
 * session and an unreachable server alike. Those need three different recoveries: merge, re-authenticate,
 * retry. A caller that cannot tell them apart cannot offer any of them.
 */

/** How the caller should recover. This, not the status code, is what a component branches on. */
export type FailureKind =
    /** The request never reached the server, or the response never arrived: offline, DNS, TLS, timeout. */
    | 'network'
    /** The caller aborted it — a component unmounted, a newer request superseded it. Never shown as an error. */
    | 'aborted'
    /** No valid session. The one kind that must not be retried without re-authenticating. */
    | 'unauthenticated'
    /** Authenticated, but not allowed. Retrying changes nothing; the user needs different access. */
    | 'forbidden'
    /** The thing addressed does not exist (or is not visible to this user, which the API reports the same). */
    | 'not-found'
    /** Someone else changed it first. Recoverable by reloading and re-applying — see `WORKING_COPY_CONFLICT`. */
    | 'conflict'
    /** The request was rejected as invalid. `details` carries the per-field messages when the API sent them. */
    | 'invalid'
    /** Rate limited or over quota. `retryAfterSeconds` is set when the server said when. */
    | 'throttled'
    /** The server failed. Retryable, but not by hammering it. */
    | 'server'
    /** A response that did not parse, or a status with no meaning here. Never guessed at. */
    | 'unexpected';

export class ApiError extends Error {
    readonly kind: FailureKind;
    /** The HTTP status, when there was one. Absent for network and abort failures — there was no response. */
    readonly status?: number;
    /** The API's own machine code (`WORKING_COPY_CONFLICT`, …) when it sent one. Never invented. */
    readonly code?: string;
    /** Field-level validation messages, exactly as the API sent them. */
    readonly details?: string[];
    readonly retryAfterSeconds?: number;
    /** The parsed body, kept whole so a caller can read a field this class does not model. */
    readonly body?: unknown;

    constructor(
        kind: FailureKind,
        message: string,
        init: { status?: number; code?: string; details?: string[]; retryAfterSeconds?: number; body?: unknown } = {},
    ) {
        super(message);
        this.name = 'ApiError';
        this.kind = kind;
        this.status = init.status;
        this.code = init.code;
        this.details = init.details;
        this.retryAfterSeconds = init.retryAfterSeconds;
        this.body = init.body;
    }

    /**
     * Whether trying the same request again could plausibly succeed.
     *
     * `conflict` is deliberately NOT retryable: the request carried a precondition that is now known to be
     * false, so repeating it verbatim fails identically. The caller must re-read and re-apply, which is a
     * different request.
     */
    get retryable(): boolean {
        return this.kind === 'network' || this.kind === 'server' || this.kind === 'throttled';
    }
}

/** True when a failure is the caller's own cancellation, which is never worth reporting to a user. */
export const isAbort = (e: unknown): boolean => e instanceof ApiError && e.kind === 'aborted';

const KIND_BY_STATUS: ReadonlyMap<number, FailureKind> = new Map([
    [400, 'invalid'],
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [409, 'conflict'],
    [422, 'invalid'],
    [429, 'throttled'],
]);

/**
 * Classify a response.
 *
 * Anything at or above 500 is `server`; anything else unmapped is `unexpected` rather than being folded into
 * the nearest neighbour. A status we have not thought about should read as one we have not thought about.
 */
export function kindForStatus(status: number): FailureKind {
    return KIND_BY_STATUS.get(status) ?? (status >= 500 ? 'server' : 'unexpected');
}

/**
 * Pull the human message out of a Nest error body.
 *
 * Nest sends `message` as either a string or an array of validation strings, so both are handled — and the
 * array is kept in `details` instead of being flattened into one line, because a form needs to put each
 * message next to its own field.
 */
export function describeBody(body: unknown, fallback: string): { message: string; details?: string[] } {
    if (typeof body !== 'object' || body === null) return { message: fallback };
    const m = (body as { message?: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return { message: m };
    if (Array.isArray(m) && m.length > 0) {
        const details = m.filter((x): x is string => typeof x === 'string');
        return { message: details[0] ?? fallback, details };
    }
    return { message: fallback };
}
