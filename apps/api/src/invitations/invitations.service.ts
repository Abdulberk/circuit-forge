/**
 * Org invitations — the "add a teammate" half of self-serve team management. An OWNER/ADMIN invites by
 * email; the invitee (whether or not they already have an account) clicks the emailed link and accepts as
 * themselves. The raw token lives only in the email; we store its sha256 hash. Mirrors the auth token
 * recipe. Membership creation on accept is audited under the invitee (adminActorId null — not a platform
 * action), recording the inviter in meta.
 */
import {
    Injectable,
    NotFoundException,
    ForbiddenException,
    BadRequestException,
    ConflictException,
} from '@nestjs/common';
import { OrgRole } from '@prisma/client';

import { AuditService } from '../common/audit/audit.service';
import { newLinkToken, hashLinkToken, normalizeEmail } from '../common/crypto/link-token';
import { paginated, type Paginated } from '../common/dto/pagination.dto';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

@Injectable()
export class InvitationsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly email: EmailService,
        private readonly audit: AuditService,
    ) {}

    /**
     * Create (or refresh) a pending invitation and email the link. Only an OWNER may invite as OWNER. Rejects
     * inviting someone who is already a member. Re-inviting the same email UPSERTS — a fresh token + expiry —
     * so a lost email can be re-sent without piling up rows. The email send is best-effort (never blocks).
     */
    async create(orgId: string, actorId: string, actorRole: OrgRole, email: string, role: OrgRole = OrgRole.MEMBER) {
        if (role === OrgRole.OWNER && actorRole !== OrgRole.OWNER) {
            throw new ForbiddenException('Only an owner can invite someone as an owner.');
        }
        const normEmail = normalizeEmail(email);

        // Already a member? (only knowable if they have an account) → 409, don't create a pointless invite.
        const existingUser = await this.prisma.user.findUnique({ where: { email: normEmail }, select: { id: true } });
        if (existingUser) {
            const member = await this.prisma.orgMembership.findUnique({
                where: { orgId_userId: { orgId, userId: existingUser.id } },
                select: { userId: true },
            });
            if (member) throw new ConflictException('That email is already a member of this organization.');
        }

        const { token, hash } = newLinkToken();
        const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
        const invite = await this.prisma.$transaction(async (tx) => {
            const row = await tx.orgInvitation.upsert({
                where: { orgId_email: { orgId, email: normEmail } },
                create: {
                    orgId,
                    email: normEmail,
                    role,
                    tokenHash: hash,
                    invitedByUserId: actorId,
                    expiresAt,
                    status: 'PENDING',
                },
                update: {
                    role,
                    tokenHash: hash,
                    invitedByUserId: actorId,
                    expiresAt,
                    status: 'PENDING',
                    acceptedAt: null,
                    acceptedByUserId: null,
                },
                select: {
                    id: true,
                    email: true,
                    role: true,
                    status: true,
                    invitedByUserId: true,
                    expiresAt: true,
                    createdAt: true,
                },
            });
            await tx.auditLog.create({
                data: this.audit.buildData({
                    action: 'org.member.invite',
                    entityType: 'OrgInvitation',
                    entityId: row.id,
                    orgId,
                    userId: null,
                    adminActorId: null,
                    after: { email: normEmail, role },
                    extra: { actorUserId: actorId },
                }),
            });
            return row;
        });

        // Best-effort email AFTER commit (EmailService swallows delivery failures; the invite already exists).
        const [org, inviter] = await Promise.all([
            this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
            this.prisma.user.findUnique({ where: { id: actorId }, select: { name: true } }),
        ]);
        await this.email.sendOrgInviteEmail(normEmail, token, org?.name ?? 'your team', inviter?.name ?? 'A teammate');
        return invite;
    }

    /** List an org's invitations (OWNER/ADMIN — gated by the caller). Paginated for consistency. */
    async list(orgId: string, page: { limit: number; offset: number }): Promise<Paginated<unknown>> {
        const where = { orgId };
        const [items, total] = await Promise.all([
            this.prisma.orgInvitation.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                select: {
                    id: true,
                    email: true,
                    role: true,
                    status: true,
                    invitedByUserId: true,
                    expiresAt: true,
                    acceptedAt: true,
                    createdAt: true,
                },
                skip: page.offset,
                take: page.limit,
            }),
            this.prisma.orgInvitation.count({ where }),
        ]);
        return paginated(items, total, page.limit, page.offset);
    }

    /** Revoke a PENDING invitation. 404 if it isn't this org's; 400 if it's already accepted/revoked/expired. */
    async revoke(orgId: string, invitationId: string, actorId: string) {
        const invite = await this.prisma.orgInvitation.findFirst({
            where: { id: invitationId, orgId },
            select: { id: true, status: true, email: true },
        });
        if (!invite) throw new NotFoundException('Invitation not found');
        if (invite.status !== 'PENDING') throw new BadRequestException('Only a pending invitation can be revoked.');
        await this.prisma.$transaction(async (tx) => {
            await tx.orgInvitation.update({ where: { id: invite.id }, data: { status: 'REVOKED' } });
            await tx.auditLog.create({
                data: this.audit.buildData({
                    action: 'org.member.invite_revoke',
                    entityType: 'OrgInvitation',
                    entityId: invite.id,
                    orgId,
                    userId: null,
                    adminActorId: null,
                    before: { email: invite.email, status: 'PENDING' },
                    after: { status: 'REVOKED' },
                    extra: { actorUserId: actorId },
                }),
            });
        });
    }

    /**
     * Accept an invitation as the logged-in invitee. Validates the token, PENDING status, expiry, and that the
     * caller's email matches the invited address; then creates the membership (idempotent — keeps an existing
     * role) and marks the invite accepted. Audited under the invitee, recording the inviter in meta.
     */
    async accept(token: string, userId: string): Promise<{ orgId: string; role: OrgRole }> {
        const invite = await this.prisma.orgInvitation.findFirst({
            where: { tokenHash: hashLinkToken(token) },
            select: {
                id: true,
                orgId: true,
                email: true,
                role: true,
                status: true,
                expiresAt: true,
                invitedByUserId: true,
            },
        });
        if (!invite) throw new NotFoundException('Invitation not found');
        if (invite.status !== 'PENDING') throw new BadRequestException('This invitation is no longer valid.');
        if (invite.expiresAt.getTime() < Date.now()) {
            await this.prisma.orgInvitation
                .update({ where: { id: invite.id }, data: { status: 'EXPIRED' } })
                .catch(() => undefined);
            throw new BadRequestException('This invitation has expired.');
        }
        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
        if (!user || normalizeEmail(user.email) !== invite.email) {
            throw new ForbiddenException('This invitation was sent to a different email address.');
        }

        return this.prisma.$transaction(async (tx) => {
            // Atomically CLAIM the invite: flip PENDING→ACCEPTED under a status guard so exactly one accept can
            // win. If a concurrent accept — or a revoke landing between our pre-check and here — already moved it
            // out of PENDING, count is 0 and we abort before creating any membership. (Same single-use claim the
            // refresh-token rotation uses in AuthService.) The pre-transaction checks above stay as a fast-fail.
            const claimed = await tx.orgInvitation.updateMany({
                where: { id: invite.id, status: 'PENDING' },
                data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedByUserId: userId },
            });
            if (claimed.count !== 1) throw new BadRequestException('This invitation is no longer valid.');

            const membership = await tx.orgMembership.upsert({
                where: { orgId_userId: { orgId: invite.orgId, userId } },
                create: { orgId: invite.orgId, userId, role: invite.role },
                update: {}, // already a member → keep their current role, don't silently change it
                select: { id: true, role: true },
            });
            await tx.auditLog.create({
                data: this.audit.buildData({
                    action: 'org.member.add',
                    entityType: 'OrgMembership',
                    entityId: membership.id,
                    orgId: invite.orgId,
                    userId,
                    adminActorId: null,
                    after: { role: membership.role },
                    extra: { via: 'invitation', invitedByUserId: invite.invitedByUserId },
                }),
            });
            return { orgId: invite.orgId, role: membership.role };
        });
    }
}
