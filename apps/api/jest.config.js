/**
 * HOW MANY SUITES MAY RUN AT ONCE, and why it is a computed number rather than a taste.
 *
 * Every integration suite boots its own Nest application, and every application opens its own Prisma
 * connection pool. So the database load is `workers × pool`, and Postgres refuses past `max_connections`.
 * Jest's default is `cores − 1`, which on this machine is 15: 15 × 10 = 150 against a limit of 100. The
 * result was 41 failures reporting `Can't reach database server at localhost:5432` while Postgres was
 * healthy and idle — a message that reads like the environment is down, on suites that pass one at a time.
 *
 * The tempting fix is to lower one of the two numbers until this machine stops complaining. That is a
 * constant tuned to one laptop: the same arithmetic breaks again on a 32-core CI runner, and breaks
 * SILENTLY, as the same misleading message.
 *
 * So the budget is stated instead, and the numbers are derived from it. `WORKERS × POOL` must stay under
 * the server's limit with room for the connections this suite does not own — a running dev API container,
 * an open psql, another developer on a shared database. Changing either number without changing the
 * budget is what the arithmetic below is here to prevent.
 */
const MAX_CONNECTIONS = Number(process.env.DB_MAX_CONNECTIONS) || 100; // Postgres default
const RESERVED = 40; // dev API container, psql sessions, migrations, headroom
const POOL_PER_WORKER = Number(process.env.DB_CONNECTION_LIMIT) || 5; // must match __tests__/setup.ts
const CONNECTION_BOUND = Math.max(1, Math.floor((MAX_CONNECTIONS - RESERVED) / POOL_PER_WORKER));

/**
 * The SECOND bound, and on this hardware the binding one — found by measurement after the first was fixed.
 *
 * Booting a Nest application is CPU work, and every suite does it. Past roughly a third of the cores the
 * machine spends more time switching between half-booted applications than finishing any of them, and the
 * symptom is not slowness but FAILURE: work that takes 600 ms alone exceeds a 30-second timeout under
 * contention. Measured on this 16-core box, whole suite, same code, same database:
 *
 *     12 workers → 31 failed, 652 s
 *      6 workers →  0 failed, 523 s
 *
 * Fewer workers was both more reliable AND faster, which is the shape that tells you the machine was
 * thrashing rather than working. Raising the timeout instead would have bought a green run by agreeing not
 * to notice — a timeout that fires under normal load is not catching a hang, it is reporting one.
 */
const BOOT_BOUND = Math.max(2, Math.ceil(require('node:os').cpus().length / 3));

const WORKERS = Math.min(CONNECTION_BOUND, BOOT_BOUND);

/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    // The smaller of the two budgets above, never Jest's default of `cores − 1`. A machine with more cores
    // does not have a bigger database, and past a point it cannot boot more applications at once either.
    maxWorkers: WORKERS,
    testEnvironment: 'node',
    roots: ['<rootDir>/src', '<rootDir>/__tests__'],
    testMatch: ['**/*.test.ts', '**/*.spec.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/main.ts'],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov', 'html'],
    transform: {
        '^.+\\.ts$': [
            'ts-jest',
            {
                tsconfig: 'tsconfig.json',
                // TRANSPILE ONLY. ts-jest type-checks every file it compiles by default, and each
                // integration suite imports AppModule — i.e. the whole application — so the check ran once
                // per suite, per worker. Measured on this repo: 63.8s cold for a test whose body is a
                // 600ms module boot; 40.1s with this on. The type check is not lost, it MOVES: `pnpm
                // typecheck` runs tsc --noEmit over the same sources and CI runs it (ci.yml:90). Doing it
                // twice bought nothing except a suite slow enough that people stop running it — and a test
                // nobody runs is worse than one that does not exist, because it is believed to be there.
                //
                // Safe here specifically: this is only unsound for constructs that need cross-file type
                // info at emit — `const enum` and un-annotated type re-exports. Grepped: zero `const enum`
                // in the repo, and the build already runs with `isolatedModules` semantics under tsc.
                isolatedModules: true,
            },
        ],
    },
    setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts'],
    // Says out loud when the run could not actually test — a missing database or a silently skipped live
    // suite is otherwise indistinguishable from a healthy green. See scripts/jest-environment-reporter.cjs.
    reporters: ['default', '<rootDir>/../../scripts/jest-environment-reporter.cjs'],
    testTimeout: 30000,
};
