/**
 * Self-serve org member management e2e (phase 1: manage EXISTING members). Proves the 3 shared endpoints —
 * GET members / PATCH role / DELETE — with their tenant RBAC + role guardrails (only an OWNER grants/revokes
 * OWNER; the last OWNER can't be demoted/removed; only an OWNER removes an OWNER) and that every mutation
 * writes a TENANT audit row (adminActorId null, acting user in meta.actorUserId). Members are seeded directly
 * (the invite/add path is phase 2). Boots the real app + DB. Requires Postgres.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Org member management (GET/PATCH/DELETE /orgs/:orgId/members)', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let server: import('http').Server;

    let owner = '', ownerId = '', orgA = '';
    let adminTok = '', adminId = '';   // ADMIN of orgA
    let m3Tok = '', m3Id = '';         // MEMBER of orgA (promoted mid-suite)
    let m4Id = '';                     // MEMBER of orgA
    let outTok = '', outId = '', orgB = '';

    const members = (org: string, tok: string, q = '') => request(server).get(`/orgs/${org}/members${q}`).set('Authorization', `Bearer ${tok}`);
    const patchRole = (org: string, uid: string, tok: string, body: object) => request(server).patch(`/orgs/${org}/members/${uid}`).set('Authorization', `Bearer ${tok}`).send(body);
    const del = (org: string, uid: string, tok: string, body: object = {}) => request(server).delete(`/orgs/${org}/members/${uid}`).set('Authorization', `Bearer ${tok}`).send(body);

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
        await app.init();
        prisma = app.get(PrismaService);
        server = app.getHttpServer();

        const reg = async (p: string) => (await request(server).post('/auth/register').send({ email: `${p}-${Date.now()}@test.com`, password: 'SecurePassword123!', name: p }).expect(201)).body;
        const o = await reg('mem-owner'); owner = o.accessToken; ownerId = o.user.id;
        const ad = await reg('mem-admin'); adminTok = ad.accessToken; adminId = ad.user.id;
        const u3 = await reg('mem-3'); m3Tok = u3.accessToken; m3Id = u3.user.id;
        const u4 = await reg('mem-4'); m4Id = u4.user.id;
        const ob = await reg('mem-out'); outTok = ob.accessToken; outId = ob.user.id;

        orgA = (await request(server).post('/orgs').set('Authorization', `Bearer ${owner}`).send({ name: 'Mem Org A' }).expect(201)).body.id;
        orgB = (await request(server).post('/orgs').set('Authorization', `Bearer ${outTok}`).send({ name: 'Mem Org B' }).expect(201)).body.id;
        // Seed orgA team (invite path is phase 2): admin, + two members.
        await prisma.orgMembership.createMany({ data: [
            { orgId: orgA, userId: adminId, role: 'ADMIN' },
            { orgId: orgA, userId: m3Id, role: 'MEMBER' },
            { orgId: orgA, userId: m4Id, role: 'MEMBER' },
        ] });
    });

    afterAll(async () => {
        await prisma.auditLog.deleteMany({ where: { orgId: { in: [orgA, orgB] } } }).catch(() => undefined);
        await prisma.orgMembership.deleteMany({ where: { orgId: { in: [orgA, orgB] } } }).catch(() => undefined);
        await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } }).catch(() => undefined);
        await prisma.user.deleteMany({ where: { id: { in: [ownerId, adminId, m3Id, m4Id, outId] } } }).catch(() => undefined);
        await app.close();
    });

    it('lists members with role + identity (owner reads)', async () => {
        const r = await members(orgA, owner).expect(200);
        expect(r.body).toMatchObject({ total: 4 });
        const byId = Object.fromEntries(r.body.items.map((m: { userId: string }) => [m.userId, m]));
        expect(byId[ownerId]).toMatchObject({ role: 'OWNER' });
        expect(byId[adminId]).toMatchObject({ role: 'ADMIN' });
        expect(byId[m3Id]).toMatchObject({ role: 'MEMBER' });
        expect(typeof byId[ownerId].email).toBe('string');
    });

    it('any member can read the list; a non-member cannot', async () => {
        await members(orgA, m3Tok).expect(200);
        await members(orgA, outTok).expect(403);
    });

    it("guard: the sole OWNER can't demote or remove themselves (last owner)", async () => {
        await patchRole(orgA, ownerId, owner, { role: 'ADMIN' }).expect(400);
        await del(orgA, ownerId, owner).expect(400);
    });

    it('guard: an ADMIN cannot mint an OWNER', async () => {
        await patchRole(orgA, m4Id, adminTok, { role: 'OWNER' }).expect(403);
    });

    it('an ADMIN may re-role a MEMBER, and it writes a tenant audit row (actor in meta, adminActorId null)', async () => {
        await patchRole(orgA, m3Id, adminTok, { role: 'ADMIN', reason: 'needs manage access' }).expect(200);
        const row = await prisma.auditLog.findFirst({ where: { orgId: orgA, action: 'org.member.role_change', userId: m3Id }, orderBy: { createdAt: 'desc' } });
        expect(row).toBeTruthy();
        expect(row!.adminActorId).toBeNull(); // NOT a platform-admin action
        const meta = row!.meta as Record<string, any>;
        expect(meta.actorUserId).toBe(adminId);
        expect(meta.before).toEqual({ role: 'MEMBER' });
        expect(meta.after).toEqual({ role: 'ADMIN' });
        expect(meta.reason).toBe('needs manage access');
    });

    it('an OWNER may grant OWNER (now two owners) and then demote the non-last owner', async () => {
        await patchRole(orgA, m4Id, owner, { role: 'OWNER' }).expect(200);
        // with two owners, demoting one is allowed
        const r = await patchRole(orgA, m4Id, owner, { role: 'MEMBER' }).expect(200);
        expect(r.body).toMatchObject({ orgId: orgA, userId: m4Id, role: 'MEMBER' });
    });

    it('removing a member writes an audit row; an ADMIN cannot remove an OWNER', async () => {
        await del(orgA, m3Id, owner, { reason: 'offboarded' }).expect(200);
        const row = await prisma.auditLog.findFirst({ where: { orgId: orgA, action: 'org.member.remove', userId: m3Id }, orderBy: { createdAt: 'desc' } });
        expect(row?.adminActorId).toBeNull();
        expect((row!.meta as Record<string, any>).before).toEqual({ role: 'ADMIN' });
        expect((row!.meta as Record<string, any>).after).toBeNull();
        // an ADMIN cannot remove the OWNER
        await del(orgA, ownerId, adminTok).expect(403);
    });

    it('404 for a non-member target; 403 for a non-member actor', async () => {
        await patchRole(orgA, outId, owner, { role: 'ADMIN' }).expect(404); // outsider isn't a member of orgA
        await patchRole(orgA, m4Id, outTok, { role: 'ADMIN' }).expect(403); // outsider can't act on orgA
    });

    it('the members list is bounded — over-cap limit → 400', async () => {
        await members(orgA, owner, '?limit=1000').expect(400);
    });
});
