/**
 * The kernel-facing logic here — the API client, the poller — is plain TypeScript with no DOM in it, so it
 * runs under the node environment against the real `fetch`, `AbortController` and `AbortSignal.timeout` that
 * Node 22 provides. Testing it through a browser-shaped shim would prove the shim works.
 */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    // `components` too. It was `lib` alone, which meant the panels — the only place in this app where a user
    // actually changes a design — could not be tested even if someone wrote a spec: jest would not have
    // looked at it. A kernel with no reachable surface is the gap that produced this line.
    roots: ['<rootDir>/lib', '<rootDir>/components'],
    // `.tsx` too: the React hooks are as much a part of this layer as the client is, and a hook whose only
    // proof is "it compiles" is the one that quietly renders the previous project's document. Those files
    // opt into a DOM with a `@jest-environment jsdom` pragma rather than splitting the whole config for them.
    testMatch: ['**/*.spec.ts', '**/*.spec.tsx'],
    // The live e2e needs the stack running, so it is not part of the default run — `pnpm test:e2e` invokes it
    // deliberately. It FAILS rather than skips when the API is unreachable: a live check that passes without
    // having run is a false green, and a false green is worse than a missing test.
    testPathIgnorePatterns: ['\\.e2e\\.spec\\.ts$'],
    transform: {
        '^.+\\.tsx?$': [
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
                    jsx: 'react-jsx',
                    lib: ['ES2022', 'DOM'],
                },
            },
        ],
    },
    // Browser APIs jsdom lacks — see jest.setup.ts. Without PointerEvent a simulated drag silently loses
    // every coordinate, and the component computes NaN from it.
    setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
};
