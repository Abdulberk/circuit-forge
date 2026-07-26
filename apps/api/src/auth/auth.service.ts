/**
 * Auth Service
 */
import { randomBytes, randomUUID, createHash } from 'crypto';

import {
    Injectable,
    UnauthorizedException,
    ConflictException,
    BadRequestException,
    ForbiddenException,
    HttpException,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';

import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';

/** Request metadata threaded from the controller into audit rows / session records. */
export interface AuthContext {
    ip?: string;
    userAgent?: string;
}

/** Lock an account after this many consecutive failed logins... */
const MAX_FAILED_LOGINS = 5;
/** ...for this long. After it elapses the next attempt starts a fresh count. */
const LOCKOUT_MS = 15 * 60 * 1000;
/** Email-verification links are valid for 24h; password-reset links for 1h (tighter — higher risk). */
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/**
 * A pre-computed argon2 hash to verify against when the email isn't registered, so a failed login
 * costs the same CPU whether or not the account exists — closing a user-enumeration timing oracle.
 * Computed once at module load (verify cost ≈ a real verify).
 */
const DUMMY_VERIFY_HASH = argon2.hash('cf-login-timing-equalizer');

export interface JwtPayload {
    sub: string;
    email: string;
    /** Refresh tokens only: the server-side rotation row's key. Absent on access tokens. */
    jti?: string;
}

/** Refresh tokens live this long; must match the '7d' passed to signAsync below. */
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface TokensResponse {
    accessToken: string;
    refreshToken: string;
    user: {
        id: string;
        email: string;
        name: string;
    };
}

@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
        private readonly email: EmailService,
    ) { }

    /** Canonical email form: trimmed + lowercased, so case/whitespace variants are one account. */
    private normalizeEmail(email: string): string {
        return email.trim().toLowerCase();
    }

    /** A random link token + its sha256 hash. The raw token is emailed; only the hash is stored. */
    private newToken(): { token: string; hash: string } {
        const token = randomBytes(32).toString('base64url');
        return { token, hash: this.hashToken(token) };
    }
    private hashToken(token: string): string {
        return createHash('sha256').update(token).digest('hex');
    }

    async register(email: string, password: string, name: string, ctx: AuthContext = {}): Promise<TokensResponse> {
        const normEmail = this.normalizeEmail(email);

        // Check if user exists
        const existing = await this.prisma.user.findUnique({ where: { email: normEmail } });
        if (existing) {
            throw new ConflictException('Email already registered');
        }

        // Hash password
        const passwordHash = await argon2.hash(password);

        // Create user with a pending email-verification token (emailVerified defaults to false).
        const verify = this.newToken();
        const user = await this.prisma.user.create({
            data: {
                email: normEmail,
                passwordHash,
                name,
                emailVerificationTokenHash: verify.hash,
                emailVerificationExpiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
            },
        });

        // Create personal organization
        const org = await this.prisma.organization.create({
            data: {
                name: `${name}'s Workspace`,
                memberships: {
                    create: {
                        userId: user.id,
                        role: 'OWNER',
                    },
                },
            },
        });

        await this.email.sendVerificationEmail(normEmail, verify.token);
        this.logger.log({ userId: user.id, orgId: org.id }, 'User registered');
        this.audit(user.id, 'auth.register', { ...ctx });

        return this.generateTokens(user, ctx);
    }

    async login(email: string, password: string, ctx: AuthContext = {}): Promise<TokensResponse> {
        const normEmail = this.normalizeEmail(email);
        const user = await this.prisma.user.findUnique({ where: { email: normEmail } });
        if (!user) {
            // Equalize timing with the real path so a missing account isn't detectable by latency.
            await argon2.verify(await DUMMY_VERIFY_HASH, password).catch(() => false);
            throw new UnauthorizedException('Invalid credentials');
        }

        // Brute-force lockout: while locked, reject without even checking the password.
        if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
            throw this.lockedError(user.lockedUntil);
        }

        const valid = await argon2.verify(user.passwordHash, password);
        if (!valid) {
            await this.recordFailedLogin(user.id, user.failedLoginCount, ctx);
            this.audit(user.id, 'auth.login_failed', { ...ctx });
            throw new UnauthorizedException('Invalid credentials');
        }

        // Optional verified-email gate (opt-in via REQUIRE_EMAIL_VERIFICATION; off by default so this
        // doesn't lock anyone out until the product decides to enforce it).
        if (!user.emailVerified && this.configService.get<string>('REQUIRE_EMAIL_VERIFICATION') === 'true') {
            throw new ForbiddenException({
                code: 'EMAIL_NOT_VERIFIED',
                message: 'Please verify your email address before signing in.',
            });
        }

        // Success — clear any accumulated failures / expired lock.
        if (user.failedLoginCount > 0 || user.lockedUntil) {
            await this.prisma.user.update({
                where: { id: user.id },
                data: { failedLoginCount: 0, lockedUntil: null },
            });
        }

        // Housekeeping: drop this user's long-expired refresh rows so the table can't grow unbounded.
        void this.prisma.refreshToken
            .deleteMany({ where: { userId: user.id, expiresAt: { lt: new Date() } } })
            .catch(() => undefined);

        this.audit(user.id, 'auth.login', { ...ctx });
        return this.generateTokens(user, ctx);
    }

    /** Confirm an email-verification token. Idempotent-ish: a valid, unexpired token flips the flag. */
    async verifyEmail(token: string): Promise<void> {
        const hash = this.hashToken(token);
        const user = await this.prisma.user.findFirst({
            where: { emailVerificationTokenHash: hash, emailVerificationExpiresAt: { gt: new Date() } },
        });
        if (!user) {
            throw new BadRequestException('Invalid or expired verification link.');
        }
        await this.prisma.user.update({
            where: { id: user.id },
            data: { emailVerified: true, emailVerificationTokenHash: null, emailVerificationExpiresAt: null },
        });
        this.logger.log({ userId: user.id }, 'Email verified');
        this.audit(user.id, 'auth.email_verified');
    }

    /** Re-send a verification email. Enumeration-safe: always resolves, regardless of account state. */
    async resendVerification(email: string): Promise<void> {
        const user = await this.prisma.user.findUnique({ where: { email: this.normalizeEmail(email) } });
        if (!user || user.emailVerified) return; // nothing to do — but don't reveal which
        const verify = this.newToken();
        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                emailVerificationTokenHash: verify.hash,
                emailVerificationExpiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
            },
        });
        await this.email.sendVerificationEmail(user.email, verify.token);
    }

    /** Begin a password reset. Enumeration-safe: always resolves whether or not the email exists. */
    async forgotPassword(email: string): Promise<void> {
        const user = await this.prisma.user.findUnique({ where: { email: this.normalizeEmail(email) } });
        if (!user) return; // silent — never reveal whether an email is registered
        const reset = this.newToken();
        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                passwordResetTokenHash: reset.hash,
                passwordResetExpiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
            },
        });
        await this.email.sendPasswordResetEmail(user.email, reset.token);
        this.logger.log({ userId: user.id }, 'Password reset requested');
        this.audit(user.id, 'auth.password_reset_requested');
    }

    /** Complete a password reset: set the new password and invalidate the (single-use) token + lock. */
    async resetPassword(token: string, newPassword: string): Promise<void> {
        const hash = this.hashToken(token);
        const user = await this.prisma.user.findFirst({
            where: { passwordResetTokenHash: hash, passwordResetExpiresAt: { gt: new Date() } },
        });
        if (!user) {
            throw new BadRequestException('Invalid or expired password reset link.');
        }
        const passwordHash = await argon2.hash(newPassword);
        await this.prisma.user.update({
            where: { id: user.id },
            data: {
                passwordHash,
                passwordResetTokenHash: null,
                passwordResetExpiresAt: null,
                // A successful reset also clears any brute-force lock — the legitimate owner is back in.
                failedLoginCount: 0,
                lockedUntil: null,
            },
        });
        // A password reset means the old credential may be compromised — kill EVERY live session.
        await this.prisma.refreshToken.updateMany({
            where: { userId: user.id, revokedAt: null },
            data: { revokedAt: new Date() },
        });
        this.logger.log({ userId: user.id }, 'Password reset completed');
        this.audit(user.id, 'auth.password_reset_completed');
    }

    /** Record a failed attempt; once the threshold is hit, lock the account and reset the counter. */
    private async recordFailedLogin(userId: string, currentCount: number, ctx: AuthContext = {}): Promise<void> {
        const count = currentCount + 1;
        const locked = count >= MAX_FAILED_LOGINS;
        await this.prisma.user.update({
            where: { id: userId },
            data: {
                failedLoginCount: locked ? 0 : count,
                lastFailedLoginAt: new Date(),
                ...(locked ? { lockedUntil: new Date(Date.now() + LOCKOUT_MS) } : {}),
            },
        });
        if (locked) {
            this.logger.warn({ userId }, 'Account locked after repeated failed logins');
            this.audit(userId, 'auth.account_locked', { ...ctx });
        }
    }

    /** 429 with a distinct `code` so the frontend can show a "locked" message (not a generic retry). */
    private lockedError(lockedUntil: Date): HttpException {
        const retryAfterSeconds = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000));
        return new HttpException(
            {
                code: 'ACCOUNT_LOCKED',
                retryAfterSeconds,
                message: 'Account temporarily locked due to too many failed login attempts. Try again later.',
            },
            HttpStatus.TOO_MANY_REQUESTS,
        );
    }

    /**
     * Rotate a refresh token. State machine (every refresh JWT has a server-side row keyed by jti):
     *  - bad signature / no jti / no row / hash mismatch / expired / revoked → 401.
     *  - row already USED → the token was rotated before: this is REUSE (theft evidence, or a client
     *    that ignored a rotation response). The ENTIRE family is revoked and the event audited —
     *    whoever holds the successor token is cut off too.
     *  - fresh row → atomically claim it (used), issue a successor pair in the SAME family.
     * The atomic updateMany claim means two concurrent uses of one token can't both rotate: the
     * loser takes the reuse path. Clients must single-flight their refresh (the brief mandates it).
     */
    async refresh(refreshToken: string, ctx: AuthContext = {}): Promise<TokensResponse> {
        let payload: JwtPayload;
        try {
            payload = this.jwtService.verify<JwtPayload>(refreshToken, {
                secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
            });
        } catch {
            throw new UnauthorizedException('Invalid refresh token');
        }
        if (!payload.jti) {
            // Legacy token from before rotation existed — no server-side row, can't be trusted/rotated.
            throw new UnauthorizedException('Invalid refresh token');
        }

        const row = await this.prisma.refreshToken.findUnique({ where: { jti: payload.jti } });
        if (!row || row.tokenHash !== this.hashToken(refreshToken) || row.revokedAt || row.expiresAt.getTime() <= Date.now()) {
            throw new UnauthorizedException('Invalid refresh token');
        }

        if (row.usedAt) {
            await this.revokeFamily(row.familyId);
            this.audit(row.userId, 'auth.refresh_reuse_detected', { familyId: row.familyId, ...ctx });
            this.logger.warn({ userId: row.userId, familyId: row.familyId }, 'Refresh-token reuse detected — family revoked');
            throw new UnauthorizedException('Invalid refresh token');
        }

        const user = await this.prisma.user.findUnique({ where: { id: row.userId } });
        if (!user) {
            throw new UnauthorizedException('Invalid refresh token');
        }

        // Claim the old row AND issue the successor in ONE transaction — either both happen or
        // neither. Without this, a failed successor-insert AFTER the claim commits would leave a
        // used-but-successorless token; the client's retry would then hit the reuse branch and
        // revoke the whole family — a transient DB error wrongly logging out a legitimate user.
        // Concurrency unchanged: the atomic `usedAt: null` claim still lets exactly one of N
        // concurrent callers win (count===1); the losers 401 WITHOUT revoking the family.
        return this.prisma.$transaction(async (tx) => {
            const claimed = await tx.refreshToken.updateMany({
                where: { jti: payload.jti, usedAt: null },
                data: { usedAt: new Date() },
            });
            if (claimed.count !== 1) {
                throw new UnauthorizedException('Invalid refresh token');
            }
            return this.generateTokens(user, { familyId: row.familyId, ...ctx }, tx);
        });
    }

    /**
     * Server-side logout. Best-effort by design (always succeeds): given the refresh token, its whole
     * family is revoked — the access token (≤15m) is the only thing that survives, which is the
     * standard tradeoff for stateless access tokens. `allDevices` revokes every session of that user.
     */
    async logout(refreshToken?: string, allDevices = false, ctx: AuthContext = {}): Promise<void> {
        if (!refreshToken) return;
        let payload: JwtPayload;
        try {
            payload = this.jwtService.verify<JwtPayload>(refreshToken, {
                secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
                ignoreExpiration: true, // an expired session can still be explicitly cleaned up
            });
        } catch {
            return; // invalid token — nothing to revoke, still 204
        }
        if (!payload.jti) return;
        const row = await this.prisma.refreshToken.findUnique({ where: { jti: payload.jti } });
        if (!row || row.tokenHash !== this.hashToken(refreshToken)) return;

        if (allDevices) {
            await this.prisma.refreshToken.updateMany({
                where: { userId: row.userId, revokedAt: null },
                data: { revokedAt: new Date() },
            });
        } else {
            await this.revokeFamily(row.familyId);
        }
        this.audit(row.userId, 'auth.logout', { allDevices, ...ctx });
    }

    private async revokeFamily(familyId: string): Promise<void> {
        await this.prisma.refreshToken.updateMany({
            where: { familyId, revokedAt: null },
            data: { revokedAt: new Date() },
        });
    }

    async validateUser(userId: string) {
        return this.prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, email: true, name: true, createdAt: true },
        });
    }

    /**
     * Issue an access+refresh pair. The refresh token carries a jti and is registered server-side —
     * in an existing family on rotation, or a brand-new family (= a new login/device session).
     */
    private async generateTokens(
        user: { id: string; email: string; name: string },
        session: { familyId?: string } & AuthContext = {},
        db: PrismaService | Prisma.TransactionClient = this.prisma,
    ): Promise<TokensResponse> {
        const jti = randomUUID();
        const familyId = session.familyId ?? randomUUID();
        const base: JwtPayload = { sub: user.id, email: user.email };

        const [accessToken, refreshToken] = await Promise.all([
            this.jwtService.signAsync(base),
            this.jwtService.signAsync({ ...base, jti }, {
                secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
                // Single source of truth with the DB expiresAt below (keep the JWT exp == row exp).
                expiresIn: Math.floor(REFRESH_TTL_MS / 1000),
            }),
        ]);

        await db.refreshToken.create({
            data: {
                jti,
                userId: user.id,
                familyId,
                tokenHash: this.hashToken(refreshToken),
                expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
                ip: session.ip,
                userAgent: session.userAgent,
            },
        });

        return {
            accessToken,
            refreshToken,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
            },
        };
    }

    /**
     * Fire-and-forget audit write (auth events are user-scoped: orgId null). An audit failure must
     * never break the auth flow itself — it is logged and swallowed.
     */
    private audit(userId: string, action: string, meta: Record<string, unknown> = {}): void {
        void this.prisma.auditLog
            .create({
                data: { userId, action, entityType: 'User', entityId: userId, meta: meta as Prisma.InputJsonValue },
            })
            .catch((e) => this.logger.warn(`audit write failed for ${action}: ${e instanceof Error ? e.message : e}`));
    }
}