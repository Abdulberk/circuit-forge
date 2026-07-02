/**
 * The platform admin resolved by PlatformAdminGuard (id + email + live role), attached to the request
 * as `req.platformActor`. Controllers use @CurrentPlatformActor() to stamp the acting admin onto audit
 * rows. Distinct from @CurrentUser() (raw JWT identity): this only exists AFTER the guard has verified
 * the caller is a platform admin and read their current role from the DB.
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { PlatformRole } from '@prisma/client';

export interface PlatformActor {
    id: string;
    email: string;
    platformRole: PlatformRole;
}

export const CurrentPlatformActor = createParamDecorator(
    (_data: unknown, ctx: ExecutionContext): PlatformActor => {
        return ctx.switchToHttp().getRequest().platformActor;
    },
);
