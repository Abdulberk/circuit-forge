/**
 * AuthService.login brute-force lockout + timing-safe behavior. argon2 is mocked so verify outcomes
 * are controlled and the suite stays fast; prisma/jwt/config are stubs.
 */
import { BadRequestException, ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';

import { EmailService } from '../email/email.service';
import type { PrismaService } from '../prisma/prisma.service';

import { AuthService } from './auth.service';

jest.mock('argon2', () => ({
    hash: jest.fn(async () => '$argon2id$dummy'),
    verify: jest.fn(),
}));
const mockedVerify = argon2.verify as jest.MockedFunction<typeof argon2.verify>;

interface UserRow {
    id: string;
    email: string;
    name: string;
    passwordHash: string;
    failedLoginCount: number;
    lastFailedLoginAt: Date | null;
    lockedUntil: Date | null;
}

function makeService(user: Partial<UserRow> | null) {
    const row: UserRow | null = user
        ? {
              id: 'u1',
              email: 'a@b.com',
              name: 'A',
              passwordHash: '$argon2id$real',
              failedLoginCount: 0,
              lastFailedLoginAt: null,
              lockedUntil: null,
              ...user,
          }
        : null;
    const update = jest.fn(async (_arg: { where: unknown; data: Record<string, unknown> }) => ({}));
    const prisma = {
        user: { findUnique: jest.fn(async () => row), update },
        ...tokenTables(),
    } as unknown as PrismaService;
    const jwt = { signAsync: jest.fn(async () => 'token') } as unknown as JwtService;
    const config = { get: jest.fn(() => 'secret') } as unknown as ConfigService;
    const email = emailStub();
    return { svc: new AuthService(prisma, jwt, config, email), update };
}

/** refreshToken + auditLog stubs every flow needs (token issuance + fire-and-forget audits). */
const tokenTables = () => ({
    refreshToken: {
        create: jest.fn(async (_arg?: unknown) => ({})),
        findUnique: jest.fn<Promise<Record<string, unknown> | null>, [unknown?]>(async () => null),
        updateMany: jest.fn(async (_arg?: { where: Record<string, unknown> }) => ({ count: 1 })),
        deleteMany: jest.fn(async (_arg?: unknown) => ({ count: 0 })),
    },
    auditLog: { create: jest.fn(async (_arg?: unknown) => ({})) },
});

const emailStub = () =>
    ({
        sendVerificationEmail: jest.fn(async () => undefined),
        sendPasswordResetEmail: jest.fn(async () => undefined),
    }) as unknown as EmailService;

describe('AuthService.login — lockout & timing', () => {
    beforeEach(() => jest.clearAllMocks());

    it('rejects a locked account with a 429 ACCOUNT_LOCKED without checking the password', async () => {
        const { svc } = makeService({ lockedUntil: new Date(Date.now() + 60_000) });
        const err = await svc.login('a@b.com', 'pw').catch((e) => e);
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(429);
        expect((err as HttpException).getResponse()).toMatchObject({ code: 'ACCOUNT_LOCKED' });
        expect(mockedVerify).not.toHaveBeenCalled(); // password never checked while locked
    });

    it('increments the failed counter on a bad password (below threshold)', async () => {
        mockedVerify.mockResolvedValue(false);
        const { svc, update } = makeService({ failedLoginCount: 2 });
        await expect(svc.login('a@b.com', 'bad')).rejects.toBeInstanceOf(UnauthorizedException);
        expect(update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ failedLoginCount: 3 }) }),
        );
        expect(update.mock.calls[0]![0].data.lockedUntil).toBeUndefined();
    });

    it('locks the account on the 5th consecutive failure and resets the counter', async () => {
        mockedVerify.mockResolvedValue(false);
        const { svc, update } = makeService({ failedLoginCount: 4 });
        await expect(svc.login('a@b.com', 'bad')).rejects.toBeInstanceOf(UnauthorizedException);
        const data = update.mock.calls[0]![0].data as { failedLoginCount: number; lockedUntil: Date };
        expect(data.failedLoginCount).toBe(0);
        expect(data.lockedUntil).toBeInstanceOf(Date);
        expect(data.lockedUntil.getTime()).toBeGreaterThan(Date.now());
    });

    it('clears counters on a successful login', async () => {
        mockedVerify.mockResolvedValue(true);
        const { svc, update } = makeService({ failedLoginCount: 3 });
        await svc.login('a@b.com', 'good');
        expect(update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { failedLoginCount: 0, lockedUntil: null } }),
        );
    });

    it('does NOT write on a clean first-attempt success', async () => {
        mockedVerify.mockResolvedValue(true);
        const { svc, update } = makeService({ failedLoginCount: 0, lockedUntil: null });
        await svc.login('a@b.com', 'good');
        expect(update).not.toHaveBeenCalled();
    });

    it('still runs a verify (timing equalizer) when the email is unknown, then 401', async () => {
        mockedVerify.mockResolvedValue(false);
        const { svc } = makeService(null);
        await expect(svc.login('nobody@b.com', 'pw')).rejects.toBeInstanceOf(UnauthorizedException);
        expect(mockedVerify).toHaveBeenCalledTimes(1); // dummy verify ran despite no user
    });

    it('normalizes the email (trim + lowercase) before the lookup', async () => {
        mockedVerify.mockResolvedValue(true);
        const findUnique = jest.fn(async () => null);
        const prisma = { user: { findUnique, update: jest.fn() } } as unknown as PrismaService;
        const svc = new AuthService(
            prisma,
            { signAsync: jest.fn(async () => 't') } as unknown as JwtService,
            { get: jest.fn() } as unknown as ConfigService,
            emailStub(),
        );
        await svc.login('  USER@Example.COM ', 'pw').catch(() => undefined);
        expect(findUnique).toHaveBeenCalledWith({ where: { email: 'user@example.com' } });
    });

    it('blocks login when REQUIRE_EMAIL_VERIFICATION=true and the user is unverified', async () => {
        mockedVerify.mockResolvedValue(true);
        const prisma = {
            user: {
                findUnique: jest.fn(async () => ({
                    id: 'u1',
                    email: 'a@b.com',
                    name: 'A',
                    passwordHash: 'h',
                    failedLoginCount: 0,
                    lockedUntil: null,
                    emailVerified: false,
                })),
                update: jest.fn(),
            },
        } as unknown as PrismaService;
        const svc = new AuthService(
            prisma,
            { signAsync: jest.fn(async () => 't') } as unknown as JwtService,
            {
                get: jest.fn((k: string) => (k === 'REQUIRE_EMAIL_VERIFICATION' ? 'true' : undefined)),
            } as unknown as ConfigService,
            emailStub(),
        );
        const err = await svc.login('a@b.com', 'good').catch((e) => e);
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    });
});

describe('AuthService — email verification & password reset', () => {
    beforeEach(() => jest.clearAllMocks());

    /** Builder exposing findFirst/update + the email stub for the token flows. */
    function makeLifecycle(found: Record<string, unknown> | null) {
        const findFirst = jest.fn(async (_arg: { where: Record<string, unknown> }) => found);
        const findUnique = jest.fn(async (_arg: { where: Record<string, unknown> }) => found);
        const update = jest.fn(async (_arg: { where: unknown; data: Record<string, unknown> }) => ({}));
        const prisma = { user: { findFirst, findUnique, update }, ...tokenTables() } as unknown as PrismaService;
        const email = emailStub();
        const svc = new AuthService(
            prisma,
            { signAsync: jest.fn(async () => 't') } as unknown as JwtService,
            { get: jest.fn() } as unknown as ConfigService,
            email,
        );
        return { svc, findFirst, findUnique, update, email };
    }

    it('verifyEmail flips emailVerified and clears the token on a valid token', async () => {
        const { svc, findFirst, update } = makeLifecycle({ id: 'u1' });
        await svc.verifyEmail('rawtoken');
        // looked up by HASH (never the raw token) with an expiry guard
        const where = findFirst.mock.calls[0]![0].where;
        expect(where).toHaveProperty('emailVerificationTokenHash');
        expect(where.emailVerificationTokenHash).not.toBe('rawtoken');
        expect(update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ emailVerified: true, emailVerificationTokenHash: null }),
            }),
        );
    });

    it('verifyEmail rejects an unknown/expired token (400)', async () => {
        const { svc, update } = makeLifecycle(null);
        await expect(svc.verifyEmail('bad')).rejects.toBeInstanceOf(BadRequestException);
        expect(update).not.toHaveBeenCalled();
    });

    it('forgotPassword is enumeration-safe: resolves and sends nothing for an unknown email', async () => {
        const { svc, update, email } = makeLifecycle(null);
        await expect(svc.forgotPassword('nobody@x.com')).resolves.toBeUndefined();
        expect(update).not.toHaveBeenCalled();
        expect(email.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('forgotPassword stores a hashed reset token and emails the link for a known user', async () => {
        const { svc, update, email } = makeLifecycle({ id: 'u1', email: 'a@b.com' });
        await svc.forgotPassword('a@b.com');
        expect(update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ passwordResetTokenHash: expect.any(String) }) }),
        );
        expect(email.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    });

    it('resetPassword sets a new hash, clears the token AND the lockout, on a valid token', async () => {
        mockedVerify.mockClear();
        const { svc, update } = makeLifecycle({ id: 'u1' });
        await svc.resetPassword('rawtoken', 'new-strong-password');
        const data = update.mock.calls[0]![0].data;
        expect(data.passwordHash).toBeDefined();
        expect(data.passwordResetTokenHash).toBeNull();
        expect(data.failedLoginCount).toBe(0);
        expect(data.lockedUntil).toBeNull();
    });

    it('resetPassword rejects an unknown/expired token (400)', async () => {
        const { svc, update } = makeLifecycle(null);
        await expect(svc.resetPassword('bad', 'whatever12')).rejects.toBeInstanceOf(BadRequestException);
        expect(update).not.toHaveBeenCalled();
    });
});

describe('AuthService — refresh rotation & server-side logout', () => {
    beforeEach(() => jest.clearAllMocks());

    const sha256 = (s: string) => require('crypto').createHash('sha256').update(s).digest('hex');

    /** Stub where jwt.verify yields {sub,email,jti} and the refresh row is controllable. */
    function makeRotation(row: Record<string, unknown> | null, verifyImpl?: () => unknown) {
        const tables = tokenTables();
        tables.refreshToken.findUnique = jest.fn(async () => row);
        const prisma = {
            user: { findUnique: jest.fn(async () => ({ id: 'u1', email: 'a@b.com', name: 'A' })), update: jest.fn() },
            ...tables,
        } as unknown as PrismaService;
        // refresh() wraps claim+issue in a transaction; the stub runs the callback with the same stub.
        (prisma as unknown as { $transaction: unknown }).$transaction = jest.fn(async (fn: (tx: unknown) => unknown) =>
            fn(prisma),
        );
        const jwt = {
            signAsync: jest.fn(async () => 'newtoken'),
            verify: jest.fn(verifyImpl ?? (() => ({ sub: 'u1', email: 'a@b.com', jti: 'jti-1' }))),
        } as unknown as JwtService;
        const svc = new AuthService(
            prisma,
            jwt,
            { get: jest.fn(() => 'refresh-secret') } as unknown as ConfigService,
            emailStub(),
        );
        return { svc, tables, jwt };
    }

    const liveRow = (token: string, over: Record<string, unknown> = {}) => ({
        jti: 'jti-1',
        userId: 'u1',
        familyId: 'fam-1',
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + 1000_000),
        usedAt: null,
        revokedAt: null,
        ...over,
    });

    it('rotates a fresh token: claims the row (usedAt) and issues a successor in the SAME family', async () => {
        const { svc, tables } = makeRotation(liveRow('old-token'));
        const out = await svc.refresh('old-token');
        expect(out.refreshToken).toBe('newtoken');
        // atomic claim on the old row
        expect(tables.refreshToken.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { jti: 'jti-1', usedAt: null } }),
        );
        // successor registered in the same family
        const created = (tables.refreshToken.create as jest.Mock).mock.calls[0][0] as { data: { familyId: string } };
        expect(created.data.familyId).toBe('fam-1');
    });

    it('REUSE of an already-used token revokes the entire family and 401s', async () => {
        const { svc, tables } = makeRotation(liveRow('old-token', { usedAt: new Date() }));
        await expect(svc.refresh('old-token')).rejects.toBeInstanceOf(UnauthorizedException);
        expect(tables.refreshToken.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { familyId: 'fam-1', revokedAt: null } }),
        );
        expect(tables.refreshToken.create).not.toHaveBeenCalled(); // no successor for a thief
    });

    it('rejects revoked, expired, hash-mismatched, and unknown tokens without touching the family', async () => {
        for (const row of [
            liveRow('old-token', { revokedAt: new Date() }),
            liveRow('old-token', { expiresAt: new Date(Date.now() - 1) }),
            liveRow('DIFFERENT-token'), // hash mismatch
            null, // no row at all
        ]) {
            const { svc, tables } = makeRotation(row as Record<string, unknown> | null);
            await expect(svc.refresh('old-token')).rejects.toBeInstanceOf(UnauthorizedException);
            expect(tables.refreshToken.create).not.toHaveBeenCalled();
        }
    });

    it('rejects a legacy refresh token without a jti claim', async () => {
        const { svc } = makeRotation(null, () => ({ sub: 'u1', email: 'a@b.com' })); // no jti
        await expect(svc.refresh('legacy')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('a lost concurrent-claim race 401s WITHOUT revoking the family', async () => {
        const { svc, tables } = makeRotation(liveRow('old-token'));
        tables.refreshToken.updateMany = jest.fn(
            async (arg: { where: Record<string, unknown> }) => ('jti' in arg.where ? { count: 0 } : { count: 1 }), // claim fails; family ops would succeed
        ) as never;
        await expect(svc.refresh('old-token')).rejects.toBeInstanceOf(UnauthorizedException);
        // only the claim ran — no family revocation for a clean race
        const familyCalls = (tables.refreshToken.updateMany as jest.Mock).mock.calls.filter(
            (c) => 'familyId' in (c[0] as { where: Record<string, unknown> }).where,
        );
        expect(familyCalls).toHaveLength(0);
    });

    it('logout revokes the token’s family; allDevices revokes everything of the user', async () => {
        const { svc, tables } = makeRotation(liveRow('tok'));
        await svc.logout('tok');
        expect(tables.refreshToken.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { familyId: 'fam-1', revokedAt: null } }),
        );
        const all = makeRotation(liveRow('tok'));
        await all.svc.logout('tok', true);
        expect(all.tables.refreshToken.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'u1', revokedAt: null } }),
        );
    });

    it('logout with a garbage/absent token resolves silently (always 204 semantics)', async () => {
        const { svc, tables } = makeRotation(null, () => {
            throw new Error('bad sig');
        });
        await expect(svc.logout('garbage')).resolves.toBeUndefined();
        await expect(svc.logout(undefined)).resolves.toBeUndefined();
        expect(tables.refreshToken.updateMany).not.toHaveBeenCalled();
    });
});
