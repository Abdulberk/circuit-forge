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
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
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

        // General
        'no-console': 'warn',
        'no-debugger': 'error',
        'prefer-const': 'error',
        'no-var': 'error',
    },
    overrides: [
        {
            files: ['*.spec.ts', '*.test.ts', '**/__tests__/**/*.ts'],
            rules: {
                '@typescript-eslint/no-explicit-any': 'off',
                '@typescript-eslint/no-unsafe-assignment': 'off',
                '@typescript-eslint/no-unsafe-member-access': 'off',
                '@typescript-eslint/no-unsafe-call': 'off',
            },
        },
    ],
};