/**
 * AuthService.login brute-force lockout + timing-safe behavior. argon2 is mocked so verify outcomes
 * are controlled and the suite stays fast; prisma/jwt/config are stubs.
 */
import { HttpException, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';

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
    } as unknown as PrismaService;
    const jwt = { signAsync: jest.fn(async () => 'token') } as unknown as JwtService;
    const config = { get: jest.fn(() => 'secret') } as unknown as ConfigService;
    return { svc: new AuthService(prisma, jwt, config), update };
}

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
        expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ failedLoginCount: 3 }) }));
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
        expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { failedLoginCount: 0, lockedUntil: null } }));
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
});
