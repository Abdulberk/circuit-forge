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
                // The package tsconfig is a `composite` project-reference build; ts-jest doesn't emit a
                // project graph, so turn those off for the test run to avoid composite/declaration errors.
                tsconfig: {
                    composite: false,
                    declaration: false,
                    declarationMap: false,
                    sourceMap: false,
                },
            },
        ],
    },
};
