/**
 * Shared recipe for emailed link tokens (org invitations, and — by the same pattern — email-verify /
 * password-reset). A cryptographically-random token travels ONLY in the emailed link; the server stores
 * just its sha256 hash and matches by hashing the presented token. Mirrors AuthService's private helper.
 */
import { randomBytes, createHash } from 'crypto';

/** A random URL-safe token + its sha256 hash. Email the `token`; persist only the `hash`. */
export function newLinkToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: hashLinkToken(token) };
}

export function hashLinkToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

/** Canonical email form used for matching (trim + lowercase) — must match AuthService.normalizeEmail. */
export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}
