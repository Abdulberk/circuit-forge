/**
 * The kernel-facing logic here — the API client, the poller — is plain TypeScript with no DOM in it, so it
 * runs under the node environment against the real `fetch`, `AbortController` and `AbortSignal.timeout` that
 * Node 22 provides. Testing it through a browser-shaped shim would prove the shim works.
 */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/lib'],
    testMatch: ['**/*.spec.ts'],
    // The live e2e needs the stack running, so it is not part of the default run — `pnpm test:e2e` invokes it
    // deliberately. It FAILS rather than skips when the API is unreachable: a live check that passes without
    // having run is a false green, and a false green is worse than a missing test.
    testPathIgnorePatterns: ['\\.e2e\\.spec\\.ts$'],
    transform: {
        '^.+\\.ts$': [
            'ts-jest',
            {
                tsconfig: {
                    target: 'ES2022',
                    module: 'commonjs',
                    moduleResolution: 'node',
                    esModuleInterop: true,
                    strict: true,
                    skipLibCheck: true,
                    types: ['node', 'jest'],
                },
            },
        ],
    },
};
