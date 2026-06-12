import { validateEnv } from './env.validation';

const STRONG = 'x'.repeat(40);
const STRONG2 = 'y'.repeat(40);

describe('validateEnv', () => {
    it('passes through a valid config with strong, distinct secrets', () => {
        const cfg = { JWT_SECRET: STRONG, JWT_REFRESH_SECRET: STRONG2, SOMETHING_ELSE: 'kept' };
        expect(validateEnv(cfg)).toBe(cfg); // returned untouched (no stripping)
    });

    it('throws when a JWT secret is missing', () => {
        expect(() => validateEnv({ JWT_REFRESH_SECRET: STRONG2 })).toThrow(/JWT_SECRET must be set/);
    });

    it('throws when a JWT secret is shorter than 32 chars', () => {
        expect(() => validateEnv({ JWT_SECRET: 'short', JWT_REFRESH_SECRET: STRONG2 })).toThrow(
            /JWT_SECRET must be set to a string of at least 32/,
        );
    });

    it('throws when both secrets are identical', () => {
        expect(() => validateEnv({ JWT_SECRET: STRONG, JWT_REFRESH_SECRET: STRONG })).toThrow(/must be different/);
    });

    it('reports all problems at once', () => {
        const err = (() => {
            try {
                validateEnv({});
                return null;
            } catch (e) {
                return e as Error;
            }
        })();
        expect(err?.message).toMatch(/JWT_SECRET must be set/);
        expect(err?.message).toMatch(/JWT_REFRESH_SECRET must be set/);
    });
});
