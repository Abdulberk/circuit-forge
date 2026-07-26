module.exports = {
    root: true,
    parser: '@typescript-eslint/parser',
    parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        // REQUIRED by the type-aware rules below (no-floating-promises, no-misused-promises,
        // await-thenable) — without it every one of them throws "You have used a rule which
        // requires parserServices". See tsconfig.eslint.json for why it is not a build config.
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: __dirname,
    },
    plugins: ['@typescript-eslint', 'import'],
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended',
        'plugin:@typescript-eslint/recommended-requiring-type-checking',
        'plugin:import/recommended',
        'plugin:import/typescript',
        'prettier',
    ],
    env: {
        node: true,
        jest: true,
    },
    // `*.js` covers this file too: it is not in tsconfig.eslint.json, so type-aware linting
    // would fail on it with "file not included in project" — and linting the lint config with
    // TypeScript rules buys nothing.
    ignorePatterns: [
        'node_modules',
        'dist',
        'coverage',
        '.next',
        '*.js',
    ],
    settings: {
        'import/resolver': {
            typescript: {
                alwaysTryTypes: true,
                project: ['./tsconfig.json', './apps/*/tsconfig.json', './packages/*/tsconfig.json'],
            },
        },
    },
    rules: {
        // TypeScript specific
        '@typescript-eslint/explicit-function-return-type': 'warn',
        '@typescript-eslint/explicit-module-boundary-types': 'warn',
        '@typescript-eslint/no-explicit-any': 'error',
        // `_`-prefix already means "deliberately unused" throughout this repo — including the
        // destructure-to-omit idiom (`const { statusCode: _ignored, ...rest } = body`), which is a
        // VAR, not an arg. Cover vars and caught errors too so the convention holds everywhere.
        '@typescript-eslint/no-unused-vars': [
            'error',
            { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
        ],
        // OFF — this rule REWRITES code from a type view we cannot reproduce faithfully. ESLint resolves
        // types through the root-level tsconfig.eslint.json, while each package builds (and ts-jest
        // type-checks) through its own tsconfig; in a pnpm workspace those two resolve @types differently.
        // Concretely, it deleted a REQUIRED non-null assertion in
        // apps/worker-sim/src/simulation/variant-runner.spec.ts ("the receiver accepts the original type"),
        // and ts-jest then failed the whole suite with TS2345 — 15 tests silently vanished from the run.
        // Every other rule here only REPORTS; this is the only one whose --fix can break the build, so the
        // cost of a false positive is not symmetric with its value.
        '@typescript-eslint/no-unnecessary-type-assertion': 'off',
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/await-thenable': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
        '@typescript-eslint/require-await': 'warn',

        // Import ordering
        'import/order': [
            'error',
            {
                groups: [
                    'builtin',
                    'external',
                    'internal',
                    'parent',
                    'sibling',
                    'index',
                ],
                'newlines-between': 'always',
                alphabetize: {
                    order: 'asc',
                    caseInsensitive: true,
                },
            },
        ],
        'import/no-duplicates': 'error',

        // OFF — TypeScript already enforces these, correctly and faster; the plugin's own resolver does
        // not model `esModuleInterop`, so `import dotenv from 'dotenv'` (valid, and what tsc accepts)
        // is reported as an error. This is typescript-eslint's documented recommendation for TS repos.
        'import/default': 'off',
        'import/named': 'off',
        'import/namespace': 'off',
        'import/no-named-as-default-member': 'off',

        // `any` policy, in two halves. Writing `any` is an ERROR — that is a deliberate act at a place
        // the author controls, and it is where the type hole is actually introduced. Its downstream
        // PROPAGATION is a warning: those sites are consequences, not causes, and most originate at
        // boundaries we do not own (Prisma Json columns, passport, dotenv). Erroring on the propagation
        // would force ~70 defensive casts that hide the hole instead of closing it, while erroring on
        // the source stops new ones. Fix the origin and the warnings disappear on their own.
        '@typescript-eslint/no-unsafe-assignment': 'warn',
        '@typescript-eslint/no-unsafe-member-access': 'warn',
        '@typescript-eslint/no-unsafe-argument': 'warn',
        '@typescript-eslint/no-unsafe-return': 'warn',
        '@typescript-eslint/no-unsafe-call': 'warn',

        // General
        'no-console': 'warn',
        'no-debugger': 'error',
        'prefer-const': 'error',
        'no-var': 'error',
    },
    overrides: [
        {
            files: ['*.spec.ts', '*.test.ts', '**/__tests__/**/*.ts'],
            // A jest mock is `any` by construction: jest.fn() returns it, mock factories return it, and
            // it flows straight back into the code under test. These four were already off for that
            // reason; the rest of the family fired on the exact same idiom and are off for the exact
            // same reason. This is completing an existing decision, not widening it.
            rules: {
                '@typescript-eslint/no-explicit-any': 'off',
                '@typescript-eslint/no-unsafe-assignment': 'off',
                '@typescript-eslint/no-unsafe-member-access': 'off',
                '@typescript-eslint/no-unsafe-call': 'off',
                '@typescript-eslint/no-unsafe-argument': 'off',
                '@typescript-eslint/no-unsafe-return': 'off',
                // `expect(obj.method)` reads a method without calling it — the documented false
                // positive for this rule, and the only way to assert on a spy.
                '@typescript-eslint/unbound-method': 'off',
                // `jest.mock('x', () => require('y'))` — the hoisting rules make require the only option.
                '@typescript-eslint/no-var-requires': 'off',
            },
        },
    ],
};