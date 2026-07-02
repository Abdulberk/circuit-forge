/**
 * @PlatformRoles(min) — declares the MINIMUM platform role required for a route (or a whole
 * controller). PlatformAdminGuard reads it via the Reflector (method overrides class). When absent,
 * the guard defaults to the strictest role (ADMIN) so a forgotten decorator fails closed, not open.
 */
import { SetMetadata } from '@nestjs/common';
import { PlatformRole } from '@prisma/client';

export const PLATFORM_ROLE_KEY = 'platformRoleMin';

export const PlatformRoles = (min: PlatformRole) => SetMetadata(PLATFORM_ROLE_KEY, min);
