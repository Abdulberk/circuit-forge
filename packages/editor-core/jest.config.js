/**
 * The kernel's tests run under Node so it can read the package's own files and its build output.
 *
 * The shipped code is compiled with `lib:["ES2022"]` and `types:[]` — no DOM, no Node — and that is the
 * guarantee this package exists to keep. This config deliberately does NOT relax that: it hands ts-jest a
 * separate, test-only compiler setup, so the spec may import `node:fs` while `src/index.ts` still cannot.
 * The gate refused this very spec until the two were separated, which is the gate working.
 *
 * @type {import('jest').Config}
 */
/**
 * WHY THE WORKER COUNT IS SET HERE.
 *
 * Jest's default is one worker per core less one, which assumes tests are CPU-bound and independent. Two of
 * these are neither: the boundary spec PACKS the package with npm and then resolves every import in the
 * tarball, and the routing specs route hundreds of sheets. Sixteen of those at once is disk and memory, not
 * arithmetic, and the suite went red on a machine where nothing was wrong with the code — a run that fails
 * for a reason unrelated to what it tests is worse than a slow one, because the next red is assumed to be
 * this one.
 *
 * Half the cores, which leaves room for the heavy two to overlap without contending.
 */
module.exports = {
    maxWorkers: Math.max(2, Math.floor(require('os').cpus().length / 2)),
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: ['**/*.spec.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    transform: {
        '^.+\\.ts$': [
            'ts-jest',
            {
                tsconfig: {
                    composite: false,
                    declaration: false,
                    module: 'commonjs',
                    moduleResolution: 'node',
                    // Test-only. The package's own tsconfig keeps lib:["ES2022"] and types:[] — that is
                    // what the gate asserts, and widening it there would be marking one's own homework.
                    lib: ['ES2022'],
                    types: ['node', 'jest'],
                },
            },
        ],
    },
};
