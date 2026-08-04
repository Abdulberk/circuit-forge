/**
 * HOW MANY SUITES MAY RUN AT ONCE — bounded by MEMORY, which is what actually binds here.
 *
 * This package's dependencies are heavy: `@tscircuit/eval` carries a full compiler, and the footprinter and
 * three format converters come with it. Every Jest worker loads its own copy, so the cost is per-worker and
 * it is large. At Jest's default of `cores − 1` — 15 on this machine — the run dies with
 * `FATAL ERROR: Committing semi space failed. Allocation failed - JavaScript heap out of memory`, and the
 * summary reads "7 suites failed" with zero failing tests. Nothing in that points at memory; it looks like
 * seven broken suites.
 *
 * Measured on this machine, same code, same commit: 15 workers → OOM. 8, 6 and 3 → 215/215 green.
 *
 * A FIXED NUMBER TUNED TODAY IS THE WRONG FIX, and more obviously here than anywhere else on this repo: the
 * ceiling depends on what ELSE is running. These measurements were taken with five Docker containers and a
 * dev server up. Pick 8 because 8 passed this afternoon and the run dies the day someone also has a browser
 * open — as the same catastrophic, mis-attributed failure.
 *
 * So: a conservative share of the cores, and `workerIdleMemoryLimit`, which is the part that adapts. Jest
 * restarts a worker that grows past the limit instead of letting it take the whole run down, so the config
 * responds to actual usage rather than to an assumption about it. The cap leaves real margin because the
 * failure mode is catastrophic and its error message points at V8 rather than at the cause.
 */
const WORKERS = Math.max(2, Math.ceil(require('node:os').cpus().length / 3));

/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    maxWorkers: WORKERS,
    // A worker that has accumulated more than this is recycled between suites rather than growing until
    // the OS refuses. 512 MB is well above what one suite legitimately needs and well below the point
    // where a handful of workers exhaust the machine.
    workerIdleMemoryLimit: '512MB',
    roots: ['<rootDir>/src'],
    testMatch: ['**/*.test.ts', '**/*.spec.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/index.ts'],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov'],
    transform: {
        '^.+\\.ts$': [
            'ts-jest',
            {
                // ts-jest runs a flat CJS transpile; the composite/node16 settings are for the real
                // build. Tests exercise the PURE modules (no ESM deps) + golden fixtures; the live
                // eval/route integration runs in the `pnpm test:layout` script harness instead
                // (repo convention: test:matrix/test:edge are node harnesses too).
                tsconfig: {
                    composite: false,
                    declaration: false,
                    declarationMap: false,
                    sourceMap: false,
                    module: 'commonjs',
                    moduleResolution: 'node',
                },
            },
        ],
    },
};
