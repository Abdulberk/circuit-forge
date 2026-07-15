/**
 * Organizations Service
 */
import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginated, type Paginated } from '../common/dto/pagination.dto';

/** The audit-row shape a TENANT may see. Deliberately omits operator PII (adminActorEmail), the internal
 *  correlation id (requestId), and the raw platform-admin user id — those stay admin-only. */
export interface TenantAuditRow {
    id: string;
    orgId: string | null;
    userId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    createdAt: Date;
    byPlatformAdmin: boolean; // was this row written by a platform operator (vs the org's own members)?
    reason: string | null; // actor note — shown for the org's OWN actions + suspension (the one tenant-facing operator reason); other operators' internal notes are withheld
    before: unknown; // the tenant's own prior state, sensitive keys stripped (null when absent)
    after: unknown; // the tenant's own new state, sensitive keys stripped (null when absent)
}

// Identifiers/correlation that must NEVER reach a tenant, stripped from before/after at ANY depth (fail-closed:
// a snapshot that looks org-domain-only can still embed one, e.g. the quota-override view carries updatedByAdminId).
const SENSITIVE_META_KEYS = new Set(['updatedByAdminId', 'adminActorId', 'adminActorEmail', 'requestId']);

@Injectable()
export class OrgsService {
    constructor(private readonly prisma: PrismaService) { }

    async findAllForUser(userId: string) {
        const memberships = await this.prisma.orgMembership.findMany({
            where: { userId },
            include: {
                org: true,
            },
            // Stable order: callers treat [0] as the user's primary org (e.g. quick-sim quota
            // attribution), so the result must not depend on the query plan.
            orderBy: { createdAt: 'asc' },
        });
        return memberships.map((m) => ({
            ...m.org,
            role: m.role,
        }));
    }

    async findOne(id: string, userId: string) {
        const membership = await this.prisma.orgMembership.findUnique({
            where: {
                orgId_userId: { orgId: id, userId },
            },
            include: {
                org: true,
            },
        });

        if (!membership) {
            throw new NotFoundException('Organization not found or access denied');
        }

        return {
            ...membership.org,
            role: membership.role,
        };
    }

    async create(name: string, userId: string) {
        return this.prisma.organization.create({
            data: {
                name,
                memberships: {
                    create: {
                        userId,
                        role: 'OWNER',
                    },
                },
            },
        });
    }

    async checkMembership(orgId: string, userId: string, requiredRoles?: string[]) {
        const membership = await this.prisma.orgMembership.findUnique({
            where: {
                orgId_userId: { orgId, userId },
            },
        });

        if (!membership) {
            throw new ForbiddenException('Not a member of this organization');
        }

        if (requiredRoles && !requiredRoles.includes(membership.role)) {
            throw new ForbiddenException('Insufficient permissions');
        }

        return membership;
    }

    /**
     * Alias for checkMembership - used by templates and assets services
     */
    async requireMembership(orgId: string, userId: string, requiredRoles?: string[]) {
        return this.checkMembership(orgId, userId, requiredRoles);
    }

    /**
     * Org-scoped audit trail for the tenant's OWN org (access transparency). `orgId` is always pinned to the
     * path org — never taken from the query — so one org can never read another's trail. Rows are projected
     * through a redaction whitelist: a tenant sees WHAT happened + reason/before/after, but never the operator's
     * email, the internal requestId, or the raw platform-admin user id. Authz (OWNER/ADMIN) is the caller's job.
     */
    async listAuditLogs(
        orgId: string,
        page: { limit: number; offset: number },
        filters: { action?: string; entityType?: string; userId?: string } = {},
    ): Promise<Paginated<TenantAuditRow>> {
        const where: Prisma.AuditLogWhereInput = {
            orgId, // ALWAYS the path org — the query cannot widen this
            ...(filters.action ? { action: filters.action } : {}),
            ...(filters.entityType ? { entityType: filters.entityType } : {}),
            ...(filters.userId ? { userId: filters.userId } : {}),
        };
        const [rows, total] = await Promise.all([
            this.prisma.auditLog.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // id tiebreak → deterministic paging
                // Explicit select: NEVER return the raw row — `meta` carries operator PII we must not leak.
                select: {
                    id: true, orgId: true, userId: true, adminActorId: true,
                    action: true, entityType: true, entityId: true, meta: true, createdAt: true,
                },
                skip: page.offset,
                take: page.limit,
            }),
            this.prisma.auditLog.count({ where }),
        ]);
        return paginated(rows.map((r) => this.redactAuditRowForTenant(r)), total, page.limit, page.offset);
    }

    /** Project a raw AuditLog row down to the tenant-safe shape by WHITELIST (never spread `meta`, or a future
     *  meta.* key would silently leak). Exposes the operator's presence as a boolean, not their identity. */
    private redactAuditRowForTenant(row: {
        id: string; orgId: string | null; userId: string | null; adminActorId: string | null;
        action: string; entityType: string; entityId: string; meta: Prisma.JsonValue | null; createdAt: Date;
    }): TenantAuditRow {
        const meta = (row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta))
            ? (row.meta as Record<string, unknown>)
            : {};
        const byPlatformAdmin = row.adminActorId != null;
        // `reason` is free text. Show it for the org's OWN actions (their note), and for the ONE operator action
        // whose reason is a designed tenant-facing field (suspension → also shown in the ORG_SUSPENDED banner).
        // Withhold other operators' internal justifications (member removals, quota changes, sensitive reads).
        const reasonAllowed = !byPlatformAdmin || row.action === 'admin.org.suspend';
        return {
            id: row.id,
            orgId: row.orgId,
            userId: row.userId,
            action: row.action,
            entityType: row.entityType,
            entityId: row.entityId,
            createdAt: row.createdAt,
            byPlatformAdmin,
            reason: reasonAllowed && typeof meta.reason === 'string' ? meta.reason : null,
            before: meta.before == null ? null : stripSensitiveDeep(meta.before),
            after: meta.after == null ? null : stripSensitiveDeep(meta.after),
        };
    }
}

/** Recursively drop any SENSITIVE_META_KEYS key from a before/after snapshot, at any depth. Fail-closed: even
 *  if a future writer inlines an operator/correlation id inside a nested object, it can't surface to a tenant. */
function stripSensitiveDeep(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripSensitiveDeep);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (SENSITIVE_META_KEYS.has(k)) continue;
            out[k] = stripSensitiveDeep(v);
        }
        return out;
    }
    return value;
}