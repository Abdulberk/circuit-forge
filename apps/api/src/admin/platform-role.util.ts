/**
 * Platform-role ranking. The graduated least-privilege ladder is a total order:
 *   NONE (0) < SUPPORT (1) < OPERATOR (2) < ADMIN (3)
 * A route declares its MINIMUM required role via @PlatformRoles(min); a user satisfies it when their
 * rank is >= the required rank. This keeps route guards to a single comparison instead of role sets.
 */
import { PlatformRole } from '@prisma/client';

export const PLATFORM_ROLE_RANK: Record<PlatformRole, number> = {
    [PlatformRole.NONE]: 0,
    [PlatformRole.SUPPORT]: 1,
    [PlatformRole.OPERATOR]: 2,
    [PlatformRole.ADMIN]: 3,
};

/** True when `actual` meets or exceeds the `required` minimum role. */
export function hasPlatformRole(actual: PlatformRole, required: PlatformRole): boolean {
    return PLATFORM_ROLE_RANK[actual] >= PLATFORM_ROLE_RANK[required];
}
