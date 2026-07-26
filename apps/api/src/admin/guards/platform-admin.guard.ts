/**
 * PlatformAdminGuard — gates every /admin/* route.
 *
 * Stacked AFTER JwtAuthGuard (@UseGuards(JwtAuthGuard, PlatformAdminGuard)), so req.user is already
 * the authenticated identity. This guard then reads the user's platformRole LIVE FROM THE DB on every
 * request — NOT from a JWT claim — so a demotion (or a lock) takes effect on the very next request
 * instead of lingering until the access token expires. It is orthogonal to the tenant OrgRole: a
 * platform admin is cross-tenant and does NOT go through OrgsService.checkMembership.
 *
 * The required minimum role comes from @PlatformRoles(min) (method overrides class); with none present
 * it fails closed at ADMIN. On success it publishes the resolved actor at req.platformActor for audit.
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlatformRole } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PLATFORM_ROLE_KEY } from '../decorators/platform-roles.decorator';
import { hasPlatformRole } from '../platform-role.util';

@Injectable()
export class PlatformAdminGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly prisma: PrismaService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const userId: string | undefined = request.user?.id;
        // JwtAuthGuard runs first and would have 401'd an unauthenticated request; this is defense in depth.
        if (!userId) {
            throw new ForbiddenException('Platform admin access required');
        }

        const required =
            this.reflector.getAllAndOverride<PlatformRole>(PLATFORM_ROLE_KEY, [
                context.getHandler(),
                context.getClass(),
            ]) ?? PlatformRole.ADMIN;

        const dbUser = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { platformRole: true, email: true },
        });
        const role = dbUser?.platformRole ?? PlatformRole.NONE;

        if (!hasPlatformRole(role, required)) {
            // Uniform 403 (never 404/401) — don't leak whether the resource exists or hint at the ladder.
            throw new ForbiddenException('Platform admin access required');
        }

        request.platformActor = {
            id: userId,
            email: dbUser?.email ?? request.user?.email,
            platformRole: role,
        };
        return true;
    }
}
