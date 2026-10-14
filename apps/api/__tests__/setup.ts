/**
 * Jest Test Setup
 */

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-only';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-key-for-testing';
process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/circuitforge_test';
/**
 * How many database connections ONE suite may hold.
 *
 * The other half of the budget in jest.config.js, which derives the worker count from it — the two are a
 * pair and neither is meaningful alone. Every integration suite boots its own Nest app and therefore its
 * own Prisma pool, so what the server sees is `workers × this`. Left at the service's production default
 * of 10 against Jest's default of `cores − 1` workers, a 16-core machine asks Postgres for 150 connections
 * against a limit of 100, and the overflow arrives as `Can't reach database server` — a message that reads
 * like the database is down, on suites that pass perfectly one at a time.
 *
 * Five, because a suite drives its app through supertest one request at a time; the pool exists to absorb
 * a handful of concurrent queries inside one request, not parallel traffic. Raising it means lowering the
 * worker count by the same factor, which is exactly what jest.config.js computes.
 */
process.env.DB_CONNECTION_LIMIT = process.env.DB_CONNECTION_LIMIT ?? '5';
/**
 * A Redis database of the suites' OWN, not the dev stack's.
 *
 * The database above was already separate and the queue was not: suites wrote their rows to
 * `circuitforge_test` and enqueued their jobs into db 0, which is where a locally running worker-sim
 * listens. That worker then picked the jobs up, looked for rows in the DEV database, and failed every one
 * with "Record to update not found" — 59 of them in a single burst the next time the stack was started.
 * Nothing drains db 1. A suite that needs an undrained queue of its own can still pick another index,
 * as verify-design does with /15.
 */
process.env.REDIS_URL = 'redis://localhost:6379/1';
process.env.S3_ENDPOINT = 'http://localhost:9000';
process.env.S3_ACCESS_KEY = 'minioadmin';
process.env.S3_SECRET_KEY = 'minioadmin';
process.env.S3_BUCKET = 'circuitforge-test';
process.env.S3_REGION = 'us-east-1';
process.env.S3_FORCE_PATH_STYLE = 'true';
// TME component catalog (parts module) — dummy creds so the module boots in tests; the TME client is mocked.
process.env.TME_TOKEN = 'test-tme-token';
process.env.TME_SECRET = 'test-tme-secret';
process.env.TME_BASE_URL = 'https://api.tme.eu';

// Increase timeout for integration tests
jest.setTimeout(30000);

// Global test utilities
export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
