/**
 * Per-request correlation context.
 *
 * A tiny AsyncLocalStorage store that carries a server-generated `requestId` for the lifetime of one
 * HTTP request. It is registered as the FIRST middleware (AppModule.configure), so guards, services,
 * and the AuditService all see the same id without threading it through every function signature.
 *
 * The id is generated server-side (never trusted from an inbound header — a client-controlled id could
 * poison the audit/correlation trail), and echoed back in the `x-request-id` response header so a
 * caller can correlate their request with the server's logs/audit rows.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

import type { Request, Response, NextFunction } from 'express';

interface RequestStore {
    requestId: string;
}

const storage = new AsyncLocalStorage<RequestStore>();

/** The current request's correlation id, or undefined outside a request (e.g. background jobs, tests
 *  that don't route through the middleware). Callers must tolerate undefined. */
export function getRequestId(): string | undefined {
    return storage.getStore()?.requestId;
}

/** Run `fn` inside a fresh request context (used by the middleware; exposed for tests). */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
    return storage.run({ requestId }, fn);
}

/**
 * Express middleware: mint a fresh request id, expose it on the response, and run the rest of the
 * request within the ALS store. Applied globally in AppModule so it also covers the integration tests.
 */
export function requestContextMiddleware(_req: Request, res: Response, next: NextFunction): void {
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    storage.run({ requestId }, () => next());
}
