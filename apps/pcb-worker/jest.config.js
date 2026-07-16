/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: ['**/*.test.ts', '**/*.spec.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/main.ts'],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov'],
    transform: {
        '^.+\\.ts$': [
            'ts-jest',
            {
                // Same rationale as worker-sim: the package builds NodeNext (CJS), Jest runs as CommonJS,
                // so override to classic commonjs+node for the test run. Merged over the package tsconfig.
                tsconfig: {
                    module: 'commonjs',
                    moduleResolution: 'node',
                },
            },
        ],
    },
};
