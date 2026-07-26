/**
 * Authorization / multi-tenant ISOLATION (IDOR) e2e.
 *
 * The single most important property of a multi-tenant SaaS: org A's user can NEVER read or mutate org B's
 * resources. The code enforces it via OrgsService.checkMembership on every org-scoped path, but until now
 * nothing PROVED the boundary holds end to end. This boots the real app against the real DB and, for every
 * owned resource (org, project, version, sim job, design job, usage, asset), asserts that a DIFFERENT org's
 * authenticated user is DENIED (403/404) — while a positive control confirms the OWNER can reach the same
 * resources (so a blanket-deny bug couldn't make this pass vacuously).
 *
 * Denied = 403 (checkMembership: "not a member") for resource access, or 404 (orgs.findOne hides existence)
 * for the org entity itself — never 200, never the data. Requires Postgres + Redis up (like e2e-smoke).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../src/prisma/prisma.service';

const circuit = {
    version: '1.0',
    components: [
        { id: 'V1', type: 'voltage_source', designator: 'V1', value: 'DC 10', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: '0' }] },
        { id: 'R1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'R2', type: 'resistor', designator: 'R2', value: '1k', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: '0' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: '0', name: '0', isGround: true }],
};

describe('Authz / multi-tenant isolation (IDOR)', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let server: import('http').Server;

    const stamp = Date.now();
    const A = { email: `idor-a-${stamp}@test.com`, password: 'SecurePassword123!', name: 'Tenant A' };
    const B = { email: `idor-b-${stamp}@test.com`, password: 'SecurePassword123!', name: 'Tenant B' };

    // Tenant A's resources (the targets) + B's token (the attacker).
    let tokenA = '', tokenB = '', userIdA = '', userIdB = '';
    let orgA = '', orgB = '', projectA = '', versionA = '', simJobA = '', designJobA = '', assetA = '';

    const register = async (u: typeof A) => {
        const res = await request(server).post('/auth/register').send(u).expect(201);
        return { token: res.body.accessToken as string, userId: res.body.user.id as string };
    };
    const post = (path: string, token: string, body?: unknown) =>
        request(server).post(path).set('Authorization', `Bearer ${token}`).send(body ?? {});
    const get = (path: string, token: string) => request(server).get(path).set('Authorization', `Bearer ${token}`);

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleFixture.createNestApplication();
        // Mirror production globals so the test exercises the real request path (filter reshapes the body but
        // NOT the status — the isolation assertions are on status, so they hold regardless).
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
        app.useGlobalFilters(new AllExceptionsFilter());
        await app.init();
        prisma = app.get(PrismaService);
        server = app.getHttpServer();

        ({ token: tokenA, userId: userIdA } = await register(A));
        ({ token: tokenB, userId: userIdB } = await register(B));

        // Tenant A builds a full resource tree.
        orgA = (await post('/orgs', tokenA, { name: 'Org A' }).expect(201)).body.id;
        projectA = (await post(`/orgs/${orgA}/projects`, tokenA, { name: 'Proj A' }).expect(201)).body.id;
        versionA = (await post(`/projects/${projectA}/versions`, tokenA, { circuitJson: circuit, uiJson: {} }).expect(201)).body.id;
        simJobA = (await post(`/versions/${versionA}/simulations`, tokenA, { analysisConfig: { type: 'op' }, probes: ['out'] }).expect(201)).body.jobId;
        designJobA = (await post('/design-jobs', tokenA, { prompt: 'a 5V divider', maxRounds: 1 }).expect(202)).body.jobId;
        // Asset row created directly (upload path needs S3); orgId = A so the cross-org read can be tested.
        assetA = (await prisma.asset.create({
            data: { orgId: orgA, type: 'SPICE_MODEL', name: 'a.lib', contentType: 'text/plain', sizeBytes: 10, s3Key: `models/${orgA}/a.lib`, sha256: 'x'.repeat(64) },
            select: { id: true },
        })).id;

        // Tenant B is a fully valid user with their OWN org — so a denial below is about ISOLATION, not a
        // broken/unauthenticated token.
        orgB = (await post('/orgs', tokenB, { name: 'Org B' }).expect(201)).body.id;
    });

    afterAll(async () => {
        await prisma.simulationJob.deleteMany({ where: { id: simJobA } }).catch(() => undefined);
        await prisma.designJob.deleteMany({ where: { id: designJobA } }).catch(() => undefined);
        await prisma.asset.deleteMany({ where: { id: assetA } }).catch(() => undefined);
        await prisma.projectVersion.deleteMany({ where: { id: versionA } }).catch(() => undefined);
        await prisma.project.deleteMany({ where: { id: projectA } }).catch(() => undefined);
        for (const org of [orgA, orgB]) {
            await prisma.orgMembership.deleteMany({ where: { orgId: org } }).catch(() => undefined);
            await prisma.organization.deleteMany({ where: { id: org } }).catch(() => undefined);
        }
        await prisma.user.deleteMany({ where: { id: { in: [userIdA, userIdB] } } }).catch(() => undefined);
        await app.close();
    });

    it('positive control: the OWNER (A) can reach its own resources (proves the targets exist + are live)', async () => {
        await get(`/orgs/${orgA}`, tokenA).expect(200);
        await get(`/orgs/${orgA}/projects`, tokenA).expect(200);
        await get(`/projects/${projectA}`, tokenA).expect(200);
        await get(`/projects/${projectA}/versions`, tokenA).expect(200);
        await get(`/versions/${versionA}`, tokenA).expect(200);
        await get(`/simulations/${simJobA}`, tokenA).expect(200);
        await get(`/design-jobs/${designJobA}`, tokenA).expect(200);
        await get(`/orgs/${orgA}/usage`, tokenA).expect(200);
        await get(`/assets/${assetA}`, tokenA).expect(200);
    });

    describe('cross-org access is DENIED (B cannot touch A\'s resources)', () => {
        const denied = (status: number) => expect([403, 404]).toContain(status);

        it('GET /orgs/:orgIdA (org entity hidden → 404)', async () => {
            const r = await get(`/orgs/${orgA}`, tokenB);
            expect(r.status).toBe(404);
        });
        it('GET + POST /orgs/:orgIdA/projects', async () => {
            denied((await get(`/orgs/${orgA}/projects`, tokenB)).status);
            denied((await post(`/orgs/${orgA}/projects`, tokenB, { name: 'evil' })).status);
        });
        it('GET + PATCH + DELETE /projects/:projectIdA', async () => {
            denied((await get(`/projects/${projectA}`, tokenB)).status);
            denied((await request(server).patch(`/projects/${projectA}`).set('Authorization', `Bearer ${tokenB}`).send({ name: 'evil' })).status);
            denied((await request(server).delete(`/projects/${projectA}`).set('Authorization', `Bearer ${tokenB}`)).status);
        });
        it('GET /projects/:projectIdA/versions + POST a version', async () => {
            denied((await get(`/projects/${projectA}/versions`, tokenB)).status);
            // valid DTO (incl. required uiJson) so the ONLY possible rejection is authz (403), not a 400.
            denied((await post(`/projects/${projectA}/versions`, tokenB, { circuitJson: circuit, uiJson: {} })).status);
        });
        it('GET /versions/:versionIdA (+ /bom)', async () => {
            denied((await get(`/versions/${versionA}`, tokenB)).status);
            denied((await get(`/versions/${versionA}/bom`, tokenB)).status);
        });
        it('POST /versions/:versionIdA/simulations', async () => {
            denied((await post(`/versions/${versionA}/simulations`, tokenB, { analysisConfig: { type: 'op' } })).status);
        });
        it('GET /simulations/:simJobIdA (+ /result)', async () => {
            denied((await get(`/simulations/${simJobA}`, tokenB)).status);
            denied((await get(`/simulations/${simJobA}/result`, tokenB)).status);
        });
        it('GET + DELETE /design-jobs/:designJobIdA', async () => {
            denied((await get(`/design-jobs/${designJobA}`, tokenB)).status);
            denied((await request(server).delete(`/design-jobs/${designJobA}`).set('Authorization', `Bearer ${tokenB}`)).status);
        });
        it('GET /orgs/:orgIdA/usage', async () => {
            denied((await get(`/orgs/${orgA}/usage`, tokenB)).status);
        });
        it('GET + DELETE /assets/:assetIdA', async () => {
            denied((await get(`/assets/${assetA}`, tokenB)).status);
            denied((await request(server).delete(`/assets/${assetA}`).set('Authorization', `Bearer ${tokenB}`)).status);
        });
    });

    describe('unauthenticated requests are rejected (401), never leaking data', () => {
        it('no token → 401 on owned resources', async () => {
            await request(server).get(`/projects/${projectA}`).expect(401);
            await request(server).get(`/design-jobs/${designJobA}`).expect(401);
            await request(server).get(`/orgs/${orgA}/usage`).expect(401);
        });
        it('garbage bearer token → 401', async () => {
            await request(server).get(`/projects/${projectA}`).set('Authorization', 'Bearer not.a.real.token').expect(401);
        });
    });
});
