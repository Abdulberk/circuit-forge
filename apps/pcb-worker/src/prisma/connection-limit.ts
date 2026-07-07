/**
 * Pure helper: ensure a Postgres connection URL carries an explicit `connection_limit`. IDENTICAL to
 * worker-sim's helper so api + both workers size their pools the same way against the one Postgres
 * (Prisma's default num_cpus*2+1 can approach max_connections under concurrency → P2024). Dependency-free.
 */
export function withConnectionLimit(raw?: string): string | undefined {
    if (!raw) return undefined;
    if (/[?&]connection_limit=/.test(raw)) return raw;
    const configured = process.env.DB_CONNECTION_LIMIT;
    const limit = configured && /^\d+$/.test(configured) ? configured : '10';
    return raw + (raw.includes('?') ? '&' : '?') + `connection_limit=${limit}`;
}
