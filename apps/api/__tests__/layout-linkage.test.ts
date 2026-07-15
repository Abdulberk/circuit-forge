/**
 * Layout ↔ version linkage e2e — proves a PCB layout can be RE-FOUND after a page reload, which was
 * impossible before: a LayoutJob carried no projectId/versionId, so the only handle was the jobId held in
 * browser memory. Now POST /layouts accepts an optional versionId; the server derives the project + org from
 * it (the client can't spoof one it can't access), and GET /layouts?versionId= re-hydrates the PCB tab from
 * the DURABLE versionId (route state) instead of the ephemeral jobId. Boots the real app + DB + Redis; the
 * pcb-worker is not running, so jobs stay QUEUED — which is all this contract needs. Requires Postgres + Redis.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const circuit = {
    version: '1.0',
    components: [
        { id: 'V1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: '0' }] },
        { id: 'R1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: '0' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: '0', name: '0', isGround: true }],
};

describe('Layout ↔ version linkage (GET /layouts, POST /layouts versionId)', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let server: import('http').Server;

    // user A owns the version; user B is an outsider for the isolation checks.
    let tokenA = '', userIdA = '', orgA = '', projectA = '', versionA = '';
    let tokenB = '', userIdB = '', orgB = '';
    let orgA2 = '', projA2 = ''; // a SECOND org for user A → proves org is derived from the version, not first-org
    let versionedJobId = '', adhocJobId = '';

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
        await app.init();
        prisma = app.get(PrismaService);
        server = app.getHttpServer();

        const regA = await request(server).post('/auth/register').send({ email: `lay-a-${Date.now()}@test.com`, password: 'SecurePassword123!', name: 'Lay A' }).expect(201);
        tokenA = regA.body.accessToken;
        userIdA = regA.body.user.id;
        orgA = (await request(server).post('/orgs').set('Authorization', `Bearer ${tokenA}`).send({ name: 'Lay Org A' }).expect(201)).body.id;
        projectA = (await request(server).post(`/orgs/${orgA}/projects`).set('Authorization', `Bearer ${tokenA}`).send({ name: 'Lay Proj A' }).expect(201)).body.id;
        versionA = (await request(server).post(`/projects/${projectA}/versions`).set('Authorization', `Bearer ${tokenA}`).send({ circuitJson: circuit, uiJson: {} }).expect(201)).body.id;

        const regB = await request(server).post('/auth/register').send({ email: `lay-b-${Date.now()}@test.com`, password: 'SecurePassword123!', name: 'Lay B' }).expect(201);
        tokenB = regB.body.accessToken;
        userIdB = regB.body.user.id;
        orgB = (await request(server).post('/orgs').set('Authorization', `Bearer ${tokenB}`).send({ name: 'Lay Org B' }).expect(201)).body.id;
    });

    afterAll(async () => {
        const orgs = [orgA, orgA2, orgB];
        const projects = [projectA, projA2];
        await prisma.layoutJob.deleteMany({ where: { orgId: { in: orgs } } }).catch(() => undefined);
        await prisma.projectVersion.deleteMany({ where: { projectId: { in: projects } } }).catch(() => undefined);
        await prisma.project.deleteMany({ where: { id: { in: projects } } }).catch(() => undefined);
        await prisma.orgMembership.deleteMany({ where: { orgId: { in: orgs } } }).catch(() => undefined);
        await prisma.organization.deleteMany({ where: { id: { in: orgs } } }).catch(() => undefined);
        await prisma.user.deleteMany({ where: { id: { in: [userIdA, userIdB] } } }).catch(() => undefined);
        await app.close();
    });

    it('POST /layouts with a versionId → 202 QUEUED; the server derives project + org from the version', async () => {
        const r = await request(server).post('/layouts').set('Authorization', `Bearer ${tokenA}`).send({ circuit, versionId: versionA }).expect(202);
        expect(r.body).toMatchObject({ status: 'QUEUED' });
        expect(typeof r.body.jobId).toBe('string');
        versionedJobId = r.body.jobId;

        // The detail view echoes the linkage; projectId was DERIVED server-side (the client sent only versionId).
        const detail = await request(server).get(`/layouts/${versionedJobId}`).set('Authorization', `Bearer ${tokenA}`).expect(200);
        expect(detail.body).toMatchObject({ id: versionedJobId, versionId: versionA, projectId: projectA, status: 'QUEUED' });
    });

    it('THE RELOAD: GET /layouts?versionId= re-finds the layout from the durable versionId alone (no jobId in hand)', async () => {
        const r = await request(server).get(`/layouts?versionId=${versionA}`).set('Authorization', `Bearer ${tokenA}`).expect(200);
        // Bounded envelope (same contract as every other list endpoint).
        expect(r.body).toMatchObject({ total: 1, limit: 50, offset: 0, hasMore: false });
        expect(r.body.items).toHaveLength(1);
        expect(r.body.items[0]).toMatchObject({ id: versionedJobId, versionId: versionA, projectId: projectA, status: 'QUEUED' });
    });

    it('an ad-hoc layout (no versionId) is created under the first org with null linkage and is excluded from the version filter', async () => {
        const r = await request(server).post('/layouts').set('Authorization', `Bearer ${tokenA}`).send({ circuit }).expect(202);
        adhocJobId = r.body.jobId;

        const detail = await request(server).get(`/layouts/${adhocJobId}`).set('Authorization', `Bearer ${tokenA}`).expect(200);
        expect(detail.body).toMatchObject({ id: adhocJobId, versionId: null, projectId: null });

        // The version filter must NOT return the untagged job...
        const filtered = await request(server).get(`/layouts?versionId=${versionA}`).set('Authorization', `Bearer ${tokenA}`).expect(200);
        expect(filtered.body.items.map((j: { id: string }) => j.id)).not.toContain(adhocJobId);

        // ...but the unfiltered list returns both, newest (the ad-hoc) first.
        const all = await request(server).get('/layouts').set('Authorization', `Bearer ${tokenA}`).expect(200);
        const ids = all.body.items.map((j: { id: string }) => j.id);
        expect(ids).toEqual(expect.arrayContaining([versionedJobId, adhocJobId]));
        expect(ids[0]).toBe(adhocJobId);
    });

    it('the projectId filter returns the versioned job', async () => {
        const r = await request(server).get(`/layouts?projectId=${projectA}`).set('Authorization', `Bearer ${tokenA}`).expect(200);
        expect(r.body.items.map((j: { id: string }) => j.id)).toContain(versionedJobId);
    });

    it('the layout org is DERIVED from the version, not the actor\'s first org (multi-org)', async () => {
        // A second org for user A with its own project + version. findAllForUser orders memberships by
        // createdAt asc, so orgA (created first) remains the first-org fallback and orgA2 never is — making
        // "org came from the version" distinguishable from "org came from orgList[0]".
        orgA2 = (await request(server).post('/orgs').set('Authorization', `Bearer ${tokenA}`).send({ name: 'Lay Org A2' }).expect(201)).body.id;
        projA2 = (await request(server).post(`/orgs/${orgA2}/projects`).set('Authorization', `Bearer ${tokenA}`).send({ name: 'Lay Proj A2' }).expect(201)).body.id;
        const verA2 = (await request(server).post(`/projects/${projA2}/versions`).set('Authorization', `Bearer ${tokenA}`).send({ circuitJson: circuit, uiJson: {} }).expect(201)).body.id;

        // The org an UNtagged job falls back to (the actor's first org), read from the earlier ad-hoc job.
        const fallback = await prisma.layoutJob.findUnique({ where: { id: adhocJobId }, select: { orgId: true } });
        expect(fallback?.orgId).toBeTruthy();
        expect(orgA2).not.toBe(fallback?.orgId); // orgA2 is genuinely a different org than the fallback

        // Tag a layout to the orgA2 version → its org MUST be the version's org (derived), not the fallback.
        const j = await request(server).post('/layouts').set('Authorization', `Bearer ${tokenA}`).send({ circuit, versionId: verA2 }).expect(202);
        const row = await prisma.layoutJob.findUnique({ where: { id: j.body.jobId }, select: { orgId: true, versionId: true, projectId: true } });
        expect(row).toMatchObject({ orgId: orgA2, versionId: verA2, projectId: projA2 });
        expect(row?.orgId).not.toBe(fallback?.orgId);
    });

    it('a stranger cannot tag a layout to a version they cannot access → 403', async () => {
        await request(server).post('/layouts').set('Authorization', `Bearer ${tokenB}`).send({ circuit, versionId: versionA }).expect(403);
    });

    it('list isolation: user B sees none of user A\'s layouts, and the version filter yields nothing for them', async () => {
        const all = await request(server).get('/layouts').set('Authorization', `Bearer ${tokenB}`).expect(200);
        const ids = all.body.items.map((j: { id: string }) => j.id);
        expect(ids).not.toContain(versionedJobId);
        expect(ids).not.toContain(adhocJobId);

        const filtered = await request(server).get(`/layouts?versionId=${versionA}`).set('Authorization', `Bearer ${tokenB}`).expect(200);
        expect(filtered.body.items).toHaveLength(0);
    });

    it('POST /layouts with an unknown versionId → 404 (no silent untagged job)', async () => {
        await request(server).post('/layouts').set('Authorization', `Bearer ${tokenA}`).send({ circuit, versionId: '00000000-0000-0000-0000-000000000000' }).expect(404);
    });

    it('the list is bounded — a client cannot ask for everything → 400', async () => {
        await request(server).get('/layouts?limit=1000').set('Authorization', `Bearer ${tokenA}`).expect(400);
    });
});
