/**
 * Pagination e2e — list endpoints return a bounded { items, total, limit, offset, hasMore } envelope, page
 * correctly, and CANNOT be coerced into returning everything (the limit is capped server-side). Boots the
 * real app + DB; proven on the versions list (multi-item paging) + the projects list (envelope on a second
 * endpoint). Requires Postgres + Redis up.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const circuit = {
    version: '1.0',
    components: [
        {
            id: 'V1',
            type: 'voltage_source',
            designator: 'V1',
            value: 'DC 5',
            pins: [
                { pinId: '+', netId: 'in' },
                { pinId: '-', netId: '0' },
            ],
        },
        {
            id: 'R1',
            type: 'resistor',
            designator: 'R1',
            value: '1k',
            pins: [
                { pinId: '1', netId: 'in' },
                { pinId: '2', netId: '0' },
            ],
        },
    ],
    nets: [
        { id: 'in', name: 'in' },
        { id: '0', name: '0', isGround: true },
    ],
};

describe('Pagination (list endpoints)', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let server: import('http').Server;
    let token = '',
        userId = '',
        orgId = '',
        projectId = '';

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
        await app.init();
        prisma = app.get(PrismaService);
        server = app.getHttpServer();

        const reg = await request(server)
            .post('/auth/register')
            .send({ email: `page-${Date.now()}@test.com`, password: 'SecurePassword123!', name: 'Pager' })
            .expect(201);
        token = reg.body.accessToken;
        userId = reg.body.user.id;
        orgId = (
            await request(server)
                .post('/orgs')
                .set('Authorization', `Bearer ${token}`)
                .send({ name: 'Page Org' })
                .expect(201)
        ).body.id;
        projectId = (
            await request(server)
                .post(`/orgs/${orgId}/projects`)
                .set('Authorization', `Bearer ${token}`)
                .send({ name: 'Page Proj' })
                .expect(201)
        ).body.id;
        // 3 versions → v1, v2, v3.
        for (let i = 0; i < 3; i++) {
            await request(server)
                .post(`/projects/${projectId}/versions`)
                .set('Authorization', `Bearer ${token}`)
                .send({ circuitJson: circuit, uiJson: {} })
                .expect(201);
        }
    });

    afterAll(async () => {
        await prisma.projectVersion.deleteMany({ where: { projectId } }).catch(() => undefined);
        await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => undefined);
        await prisma.orgMembership.deleteMany({ where: { orgId } }).catch(() => undefined);
        await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
        await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
        await app.close();
    });

    const list = (q = '') =>
        request(server).get(`/projects/${projectId}/versions${q}`).set('Authorization', `Bearer ${token}`);

    it('default (no params) → bounded envelope with the default limit, all 3 items, hasMore=false', async () => {
        const r = await list().expect(200);
        expect(r.body).toMatchObject({ total: 3, limit: 50, offset: 0, hasMore: false });
        expect(r.body.items).toHaveLength(3);
        // newest first (versionNumber desc)
        expect(r.body.items[0].versionNumber).toBe(3);
    });

    it('?limit=2 → first page of 2, total still 3, hasMore=true', async () => {
        const r = await list('?limit=2').expect(200);
        expect(r.body).toMatchObject({ total: 3, limit: 2, offset: 0, hasMore: true });
        expect(r.body.items).toHaveLength(2);
        expect(r.body.items.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([3, 2]);
    });

    it('?limit=2&offset=2 → last page of 1, hasMore=false (paging walks the whole set without overlap)', async () => {
        const r = await list('?limit=2&offset=2').expect(200);
        expect(r.body).toMatchObject({ total: 3, limit: 2, offset: 2, hasMore: false });
        expect(r.body.items).toHaveLength(1);
        expect(r.body.items[0].versionNumber).toBe(1);
    });

    it('rejects an over-cap limit (a client cannot ask for everything) → 400', async () => {
        await list('?limit=1000').expect(400);
    });

    it('rejects limit=0 and negative offset → 400', async () => {
        await list('?limit=0').expect(400);
        await list('?offset=-1').expect(400);
    });

    it('the projects list is paginated too (envelope on a second endpoint)', async () => {
        const r = await request(server)
            .get(`/orgs/${orgId}/projects`)
            .set('Authorization', `Bearer ${token}`)
            .expect(200);
        expect(r.body).toMatchObject({ total: 1, offset: 0, hasMore: false });
        expect(r.body.items).toHaveLength(1);
        expect(r.body.items[0].id).toBe(projectId);
    });
});
