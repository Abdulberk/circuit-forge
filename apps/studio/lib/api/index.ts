/**
 * The composition root for API access: one place that decides the base URL and the token store, so no
 * component ever constructs a client of its own with slightly different settings.
 */
export { ApiClient, type ApiClientOptions } from './client';
export { ApiError, isAbort, type FailureKind } from './errors';
export { pollUntilSettled, isPending, type PollOptions } from './poll';
export { browserTokenStore, memoryTokenStore, type TokenStore, type Tokens } from './tokens';
export { Api, type LayoutJob, type Org, type Paginated, type Project, type WorkingCopy } from './resources';

/**
 * Where the API lives.
 *
 * `NEXT_PUBLIC_API_URL` is inlined at build time, so it is read through a named constant rather than at each
 * call site — Next only substitutes the literal `process.env.NEXT_PUBLIC_API_URL`, and a computed lookup
 * silently yields undefined in the browser. The default is the port the repo's own `.env` assigns the API
 * (`PORT=3001`), not Nest's built-in 3000 — a developer running the stack as this repo configures it needs
 * no further configuration, and pointing at 3000 by default would silently address whatever else happens to
 * be on that port.
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
