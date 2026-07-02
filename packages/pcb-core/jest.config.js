/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
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
