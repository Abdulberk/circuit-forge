/**
 * Fail-fast environment validation, wired into ConfigModule.forRoot({ validate }). Runs once at boot
 * and throws (aborting startup) if a security-critical variable is missing or weak — so the app can
 * NEVER come up with forgeable JWTs from an unset/short/duplicated signing secret. Non-critical vars
 * are passed through untouched (this validator only asserts; it does not strip or transform config).
 */

/** JWT signing secrets must be long enough that brute-forcing the key is infeasible. */
const MIN_SECRET_LENGTH = 32;

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
    const errors: string[] = [];

    const requireStrongSecret = (key: string): string | undefined => {
        const value = config[key];
        if (typeof value !== 'string' || value.trim().length < MIN_SECRET_LENGTH) {
            errors.push(`${key} must be set to a string of at least ${MIN_SECRET_LENGTH} characters`);
            return undefined;
        }
        return value;
    };

    const jwtSecret = requireStrongSecret('JWT_SECRET');
    const jwtRefreshSecret = requireStrongSecret('JWT_REFRESH_SECRET');

    // A shared access/refresh secret means an access token can be replayed as a refresh token (and
    // vice-versa) — they must be independent.
    if (jwtSecret && jwtRefreshSecret && jwtSecret === jwtRefreshSecret) {
        errors.push('JWT_SECRET and JWT_REFRESH_SECRET must be different values');
    }

    if (errors.length > 0) {
        throw new Error(
            `Invalid environment configuration — refusing to start:\n  - ${errors.join('\n  - ')}\n` +
                `Set strong, distinct secrets (e.g. \`openssl rand -base64 48\`) in your environment.`,
        );
    }

    return config;
}
