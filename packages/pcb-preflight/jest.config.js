/**
 * The same split pcb-core makes, and for the same reason.
 *
 * The BUILD uses `module: node16`, which PRESERVES the dynamic `import()` that reaches the ESM-only
 * footprinter. ts-jest runs a flat CommonJS transpile instead, which would down-compile that import to a
 * `require()` — harmless here because the specs exercise the PURE functions and never call
 * `loadPadCountOracle`. The oracle's real behaviour is covered where it actually runs: the layout harness.
 *
 * The compiler settings below are TEST-ONLY. The package's own tsconfig keeps `lib:["ES2022"]` and
 * `types:[]` — that is the browser-safety guarantee, and widening it there to make a spec compile would be
 * marking one's own homework.
 *
 * @type {import('jest').Config}
 */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: ['**/*.test.ts', '**/*.spec.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    transform: {
        '^.+\\.ts$': [
            'ts-jest',
            {
                tsconfig: {
                    composite: false,
                    declaration: false,
                    declarationMap: false,
                    sourceMap: false,
                    module: 'commonjs',
                    moduleResolution: 'node',
                    target: 'ES2022',
                    esModuleInterop: true,
                    strict: true,
                    skipLibCheck: true,
                    lib: ['ES2022'],
                    types: ['node', 'jest'],
                },
            },
        ],
    },
};
