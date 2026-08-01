/**
 * The boundary gate runs under Node so it can read the package's own files and its build output.
 *
 * The shipped code is compiled with `lib:["ES2022"]` and `types:[]` — no DOM, no Node — and that is the
 * guarantee this package exists to keep. This config deliberately does NOT relax that: it hands ts-jest a
 * separate, test-only compiler setup, so the spec may import `node:fs` while `src/index.ts` still cannot.
 * The gate refused this very spec until the two were separated, which is the gate working.
 *
 * @type {import('jest').Config}
 */
module.exports = {
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
