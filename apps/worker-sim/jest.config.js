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
                // The package builds with NodeNext (CJS output, no "type":"module"). Jest itself runs as
                // CommonJS, so override module/resolution to the classic commonjs+node pair for the test
                // run — the specs only import dependency-free pure modules, so this is sound and avoids
                // NodeNext's ESM-extension requirements. Merged over the package tsconfig.
                tsconfig: {
                    module: 'commonjs',
                    moduleResolution: 'node',
                },
            },
        ],
    },
};
