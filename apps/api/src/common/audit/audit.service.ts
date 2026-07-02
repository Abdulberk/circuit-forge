/**
 * AuditService — the single, centralized writer for the AuditLog table.
 *
 * Every platform-admin mutation MUST be audited (the admin surface is the highest-trust one), and
 * sensitive cross-tenant READS are audited too (access transparency). This service builds the row's
 * `meta` with the correlation `requestId`, the acting admin's email, an optional reason, and a
 * before/after snapshot — so "who did what to whom, and from which request" is answerable later.
 *
 * Two write modes:
 *  - `record()`  — awaited; throws on failure. Use for admin MUTATIONS so a lost audit row surfaces as
 *                  an error rather than a silent gap (the caller can wrap it in a $transaction).
 *  - `recordSafe()` — fire-and-forget; never throws. Use for sensitive READs, where failing the read
 *                  because the audit write hiccuped would be worse than the (logged) gap.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { getRequestId } from '../context/request-context';

export interface AuditEntry {
    /** Dotted verb, e.g. 'admin.org.suspend', 'admin.user.role_change', 'admin.sim.read'. */
    action: string;
    entityType: string;
    entityId: string;
    /** Org the event pertains to (null for user-scoped events with no org context). */
    orgId?: string | null;
    /** Subject of the event (the user acted UPON, or the actor for their own action). */
    userId?: string | null;
    /** The platform admin who initiated this (null = the subject's own, non-admin action). */
    adminActorId?: string | null;
    adminActorEmail?: string | null;
    /** State before/after the change; shallow snapshots (large blobs referenced by id, not inlined). */
    before?: unknown;
    after?: unknown;
    reason?: string | null;
    /** Any extra structured context to merge into meta. */
    extra?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
    private readonly logger = new Logger(AuditService.name);

    constructor(private readonly prisma: PrismaService) {}

    /** Build the Prisma create input (exposed so callers can compose it into a $transaction). */
    buildData(entry: AuditEntry): Prisma.AuditLogUncheckedCreateInput {
        const meta: Record<string, unknown> = { ...(entry.extra ?? {}) };
        const requestId = getRequestId();
        if (requestId) meta.requestId = requestId;
        if (entry.adminActorEmail) meta.adminActorEmail = entry.adminActorEmail;
        if (entry.reason != null) meta.reason = entry.reason;
        if (entry.before !== undefined) meta.before = entry.before;
        if (entry.after !== undefined) meta.after = entry.after;

        return {
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId,
            orgId: entry.orgId ?? null,
            userId: entry.userId ?? null,
            adminActorId: entry.adminActorId ?? null,
            // JSON round-trip: normalizes Date -> ISO, strips undefined, and guarantees a valid Json value.
            meta: toJson(meta),
        };
    }

    /** Awaited write; throws on failure. For admin mutations (the audit row is a compliance artifact). */
    async record(entry: AuditEntry): Promise<void> {
        await this.prisma.auditLog.create({ data: this.buildData(entry) });
    }

    /** Fire-and-forget write; never throws (logs on failure). For sensitive reads / non-critical events. */
    recordSafe(entry: AuditEntry): void {
        void this.prisma.auditLog
            .create({ data: this.buildData(entry) })
            .catch((e) =>
                this.logger.error(
                    `audit write failed for ${entry.action}: ${e instanceof Error ? e.message : String(e)}`,
                ),
            );
    }
}

/** Serialize to a Prisma-safe Json value (Dates -> ISO strings, undefined dropped). */
function toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}
