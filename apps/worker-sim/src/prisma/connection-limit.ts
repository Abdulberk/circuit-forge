/**
 * Pure helper: ensure a Postgres connection URL carries an explicit `connection_limit`.
 *
 * IDENTICAL in behaviour to the API's prisma.service.ts helper, so api+worker size their connection
 * pools the same way against the one Postgres. Prisma's default is `num_cpus * 2 + 1` (e.g. 17 on an
 * 8-core box), which the worker would silently adopt; combined with the API's pool that can approach
 * Postgres `max_connections` (default 100) under concurrency and produce P2024 "timed out fetching a
 * connection". We set a sane floor (override via DB_CONNECTION_LIMIT) unless the operator already
 * pinned one in DATABASE_URL.
 *
 * Kept dependency-free (no Prisma import) so it is unit-testable without constructing a client.
 */
export function withConnectionLimit(raw?: string): string | undefined {
    if (!raw) return undefined;
    if (/[?&]connection_limit=/.test(raw)) return raw; // operator set it explicitly — respect it
    // Append by string concat (NOT new URL().toString(), which re-encodes the whole string and would
    // corrupt a password containing characters Prisma tolerates raw). DB_CONNECTION_LIMIT must be a
    // bare integer; anything else falls back to the default.
    const configured = process.env.DB_CONNECTION_LIMIT;
    const limit = configured && /^\d+$/.test(configured) ? configured : '10';
    return raw + (raw.includes('?') ? '&' : '?') + `connection_limit=${limit}`;
}
