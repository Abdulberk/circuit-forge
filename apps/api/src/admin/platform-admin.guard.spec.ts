import { ForbiddenException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlatformRole } from '@prisma/client';

import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { hasPlatformRole, PLATFORM_ROLE_RANK } from './platform-role.util';

describe('platform-role.util', () => {
    it('orders NONE < SUPPORT < OPERATOR < ADMIN', () => {
        expect(PLATFORM_ROLE_RANK.NONE).toBeLessThan(PLATFORM_ROLE_RANK.SUPPORT);
        expect(PLATFORM_ROLE_RANK.SUPPORT).toBeLessThan(PLATFORM_ROLE_RANK.OPERATOR);
        expect(PLATFORM_ROLE_RANK.OPERATOR).toBeLessThan(PLATFORM_ROLE_RANK.ADMIN);
    });

    it('hasPlatformRole is >= on the ladder', () => {
        expect(hasPlatformRole(PlatformRole.ADMIN, PlatformRole.OPERATOR)).toBe(true);
        expect(hasPlatformRole(PlatformRole.OPERATOR, PlatformRole.OPERATOR)).toBe(true);
        expect(hasPlatformRole(PlatformRole.SUPPORT, PlatformRole.OPERATOR)).toBe(false);
        expect(hasPlatformRole(PlatformRole.NONE, PlatformRole.SUPPORT)).toBe(false);
        expect(hasPlatformRole(PlatformRole.SUPPORT, PlatformRole.SUPPORT)).toBe(true);
    });
});

describe('PlatformAdminGuard', () => {
    const makeCtx = (request: unknown): ExecutionContext =>
        ({
            switchToHttp: () => ({ getRequest: () => request }),
            getHandler: () => () => undefined,
            getClass: () => class {},
        }) as unknown as ExecutionContext;

    const makeGuard = (required: PlatformRole | undefined, dbUser: { platformRole: PlatformRole; email: string } | null) => {
        const reflector = { getAllAndOverride: jest.fn().mockReturnValue(required) } as unknown as Reflector;
        const findUnique = jest.fn().mockResolvedValue(dbUser);
        const prisma = { user: { findUnique } } as any;
        return { guard: new PlatformAdminGuard(reflector, prisma), findUnique };
    };

    it('allows when the live DB role meets the required minimum and publishes req.platformActor', async () => {
        const { guard, findUnique } = makeGuard(PlatformRole.OPERATOR, {
            platformRole: PlatformRole.ADMIN,
            email: 'admin@x.io',
        });
        const req: any = { user: { id: 'u1', email: 'stale@x.io' } };
        await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
        // Role is read LIVE from the DB, keyed by the authenticated user id.
        expect(findUnique).toHaveBeenCalledWith({ where: { id: 'u1' }, select: { platformRole: true, email: true } });
        expect(req.platformActor).toEqual({ id: 'u1', email: 'admin@x.io', platformRole: PlatformRole.ADMIN });
    });

    it('denies (403) when the live role is below the required minimum', async () => {
        const { guard } = makeGuard(PlatformRole.OPERATOR, { platformRole: PlatformRole.SUPPORT, email: 's@x.io' });
        await expect(guard.canActivate(makeCtx({ user: { id: 'u1' } }))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('denies (403) an ordinary NONE user', async () => {
        const { guard } = makeGuard(PlatformRole.SUPPORT, { platformRole: PlatformRole.NONE, email: 'n@x.io' });
        await expect(guard.canActivate(makeCtx({ user: { id: 'u1' } }))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('denies (403) when the account vanished mid-session (dbUser null -> NONE)', async () => {
        const { guard } = makeGuard(PlatformRole.SUPPORT, null);
        await expect(guard.canActivate(makeCtx({ user: { id: 'gone' } }))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('fails closed at ADMIN when no @PlatformRoles metadata is present', async () => {
        // reflector returns undefined -> guard requires ADMIN
        const support = makeGuard(undefined, { platformRole: PlatformRole.OPERATOR, email: 'o@x.io' });
        await expect(support.guard.canActivate(makeCtx({ user: { id: 'u1' } }))).rejects.toBeInstanceOf(ForbiddenException);

        const admin = makeGuard(undefined, { platformRole: PlatformRole.ADMIN, email: 'a@x.io' });
        await expect(admin.guard.canActivate(makeCtx({ user: { id: 'u1' } }))).resolves.toBe(true);
    });

    it('denies (403) when unauthenticated (no req.user) — defense in depth', async () => {
        const { guard, findUnique } = makeGuard(PlatformRole.SUPPORT, null);
        await expect(guard.canActivate(makeCtx({}))).rejects.toBeInstanceOf(ForbiddenException);
        expect(findUnique).not.toHaveBeenCalled();
    });
});
