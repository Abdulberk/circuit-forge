/**
 * Org invitation e2e (phase 2: the invite → accept "add a teammate" flow). Proves create (OWNER/ADMIN,
 * only-OWNER-invites-OWNER, already-member 409, audit) + list/revoke + the security-critical accept path:
 * token match, PENDING-only, expiry, single-use, and the invited-email must equal the caller's email. The
 * raw token lives only in the emailed link (never in the API response), so the accept cases seed an
 * invitation with a KNOWN token via the REAL hashLinkToken util (no mocks). Boots the real app + DB.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashLinkToken } from '../src/common/crypto/link-token';

describe('Org invitations (invite → accept)', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let server: import('http').Server;

    let owner = '', ownerId = '', orgA = '';
    let adminTok = '', adminId = '';
    let memberTok = '', memberId = '', memberEmail = '';
    let inviteeTok = '', inviteeId = '', inviteeEmail = '';
    let otherTok = '', otherId = '', otherEmail = '';
    let expTok = '', expId = '', expEmail = '';

    const invite = (org: string, tok: string, body: object) => request(server).post(`/orgs/${org}/invitations`).set('Authorization', `Bearer ${tok}`).send(body);
    const listInv = (org: string, tok: string, q = '') => request(server).get(`/orgs/${org}/invitations${q}`).set('Authorization', `Bearer ${tok}`);
    const accept = (tok: string, token: string) => request(server).post('/invitations/accept').set('Authorization', `Bearer ${tok}`).send({ token });

    // Seed a PENDING invitation with a known raw token (accept-path fixtures — raw token isn't API-exposed).
    const seedInvite = (email: string, rawToken: string, opts: { expiresAt?: Date; role?: 'OWNER' | 'ADMIN' | 'MEMBER' } = {}) =>
        prisma.orgInvitation.create({ data: {
            orgId: orgA, email: email.toLowerCase(), role: opts.role ?? 'MEMBER', tokenHash: hashLinkToken(rawToken),
            status: 'PENDING', invitedByUserId: ownerId, expiresAt: opts.expiresAt ?? new Date(Date.now() + 3_600_000),
        } });

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
        await app.init();
        prisma = app.get(PrismaService);
        server = app.getHttpServer();

        const reg = async (p: string) => {
            const email = `${p}-${Date.now()}@test.com`;
            const body = (await request(server).post('/auth/register').send({ email, password: 'SecurePassword123!', name: p }).expect(201)).body;
            return { tok: body.accessToken, id: body.user.id, email };
        };
        const o = await reg('inv-owner'); owner = o.tok; ownerId = o.id;
        const a = await reg('inv-admin'); adminTok = a.tok; adminId = a.id;
        const m = await reg('inv-member'); memberTok = m.tok; memberId = m.id; memberEmail = m.email;
        const iv = await reg('inv-invitee'); inviteeTok = iv.tok; inviteeId = iv.id; inviteeEmail = iv.email;
        const ot = await reg('inv-other'); otherTok = ot.tok; otherId = ot.id; otherEmail = ot.email;
        const ex = await reg('inv-expired'); expTok = ex.tok; expId = ex.id; expEmail = ex.email;

        orgA = (await request(server).post('/orgs').set('Authorization', `Bearer ${owner}`).send({ name: 'Inv Org A' }).expect(201)).body.id;
        await prisma.orgMembership.createMany({ data: [
            { orgId: orgA, userId: adminId, role: 'ADMIN' },
            { orgId: orgA, userId: memberId, role: 'MEMBER' },
        ] });
    });

    afterAll(async () => {
        await prisma.orgInvitation.deleteMany({ where: { orgId: orgA } }).catch(() => undefined);
        await prisma.auditLog.deleteMany({ where: { orgId: orgA } }).catch(() => undefined);
        await prisma.orgMembership.deleteMany({ where: { orgId: orgA } }).catch(() => undefined);
        await prisma.organization.deleteMany({ where: { id: orgA } }).catch(() => undefined);
        await prisma.user.deleteMany({ where: { id: { in: [ownerId, adminId, memberId, inviteeId, otherId, expId] } } }).catch(() => undefined);
        await app.close();
    });

    it('an OWNER creates a pending invitation; it is persisted + audited (adminActorId null, actor in meta)', async () => {
        const r = await invite(orgA, owner, { email: 'New1@test.com', role: 'MEMBER' }).expect(201);
        expect(r.body).toMatchObject({ email: 'new1@test.com', role: 'MEMBER', status: 'PENDING' });
        expect(r.body.expiresAt).toBeTruthy();
        const row = await prisma.orgInvitation.findFirst({ where: { orgId: orgA, email: 'new1@test.com' } });
        expect(row).toMatchObject({ status: 'PENDING', invitedByUserId: ownerId });
        expect(typeof row!.tokenHash).toBe('string');
        const audit = await prisma.auditLog.findFirst({ where: { orgId: orgA, action: 'org.member.invite' }, orderBy: { createdAt: 'desc' } });
        expect(audit?.adminActorId).toBeNull();
        expect((audit!.meta as Record<string, any>).actorUserId).toBe(ownerId);
    });

    it('an ADMIN may invite a MEMBER, but only an OWNER may invite an OWNER', async () => {
        await invite(orgA, adminTok, { email: 'new2@test.com', role: 'MEMBER' }).expect(201);
        await invite(orgA, adminTok, { email: 'new3@test.com', role: 'OWNER' }).expect(403);
        await invite(orgA, owner, { email: 'new3@test.com', role: 'OWNER' }).expect(201);
    });

    it('inviting an existing member → 409', async () => {
        await invite(orgA, owner, { email: memberEmail, role: 'MEMBER' }).expect(409);
    });

    it('list is OWNER/ADMIN only; a plain MEMBER and a non-member are refused', async () => {
        const r = await listInv(orgA, owner).expect(200);
        expect(r.body.total).toBeGreaterThanOrEqual(3);
        await listInv(orgA, memberTok).expect(403);
        await listInv(orgA, otherTok).expect(403);
    });

    it('revoke: a pending invite can be revoked once; re-revoke → 400; unknown → 404', async () => {
        const created = await invite(orgA, owner, { email: 'revoke-me@test.com', role: 'MEMBER' }).expect(201);
        const id = created.body.id;
        await request(server).delete(`/orgs/${orgA}/invitations/${id}`).set('Authorization', `Bearer ${owner}`).expect(204);
        const row = await prisma.orgInvitation.findUnique({ where: { id } });
        expect(row?.status).toBe('REVOKED');
        await request(server).delete(`/orgs/${orgA}/invitations/${id}`).set('Authorization', `Bearer ${owner}`).expect(400);
        await request(server).delete(`/orgs/${orgA}/invitations/00000000-0000-0000-0000-000000000000`).set('Authorization', `Bearer ${owner}`).expect(404);
    });

    it('ACCEPT: the invited user joins the org; invite marked ACCEPTED; membership + audit written; token is single-use', async () => {
        await seedInvite(inviteeEmail, 'tok-accept', { role: 'MEMBER' });
        const r = await accept(inviteeTok, 'tok-accept').expect(200);
        expect(r.body).toMatchObject({ orgId: orgA, role: 'MEMBER' });

        const membership = await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: orgA, userId: inviteeId } } });
        expect(membership?.role).toBe('MEMBER');
        const inv = await prisma.orgInvitation.findFirst({ where: { orgId: orgA, email: inviteeEmail.toLowerCase() } });
        expect(inv).toMatchObject({ status: 'ACCEPTED', acceptedByUserId: inviteeId });
        const audit = await prisma.auditLog.findFirst({ where: { orgId: orgA, action: 'org.member.add', userId: inviteeId }, orderBy: { createdAt: 'desc' } });
        expect(audit?.adminActorId).toBeNull();
        expect((audit!.meta as Record<string, any>).via).toBe('invitation');

        // single-use: the token no longer works
        await accept(inviteeTok, 'tok-accept').expect(400);
    });

    it('ACCEPT is rejected when the caller email ≠ the invited email → 403', async () => {
        await seedInvite('someone-else@test.com', 'tok-mismatch', { role: 'MEMBER' });
        await accept(otherTok, 'tok-mismatch').expect(403);
    });

    it('ACCEPT of an expired invite → 400, and the invite is marked EXPIRED', async () => {
        await seedInvite(expEmail, 'tok-expired', { expiresAt: new Date(Date.now() - 1000) });
        await accept(expTok, 'tok-expired').expect(400);
        const inv = await prisma.orgInvitation.findFirst({ where: { orgId: orgA, email: expEmail.toLowerCase() } });
        expect(inv?.status).toBe('EXPIRED');
    });

    it('ACCEPT with an unknown token → 404', async () => {
        await accept(otherTok, 'no-such-token').expect(404);
    });

    it('inviting an email with NO account still creates a pending invite (the point of the flow)', async () => {
        const r = await invite(orgA, owner, { email: 'ghost@test.com', role: 'MEMBER' }).expect(201);
        expect(r.body).toMatchObject({ email: 'ghost@test.com', status: 'PENDING' });
        const row = await prisma.orgInvitation.findFirst({ where: { orgId: orgA, email: 'ghost@test.com' } });
        expect(row).toMatchObject({ status: 'PENDING' });
        expect(typeof row!.tokenHash).toBe('string');
    });

    it('re-inviting the same email UPSERTS one row — a revoked invite is refreshed back to PENDING', async () => {
        const c1 = await invite(orgA, owner, { email: 'refresh@test.com', role: 'MEMBER' }).expect(201);
        await request(server).delete(`/orgs/${orgA}/invitations/${c1.body.id}`).set('Authorization', `Bearer ${owner}`).expect(204);
        const c2 = await invite(orgA, owner, { email: 'refresh@test.com', role: 'ADMIN' }).expect(201);
        expect(c2.body.id).toBe(c1.body.id);       // same row, not a duplicate
        expect(c2.body.status).toBe('PENDING');     // revoked → refreshed
        expect(c2.body.role).toBe('ADMIN');         // role updated on re-invite
    });

    it('a REVOKED invite cannot be accepted even by the right email → 400 (atomic status guard)', async () => {
        await seedInvite(otherEmail, 'tok-revoked', { role: 'MEMBER' });
        await prisma.orgInvitation.updateMany({ where: { orgId: orgA, email: otherEmail.toLowerCase() }, data: { status: 'REVOKED' } });
        await accept(otherTok, 'tok-revoked').expect(400);
        // and no membership was created as a side effect
        const m = await prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: orgA, userId: otherId } } });
        expect(m).toBeNull();
    });
});
