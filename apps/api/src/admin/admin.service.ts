/**
 * AdminService — the platform-operator backend. Cross-tenant by design: unlike the tenant services it
 * does NOT call OrgsService.checkMembership; access is gated entirely by PlatformAdminGuard on the
 * controller. Sensitive cross-tenant DETAIL reads (a user's profile, another tenant's job netlist /
 * result / design prompt) are audited (access transparency); routine LIST reads are not (too noisy).
 *
 * Phase 1 = read-only observability. Phase 2 adds mutations (still routed through AuditService).
 */
import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, SimJobStatus, DesignJobStatus } from '@prisma/client';

import { AuditService } from '../common/audit/audit.service';
import { paginated, type Paginated } from '../common/dto/pagination.dto';
import { ReadinessService } from '../health/readiness.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService, toQuotaOverrideView } from '../usage/usage.service';

import { AdminQueueService } from './admin-queue.service';
import { AdminStorageService } from './admin-storage.service';
import { PlatformActor } from './decorators/platform-actor.decorator';
import {
    LockUserDto,
    SetPlatformRoleDto,
    SetEmailVerifiedDto,
    RenameOrgDto,
    SuspendOrgDto,
    AddMemberDto,
    UpdateMemberRoleDto,
    SetQuotaOverrideDto,
    ActionReasonDto,
    PurgeQueueDto,
    SweepOrphanModelsDto,
} from './dto';
import { PLATFORM_ROLE_RANK } from './platform-role.util';

/** Far-future timestamp used for an "indefinite" account lock (no natural expiry). */
const INDEFINITE_LOCK = new Date('9999-12-31T23:59:59.000Z');

interface Page {
    limit: number;
    offset: number;
}
export interface DepCheck {
    status: 'ok' | 'error';
    latencyMs: number;
    error?: string;
}

@Injectable()
export class AdminService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly audit: AuditService,
        private readonly usage: UsageService,
        private readonly queues: AdminQueueService,
        private readonly storage: AdminStorageService,
        private readonly readiness: ReadinessService,
    ) {}

    // ---------------------------------------------------------------- users

    async listUsers(page: Page, search?: string): Promise<Paginated<unknown>> {
        const where: Prisma.UserWhereInput = search
            ? {
                  OR: [
                      { email: { contains: search, mode: 'insensitive' } },
                      { name: { contains: search, mode: 'insensitive' } },
                  ],
              }
            : {};
        const [items, total] = await Promise.all([
            this.prisma.user.findMany({
                where,
                select: {
                    id: true,
                    email: true,
                    name: true,
                    platformRole: true,
                    emailVerified: true,
                    lockedUntil: true,
                    createdAt: true,
                    _count: { select: { memberships: true } },
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: page.offset,
                take: page.limit,
            }),
            this.prisma.user.count({ where }),
        ]);
        return paginated(items, total, page.limit, page.offset);
    }

    async getUser(id: string, actor: PlatformActor) {
        const user = await this.prisma.user.findUnique({
            where: { id },
            select: {
                id: true,
                email: true,
                name: true,
                platformRole: true,
                emailVerified: true,
                lockedUntil: true,
                failedLoginCount: true,
                lastFailedLoginAt: true,
                createdAt: true,
                updatedAt: true,
                memberships: {
                    select: {
                        role: true,
                        createdAt: true,
                        org: { select: { id: true, name: true, suspendedAt: true } },
                    },
                },
            },
        });
        if (!user) throw new NotFoundException('User not found');
        // Live session count: refresh-token families neither revoked nor expired.
        const activeSessions = await this.prisma.refreshToken.count({
            where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
        });
        this.audit.recordSafe({
            action: 'admin.user.read',
            entityType: 'User',
            entityId: id,
            userId: id,
            adminActorId: actor.id,
            adminActorEmail: actor.email,
        });
        return { ...user, activeSessions };
    }

    // ---------------------------------------------------------------- orgs

    async listOrgs(page: Page, search?: string): Promise<Paginated<unknown>> {
        const where: Prisma.OrganizationWhereInput = search ? { name: { contains: search, mode: 'insensitive' } } : {};
        const [items, total] = await Promise.all([
            this.prisma.organization.findMany({
                where,
                select: {
                    id: true,
                    name: true,
                    createdAt: true,
                    suspendedAt: true,
                    suspendReason: true,
                    _count: { select: { memberships: true, simulationJobs: true, designJobs: true } },
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: page.offset,
                take: page.limit,
            }),
            this.prisma.organization.count({ where }),
        ]);
        return paginated(items, total, page.limit, page.offset);
    }

    async getOrg(id: string, actor: PlatformActor) {
        const org = await this.prisma.organization.findUnique({
            where: { id },
            select: {
                id: true,
                name: true,
                createdAt: true,
                updatedAt: true,
                suspendedAt: true,
                suspendReason: true,
                memberships: {
                    select: {
                        role: true,
                        createdAt: true,
                        user: { select: { id: true, email: true, name: true, platformRole: true } },
                    },
                },
            },
        });
        if (!org) throw new NotFoundException('Organization not found');
        const usage = await this.usage.getOrgUsageForAdmin(id);
        this.audit.recordSafe({
            action: 'admin.org.read',
            entityType: 'Organization',
            entityId: id,
            orgId: id,
            adminActorId: actor.id,
            adminActorEmail: actor.email,
        });
        return { ...org, usage };
    }

    /**
     * Usage across a PAGE of orgs (top-consumers view). NOTE: aggregates on-demand per org (~6 queries
     * each), so cost is O(page size); bounded by the page limit. Pre-aggregate/cache if org count grows.
     */
    async allOrgsUsage(page: Page): Promise<Paginated<unknown>> {
        const [orgs, total] = await Promise.all([
            this.prisma.organization.findMany({
                select: { id: true, name: true, suspendedAt: true },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: page.offset,
                take: page.limit,
            }),
            this.prisma.organization.count(),
        ]);
        const items = await Promise.all(
            orgs.map(async (o) => ({
                id: o.id,
                name: o.name,
                suspendedAt: o.suspendedAt,
                usage: await this.usage.getOrgUsageForAdmin(o.id),
            })),
        );
        return paginated(items, total, page.limit, page.offset);
    }

    // ---------------------------------------------------------------- jobs (cross-tenant)

    async listSimJobs(page: Page, orgId?: string, status?: SimJobStatus): Promise<Paginated<unknown>> {
        const where: Prisma.SimulationJobWhereInput = { ...(orgId ? { orgId } : {}), ...(status ? { status } : {}) };
        const [items, total] = await Promise.all([
            this.prisma.simulationJob.findMany({
                where,
                // Light list projection — no netlist/result blobs (those are in the detail view).
                select: {
                    id: true,
                    orgId: true,
                    status: true,
                    engine: true,
                    createdAt: true,
                    startedAt: true,
                    finishedAt: true,
                    metrics: true,
                    errorMessage: true,
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: page.offset,
                take: page.limit,
            }),
            this.prisma.simulationJob.count({ where }),
        ]);
        return paginated(items, total, page.limit, page.offset);
    }

    async getSimJob(id: string, actor: PlatformActor) {
        const job = await this.prisma.simulationJob.findUnique({ where: { id } });
        if (!job) throw new NotFoundException('Simulation job not found');
        // Cross-tenant sensitive read (netlist + result belong to another tenant) — audit it.
        this.audit.recordSafe({
            action: 'admin.sim.read',
            entityType: 'SimulationJob',
            entityId: id,
            orgId: job.orgId,
            adminActorId: actor.id,
            adminActorEmail: actor.email,
            extra: { readSensitive: ['netlist', 'resultJson'] },
        });
        return job;
    }

    async listDesignJobs(page: Page, orgId?: string, status?: DesignJobStatus): Promise<Paginated<unknown>> {
        const where: Prisma.DesignJobWhereInput = { ...(orgId ? { orgId } : {}), ...(status ? { status } : {}) };
        const [items, total] = await Promise.all([
            this.prisma.designJob.findMany({
                where,
                select: {
                    id: true,
                    orgId: true,
                    userId: true,
                    status: true,
                    maxRounds: true,
                    createdAt: true,
                    startedAt: true,
                    finishedAt: true,
                    abortRequested: true,
                    errorMessage: true,
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: page.offset,
                take: page.limit,
            }),
            this.prisma.designJob.count({ where }),
        ]);
        return paginated(items, total, page.limit, page.offset);
    }

    async getDesignJob(id: string, actor: PlatformActor) {
        const job = await this.prisma.designJob.findUnique({ where: { id } });
        if (!job) throw new NotFoundException('Design job not found');
        this.audit.recordSafe({
            action: 'admin.design.read',
            entityType: 'DesignJob',
            entityId: id,
            orgId: job.orgId,
            adminActorId: actor.id,
            adminActorEmail: actor.email,
            extra: { readSensitive: ['prompt', 'result'] },
        });
        return job;
    }

    // ---------------------------------------------------------------- audit log (platform-wide)

    async listAuditLogs(
        page: Page,
        filters: { orgId?: string; userId?: string; adminActorId?: string; action?: string; entityType?: string },
    ): Promise<Paginated<unknown>> {
        const where: Prisma.AuditLogWhereInput = {
            ...(filters.orgId ? { orgId: filters.orgId } : {}),
            ...(filters.userId ? { userId: filters.userId } : {}),
            ...(filters.adminActorId ? { adminActorId: filters.adminActorId } : {}),
            ...(filters.action ? { action: filters.action } : {}),
            ...(filters.entityType ? { entityType: filters.entityType } : {}),
        };
        const [items, total] = await Promise.all([
            this.prisma.auditLog.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: page.offset,
                take: page.limit,
            }),
            this.prisma.auditLog.count({ where }),
        ]);
        return paginated(items, total, page.limit, page.offset);
    }

    // ---------------------------------------------------------------- queues + health dashboard

    async queueHealth() {
        return this.queues.health();
    }

    // -------- queue kill-switch + maintenance (ADMIN — platform-wide blast radius)

    async pauseQueue(name: string, dto: ActionReasonDto, actor: PlatformActor) {
        const result = await this.queues.pause(name); // validates the name (400 on unknown)
        await this.audit.record({
            action: 'admin.queue.pause',
            entityType: 'Queue',
            entityId: name,
            adminActorId: actor.id,
            adminActorEmail: actor.email,
            reason: dto.reason,
            after: { paused: true },
        });
        return result;
    }

    async resumeQueue(name: string, dto: ActionReasonDto, actor: PlatformActor) {
        const result = await this.queues.resume(name);
        await this.audit.record({
            action: 'admin.queue.resume',
            entityType: 'Queue',
            entityId: name,
            adminActorId: actor.id,
            adminActorEmail: actor.email,
            reason: dto.reason,
            after: { paused: false },
        });
        return result;
    }

    async purgeQueue(name: string, dto: PurgeQueueDto, actor: PlatformActor) {
        const result = await this.queues.purge(name, dto.status);
        await this.audit.record({
            action: 'admin.queue.purge',
            entityType: 'Queue',
            entityId: name,
            adminActorId: actor.id,
            adminActorEmail: actor.email,
            reason: dto.reason,
            after: { status: dto.status, removed: result.removed },
        });
        return result;
    }

    /** S3 orphan-model sweep (ops lever, like purge): delete never-committed / historically-leaked model
     *  objects that no Asset row references and that are past the grace window. Audited with the tally. */
    async sweepOrphanModels(dto: SweepOrphanModelsDto, actor: PlatformActor) {
        const result = await this.storage.sweepOrphanModelAssets({
            olderThanDays: dto.olderThanDays ?? 7,
            dryRun: dto.dryRun ?? false,
        });
        await this.audit.record({
            action: 'admin.storage.sweep_orphan_models',
            entityType: 'Storage',
            entityId: 'orphan-model-sweep',
            adminActorId: actor.id,
            adminActorEmail: actor.email,
            reason: dto.reason,
            after: result as unknown as Record<string, unknown>,
        });
        return result;
    }

    /** System-wide dependency + queue health for the operator dashboard. */
    async healthDashboard() {
        const [database, redis, s3, queues] = await Promise.all([
            this.check(() => this.prisma.$queryRaw`SELECT 1`),
            this.check(() => this.readiness.pingRedis()),
            this.check(() => this.readiness.pingS3()),
            this.queues.health().catch((e) => ({ error: e instanceof Error ? e.message : String(e) })),
        ]);
        const dependencies = { database, redis, s3 };
        const allOk = [database, redis, s3].every((c) => c.status === 'ok');
        return {
            status: allOk ? 'ok' : 'degraded',
            timestamp: new Date().toISOString(),
            dependencies,
            queues,
        };
    }

    private async check(fn: () => Promise<unknown>): Promise<DepCheck> {
        const start = Date.now();
        try {
            await fn();
            return { status: 'ok', latencyMs: Date.now() - start };
        } catch (error) {
            return {
                status: 'error',
                latencyMs: Date.now() - start,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    // ================================================================ Phase 2: mutations
    // Every mutation is audited. Single-entity writes commit the mutation + its audit row in ONE
    // $transaction so the trail can never be lost mid-write; queue-touching actions audit right after.

    // -------- user lifecycle

    async lockUser(id: string, dto: LockUserDto, actor: PlatformActor) {
        if (id === actor.id) throw new BadRequestException('You cannot lock your own account.');
        const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true, lockedUntil: true } });
        if (!user) throw new NotFoundException('User not found');
        const until = dto.locked ? (dto.until ? new Date(dto.until) : INDEFINITE_LOCK) : null;

        const sessionsRevoked = await this.prisma.$transaction(async (tx) => {
            await tx.user.update({ where: { id }, data: { lockedUntil: until } });
            // Locking also kills live sessions — otherwise a locked user keeps acting via an existing
            // refresh token (login gates on lockedUntil, but refresh/access don't).
            const revoked = dto.locked
                ? await tx.refreshToken.updateMany({
                      where: { userId: id, revokedAt: null },
                      data: { revokedAt: new Date() },
                  })
                : { count: 0 };
            await tx.auditLog.create({
                data: this.audit.buildData({
                    action: dto.locked ? 'admin.user.lock' : 'admin.user.unlock',
                    entityType: 'User',
                    entityId: id,
                    userId: id,
                    adminActorId: actor.id,
                    adminActorEmail: actor.email,
                    reason: dto.reason,
                    before: { lockedUntil: user.lockedUntil },
                    after: { lockedUntil: until, sessionsRevoked: revoked.count },
                }),
            });
            return revoked.count;
        });
        return { id, locked: dto.locked, lockedUntil: until, sessionsRevoked };
    }

    async logoutAll(id: string, dto: ActionReasonDto, actor: PlatformActor) {
        const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
        if (!user) throw new NotFoundException('User not found');
        // Single-entity mutation → revoke + audit in ONE transaction so the trail can't be lost mid-write
        // (matches lockUser/setPlatformRole; this touches no queue).
        const sessionsRevoked = await this.prisma.$transaction(async (tx) => {
            const revoked = await tx.refreshToken.updateMany({
                where: { userId: id, revokedAt: null },
                data: { revokedAt: new Date() },
            });
            await tx.auditLog.create({
                data: this.audit.buildData({
                    action: 'admin.user.logout_all',
                    entityType: 'User',
                    entityId: id,
                    userId: id,
                    adminActorId: actor.id,
                    adminActorEmail: actor.email,
                    reason: dto.reason,
                    after: { sessionsRevoked: revoked.count },
                }),
            });
            return revoked.count;
        });
        return { id, sessionsRevoked };
    }

    /** ADMIN-only. Demotion revokes sessions too (defense in depth; the guard already reads role live). */
    async setPlatformRole(id: string, dto: SetPlatformRoleDto, actor: PlatformActor) {
        if (id === actor.id) throw new BadRequestException('You cannot change your own platform role.');
        const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true, platformRole: true } });
        if (!user) throw new NotFoundException('User not found');
        const demoting = PLATFORM_ROLE_RANK[dto.platformRole] < PLATFORM_ROLE_RANK[user.platformRole];

        const sessionsRevoked = await this.prisma.$transaction(async (tx) => {
            await tx.user.update({ where: { id }, data: { platformRole: dto.platformRole } });
            const revoked = demoting
                ? await tx.refreshToken.updateMany({
                      where: { userId: id, revokedAt: null },
                      data: { revokedAt: new Date() },
                  })
                : { count: 0 };
            await tx.auditLog.create({
                data: this.audit.buildData({
                    action: 'admin.user.role_change',
                    entityType: 'User',
                    entityId: id,
                    userId: id,
                    adminActorId: actor.id,
                    adminActorEmail: actor.email,
                    reason: dto.reason,
                    before: { platformRole: user.platformRole },
                    after: { platformRole: dto.platformRole, sessionsRevoked: revoked.count },
                }),
            });
            return revoked.count;
        });
        return { id, platformRole: dto.platformRole, sessionsRevoked };
    }

    async setEmailVerified(id: string, dto: SetEmailVerifiedDto, actor: PlatformActor) {
        const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true, emailVerified: true } });
        if (!user) throw new NotFoundException('User not found');
        await this.prisma.$transaction(async (tx) => {
            await tx.user.update({ where: { id }, data: { emailVerified: dto.verified } });
            await tx.auditLog.create({
                data: this.audit.buildData({
                    action: 'admin.user.email_verified',
                    entityType: 'User',
                    entityId: id,
                    userId: id,
                    adminActorId: actor.id,
                    adminActorEmail: actor.email,
                    reason: dto.reason,
                    before: { emailVerified: user.emailVerified },
                    after: { emailVerified: dto.verified },
                }),
            });
        });
        return { id, emailVerified: dto.verified };
    }

    // -------- org lifecycle

    async renameOrg(id: string, dto: RenameOrgDto, actor: PlatformActor) {
        const org = await this.prisma.organization.findUnique({ where: { id }, select: { id: true, name: true } });
        if (!org) throw new NotFoundException('Organization not found');
        await this.prisma.$transaction(async (tx) => {
            await tx.organization.update({ where: { id }, data: { name: dto.name } });
            await tx.auditLog.create({
                data: this.audit.buildData({
                    action: 'admin.org.rename',
                    entityType: 'Organization',
                    entityId: id,
                    orgId: id,
                    adminActorId: actor.id,
                    adminActorEmail: actor.email,
                    reason: dto.reason,
                    before: { name: org.name },
                    after: { name: dto.name },
                }),
            });
        });
        return { id, name: dto.name };
    }

    async suspendOrg(id: string, dto: SuspendOrgDto, actor: PlatformActor) {
        const org = await this.prisma.organization.findUnique({
            where: { id },
            select: { id: true, suspendedAt: true, suspendReason: true },
        });
        if (!org) throw new NotFoundException('Organization not found');
        const suspendedAt = dto.suspended ? new Date() : null;
        const suspendReason = dto.suspended ? (dto.reason ?? null) : null;
        await this.prisma.$transaction(async (tx) => {
            await tx.organization.update({ where: { id }, data: { suspendedAt, suspendReason } });
            await tx.auditLog.create({
                data: this.audit.buildData({
                    action: dto.suspended ? 'admin.org.suspend' : 'admin.org.reinstate',
                    entityType: 'Organization',
                    entityId: id,
                    orgId: id,
                    adminActorId: actor.id,
                    adminActorEmail: actor.email,
                    reason: dto.reason,
                    before: { suspendedAt: org.suspendedAt, suspendReason: org.suspendReason },
                    after: { suspendedAt, suspendReason },
                }),
            });
        });
        return { id, suspended: dto.suspended, suspendedAt, suspendReason };
    }

    // -------- membership (cross-tenant)

    async addMember(orgId: string, dto: AddMemberDto, actor: PlatformActor) {
        const [org, user] = await Promise.all([
            this.prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } }),
            this.prisma.user.findUnique({ where: { id: dto.userId }, select: { id: true } }),
        ]);
        if (!org) throw new NotFoundException('Organization not found');
        if (!user) throw new NotFoundException('User not found');
        return this.prisma.$transaction(async (tx) => {
            const existing = await tx.orgMembership.findUnique({
                where: { orgId_userId: { orgId, userId: dto.userId } },
                select: { role: true },
            });
            // The re-role (upsert UPDATE) path can demote an existing member — apply the SAME last-owner
            // protection as updateMemberRole so re-roling the sole OWNER down can't orphan the org.
            if (existing?.role === 'OWNER' && dto.role !== 'OWNER') {
                const owners = await tx.orgMembership.count({ where: { orgId, role: 'OWNER' } });
                if (owners <= 1) throw new BadRequestException('Cannot demote the last owner of an organization.');
            }
            const membership = await tx.orgMembership.upsert({
                where: { orgId_userId: { orgId, userId: dto.userId } },
                create: { orgId, userId: dto.userId, role: dto.role },
                update: { role: dto.role },
            });
            await tx.auditLog.create({
                data: this.audit.buildData({
                    action: existing ? 'admin.org.member_role_change' : 'admin.org.member_add',
                    entityType: 'OrgMembership',
                    entityId: membership.id,
                    orgId,
                    userId: dto.userId,
                    adminActorId: actor.id,
                    adminActorEmail: actor.email,
                    reason: dto.reason,
                    before: existing ? { role: existing.role } : null,
                    after: { role: dto.role },
                }),
            });
            return membership;
        });
    }

    async removeMember(orgId: string, userId: string, dto: ActionReasonDto, actor: PlatformActor) {
        const membership = await this.prisma.orgMembership.findUnique({
            where: { orgId_userId: { orgId, userId } },
            select: { id: true, role: true },
        });
        if (!membership) throw new NotFoundException('Membership not found');
        await this.assertNotLastOwner(orgId, membership.role, 'remove');
        await this.prisma.$transaction(async (tx) => {
            await tx.orgMembership.delete({ where: { orgId_userId: { orgId, userId } } });
            await tx.auditLog.create({
                data: this.audit.buildData({
                    action: 'admin.org.member_remove',
                    entityType: 'OrgMembership',
                    entityId: membership.id,
                    orgId,
                    userId,
                    adminActorId: actor.id,
                    adminActorEmail: actor.email,
                    reason: dto.reason,
                    before: { role: membership.role },
                    after: null,
                }),
            });
        });
        return { orgId, userId, removed: true };
    }

    async updateMemberRole(orgId: string, userId: string, dto: UpdateMemberRoleDto, actor: PlatformActor) {
        const membership = await this.prisma.orgMembership.findUnique({
            where: { orgId_userId: { orgId, userId } },
            select: { id: true, role: true },
        });
        if (!membership) throw new NotFoundException('Membership not found');
        if (membership.role === 'OWNER' && dto.role !== 'OWNER') {
            await this.assertNotLastOwner(orgId, membership.role, 'demote');
        }
        await this.prisma.$transaction(async (tx) => {
            await tx.orgMembership.update({ where: { orgId_userId: { orgId, userId } }, data: { role: dto.role } });
            await tx.auditLog.create({
                data: this.audit.buildData({
                    action: 'admin.org.member_role_change',
                    entityType: 'OrgMembership',
                    entityId: membership.id,
                    orgId,
                    userId,
                    adminActorId: actor.id,
                    adminActorEmail: actor.email,
                    reason: dto.reason,
                    before: { role: membership.role },
                    after: { role: dto.role },
                }),
            });
        });
        return { orgId, userId, role: dto.role };
    }

    /** An org must always retain at least one OWNER — block removing/demoting the last one. */
    private async assertNotLastOwner(orgId: string, role: string, action: string): Promise<void> {
        if (role !== 'OWNER') return;
        const owners = await this.prisma.orgMembership.count({ where: { orgId, role: 'OWNER' } });
        if (owners <= 1) {
            throw new BadRequestException(`Cannot ${action} the last owner of an organization.`);
        }
    }

    // -------- per-org quota overrides

    async setQuotaOverride(orgId: string, dto: SetQuotaOverrideDto, actor: PlatformActor) {
        const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
        if (!org) throw new NotFoundException('Organization not found');

        // undefined = leave unchanged; null = clear (inherit env); number = set. storageBytes -> BigInt.
        const fields = [
            'simConcurrent',
            'simJobsPerMonth',
            'simRuntimeMsPerMonth',
            'designConcurrent',
            'designJobsPerMonth',
            'storageBytes',
            'partsCallsPerMonth',
        ] as const;
        const data: Record<string, number | bigint | string | null> = { updatedByAdminId: actor.id };
        for (const f of fields) {
            const v = dto[f];
            if (v === undefined) continue;
            data[f] = f === 'storageBytes' && v !== null ? BigInt(v) : v;
        }

        const row = await this.prisma.$transaction(async (tx) => {
            // Read the prior state INSIDE the tx so the audit 'before' reflects the actual immediately-
            // preceding value even under concurrent admin edits (not a stale pre-tx snapshot).
            const existing = await tx.orgQuotaOverride.findUnique({ where: { orgId } });
            const upserted = await tx.orgQuotaOverride.upsert({
                where: { orgId },
                create: { orgId, ...data } as Prisma.OrgQuotaOverrideUncheckedCreateInput,
                update: data as Prisma.OrgQuotaOverrideUncheckedUpdateInput,
            });
            await tx.auditLog.create({
                data: this.audit.buildData({
                    action: 'admin.org.quota_override',
                    entityType: 'OrgQuotaOverride',
                    entityId: orgId,
                    orgId,
                    adminActorId: actor.id,
                    adminActorEmail: actor.email,
                    reason: dto.reason,
                    before: toQuotaOverrideView(existing),
                    after: toQuotaOverrideView(upserted),
                }),
            });
            return upserted;
        });
        return toQuotaOverrideView(row);
    }

    async clearQuotaOverride(orgId: string, dto: ActionReasonDto, actor: PlatformActor) {
        // Read + delete + audit in ONE tx so the recorded 'before' is the actual deleted value (accurate
        // even under a concurrent edit) and the delete/audit can't diverge.
        return this.prisma.$transaction(async (tx) => {
            const existing = await tx.orgQuotaOverride.findUnique({ where: { orgId } });
            if (!existing) return { orgId, cleared: false };
            await tx.orgQuotaOverride.delete({ where: { orgId } });
            await tx.auditLog.create({
                data: this.audit.buildData({
                    action: 'admin.org.quota_override_clear',
                    entityType: 'OrgQuotaOverride',
                    entityId: orgId,
                    orgId,
                    adminActorId: actor.id,
                    adminActorEmail: actor.email,
                    reason: dto.reason,
                    before: toQuotaOverrideView(existing),
                    after: null,
                }),
            });
            return { orgId, cleared: true };
        });
    }

    // -------- jobs (cancel / retry)

    async cancelSimJob(id: string, dto: ActionReasonDto, actor: PlatformActor) {
        const job = await this.prisma.simulationJob.findUnique({
            where: { id },
            select: { id: true, orgId: true, status: true },
        });
        if (!job) throw new NotFoundException('Simulation job not found');
        if (job.status === 'RUNNING') {
            throw new ConflictException('A running simulation is not interruptible; wait for it to finish.');
        }
        if (job.status !== SimJobStatus.QUEUED) {
            throw new ConflictException(`Job is ${job.status} and cannot be canceled.`);
        }
        // The sim worker's QUEUED->RUNNING claim is an UNCONDITIONAL update-by-id (not a compare-and-set on
        // status), so flipping the row to CANCELED alone can't stop it — the worker would overwrite it once
        // it has the job. The ONLY honest cancel is to REMOVE the still-waiting BullMQ job: remove() succeeds
        // iff the job hasn't been claimed (moved to 'active') yet, guaranteeing the worker will never run it.
        // If remove() fails (already claimed / gone), we refuse rather than write a CANCELED that would be
        // silently overwritten.
        const removedFromQueue = await this.queues.removeSimJob(id);
        if (!removedFromQueue) {
            throw new ConflictException('Simulation has already started or is no longer cancelable.');
        }
        const res = await this.prisma.simulationJob.updateMany({
            where: { id, status: 'QUEUED' },
            data: { status: 'CANCELED', finishedAt: new Date() },
        });
        if (res.count === 0) throw new ConflictException('Job started before it could be canceled.');
        await this.audit.record({
            action: 'admin.sim.cancel',
            entityType: 'SimulationJob',
            entityId: id,
            orgId: job.orgId,
            adminActorId: actor.id,
            adminActorEmail: actor.email,
            reason: dto.reason,
            before: { status: job.status },
            after: { status: 'CANCELED' },
            extra: { removedFromQueue },
        });
        return { id, status: 'CANCELED', removedFromQueue };
    }

    /**
     * Re-enqueue a terminated simulation with its stored netlist (probeNames derived from the netlist by
     * the worker). LIMITATION: uploaded model assets aren't persisted on the job row, so a retry of a
     * model-dependent sim won't reattach them — those should be re-run from the source version instead.
     */
    async retrySimJob(id: string, dto: ActionReasonDto, actor: PlatformActor) {
        const job = await this.prisma.simulationJob.findUnique({ where: { id } });
        if (!job) throw new NotFoundException('Simulation job not found');
        const retriable: SimJobStatus[] = [SimJobStatus.FAILED, SimJobStatus.TIMED_OUT, SimJobStatus.CANCELED];
        if (!retriable.includes(job.status)) {
            throw new ConflictException(`Only failed/timed-out/canceled jobs can be retried (status: ${job.status}).`);
        }
        const analysisType = (job.analysisConfig as { type?: string } | null)?.type ?? 'tran';
        await this.prisma.simulationJob.update({
            where: { id },
            data: {
                status: 'QUEUED',
                startedAt: null,
                finishedAt: null,
                errorMessage: null,
                resultJson: Prisma.DbNull,
                resultS3Key: null,
                metrics: Prisma.DbNull,
                stdout: null,
                stderr: null,
            },
        });
        await this.queues.removeSimJob(id); // clear any stale BullMQ record before re-adding with the same id
        try {
            await this.queues.enqueueSim({
                jobId: job.id,
                orgId: job.orgId,
                netlist: job.netlist,
                probeNames: [],
                analysisType,
                analysisConfig: job.analysisConfig,
            });
        } catch (e) {
            // The row is now QUEUED but the enqueue failed, and there is NO SimulationJob reaper — so revert
            // to a terminal state instead of orphaning a QUEUED row that nothing will ever pick up.
            await this.prisma.simulationJob.update({
                where: { id },
                data: {
                    status: 'FAILED',
                    errorMessage: `retry re-enqueue failed: ${e instanceof Error ? e.message : String(e)}`,
                    finishedAt: new Date(),
                },
            });
            throw new ServiceUnavailableException('Failed to re-enqueue the simulation; it was returned to FAILED.');
        }
        await this.audit.record({
            action: 'admin.sim.retry',
            entityType: 'SimulationJob',
            entityId: id,
            orgId: job.orgId,
            adminActorId: actor.id,
            adminActorEmail: actor.email,
            reason: dto.reason,
            before: { status: job.status },
            after: { status: 'QUEUED' },
        });
        return { id, status: 'QUEUED' };
    }

    /** Design cancel mirrors DesignJobService.requestCancel but bypasses the tenant membership check. */
    async cancelDesignJob(id: string, dto: ActionReasonDto, actor: PlatformActor) {
        const job = await this.prisma.designJob.findUnique({
            where: { id },
            select: { id: true, orgId: true, status: true },
        });
        if (!job) throw new NotFoundException('Design job not found');
        if (job.status === DesignJobStatus.QUEUED) {
            await this.prisma.designJob.update({
                where: { id },
                data: { status: 'CANCELED', abortRequested: true, finishedAt: new Date() },
            });
            await this.auditDesignCancel(id, job.orgId, actor, dto.reason, 'QUEUED', { status: 'CANCELED' });
            return { id, status: 'CANCELED' };
        }
        if (job.status === DesignJobStatus.RUNNING) {
            // The worker honors abortRequested mid-loop (round start + before each paid LLM call).
            await this.prisma.designJob.update({ where: { id }, data: { abortRequested: true } });
            await this.auditDesignCancel(id, job.orgId, actor, dto.reason, 'RUNNING', {
                status: 'RUNNING',
                abortRequested: true,
            });
            return { id, status: 'RUNNING', abortRequested: true };
        }
        throw new ConflictException(`Design job is ${job.status} and cannot be canceled.`);
    }

    private async auditDesignCancel(
        id: string,
        orgId: string,
        actor: PlatformActor,
        reason: string | undefined,
        beforeStatus: string,
        after: Record<string, unknown>,
    ): Promise<void> {
        await this.audit.record({
            action: 'admin.design.cancel',
            entityType: 'DesignJob',
            entityId: id,
            orgId,
            adminActorId: actor.id,
            adminActorEmail: actor.email,
            reason,
            before: { status: beforeStatus },
            after,
        });
    }
}
