/**
 * Project working-copy e2e — the mutable "current draft" half of continuous autosave (Figma/Docs model).
 * Proves the properties that make it enterprise-safe rather than a version flood: (1) autosave OVERWRITES a
 * single row per project (last-writer-wins, no growth/leak), (2) autosaving NEVER creates a version — only
 * explicit "Save version" does, so history stays bounded + meaningful, (3) the draft round-trips exactly
 * (the editor rehydrates from it), (4) a draft can't point at another project's version, (5) full member
 * authz. Boots the real app + DB; no worker/S3 needed. Requires Postgres + Redis.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const baseCircuit = {
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
// A revision marker travels through the JSON so we can assert exactly which write we read back.
const rev = (r: string) => ({ ...baseCircuit, rev: r });

describe('Project working copy (PUT/GET/DELETE /projects/:id/working-copy)', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let server: import('http').Server;

    let tokenA = '',
        userIdA = '',
        orgA = '',
        projectA = '',
        versionA1 = '';
    let projectOther = '',
        versionOther = ''; // a different project's version, for the cross-project guard
    let tokenB = '',
        userIdB = '',
        orgB = '';

    const wc = (proj: string, token: string) =>
        request(server).get(`/projects/${proj}/working-copy`).set('Authorization', `Bearer ${token}`);
    const put = (proj: string, token: string, body: object) =>
        request(server).put(`/projects/${proj}/working-copy`).set('Authorization', `Bearer ${token}`).send(body);
    const versions = (proj: string) =>
        request(server).get(`/projects/${proj}/versions`).set('Authorization', `Bearer ${tokenA}`);

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
        await app.init();
        prisma = app.get(PrismaService);
        server = app.getHttpServer();

        const regA = await request(server)
            .post('/auth/register')
            .send({ email: `wc-a-${Date.now()}@test.com`, password: 'SecurePassword123!', name: 'WC A' })
            .expect(201);
        tokenA = regA.body.accessToken;
        userIdA = regA.body.user.id;
        orgA = (
            await request(server)
                .post('/orgs')
                .set('Authorization', `Bearer ${tokenA}`)
                .send({ name: 'WC Org A' })
                .expect(201)
        ).body.id;
        projectA = (
            await request(server)
                .post(`/orgs/${orgA}/projects`)
                .set('Authorization', `Bearer ${tokenA}`)
                .send({ name: 'WC Proj A' })
                .expect(201)
        ).body.id;
        versionA1 = (
            await request(server)
                .post(`/projects/${projectA}/versions`)
                .set('Authorization', `Bearer ${tokenA}`)
                .send({ circuitJson: rev('v1'), uiJson: {} })
                .expect(201)
        ).body.id;
        // A second project (same user) whose version is used to prove the cross-project baseVersion guard.
        projectOther = (
            await request(server)
                .post(`/orgs/${orgA}/projects`)
                .set('Authorization', `Bearer ${tokenA}`)
                .send({ name: 'WC Proj Other' })
                .expect(201)
        ).body.id;
        versionOther = (
            await request(server)
                .post(`/projects/${projectOther}/versions`)
                .set('Authorization', `Bearer ${tokenA}`)
                .send({ circuitJson: rev('other'), uiJson: {} })
                .expect(201)
        ).body.id;

        const regB = await request(server)
            .post('/auth/register')
            .send({ email: `wc-b-${Date.now()}@test.com`, password: 'SecurePassword123!', name: 'WC B' })
            .expect(201);
        tokenB = regB.body.accessToken;
        userIdB = regB.body.user.id;
        orgB = (
            await request(server)
                .post('/orgs')
                .set('Authorization', `Bearer ${tokenB}`)
                .send({ name: 'WC Org B' })
                .expect(201)
        ).body.id;
    });

    afterAll(async () => {
        const orgs = [orgA, orgB];
        const projects = [projectA, projectOther];
        await prisma.projectWorkingCopy.deleteMany({ where: { projectId: { in: projects } } }).catch(() => undefined);
        await prisma.projectVersion.deleteMany({ where: { projectId: { in: projects } } }).catch(() => undefined);
        await prisma.project.deleteMany({ where: { id: { in: projects } } }).catch(() => undefined);
        await prisma.orgMembership.deleteMany({ where: { orgId: { in: orgs } } }).catch(() => undefined);
        await prisma.organization.deleteMany({ where: { id: { in: orgs } } }).catch(() => undefined);
        await prisma.user.deleteMany({ where: { id: { in: [userIdA, userIdB] } } }).catch(() => undefined);
        await app.close();
    });

    it('GET before any autosave → 404 (open the latest version instead)', async () => {
        await wc(projectA, tokenA).expect(404);
    });

    it('PUT autosave creates the draft and it round-trips EXACTLY (the editor rehydrates from it)', async () => {
        const saved = await put(projectA, tokenA, {
            circuitJson: rev('c1'),
            uiJson: { zoom: 1.5 },
            baseVersionId: versionA1,
        }).expect(200);
        expect(saved.body).toMatchObject({ projectId: projectA, updatedByUserId: userIdA, baseVersionId: versionA1 });

        const got = await wc(projectA, tokenA).expect(200);
        expect(got.body.circuitJson).toEqual(rev('c1'));
        expect(got.body.uiJson).toEqual({ zoom: 1.5 });
        expect(got.body.baseVersionId).toBe(versionA1);
    });

    it('autosave OVERWRITES in place — last write wins, and there is still exactly ONE row (no growth/leak)', async () => {
        await put(projectA, tokenA, { circuitJson: rev('c2'), uiJson: {} }).expect(200);
        await put(projectA, tokenA, { circuitJson: rev('c3'), uiJson: {} }).expect(200);

        const got = await wc(projectA, tokenA).expect(200);
        expect(got.body.circuitJson).toEqual(rev('c3'));
        // Provenance is STICKY: the later PUTs omitted baseVersionId, so it stays what test 2 set (versionA1),
        // NOT reset to null — a circuit-only autosave must not wipe "descends from vX".
        expect(got.body.baseVersionId).toBe(versionA1);

        const rows = await prisma.projectWorkingCopy.count({ where: { projectId: projectA } });
        expect(rows).toBe(1);
    });

    describe('optimistic concurrency — opt-in, so the old contract is untouched', () => {
        /**
         * The draft is one row per project and the save was an unconditional upsert. That is right for a
         * single tab autosaving keystrokes, and it is silent DATA LOSS the moment two editors are open:
         * two tabs of the same user overwrite each other, the loser's work is gone, and nobody is told.
         *
         * Sending the `updatedAt` the client last saw turns that into a 409 carrying the CURRENT value, so
         * the client can reconcile. Omitting it keeps last-writer-wins exactly — proven by the test above,
         * which still passes unchanged.
         */
        it('a save whose expectedUpdatedAt matches is applied', async () => {
            const before = await wc(projectA, tokenA).expect(200);
            const res = await put(projectA, tokenA, {
                circuitJson: rev('cc-ok'),
                uiJson: {},
                expectedUpdatedAt: before.body.updatedAt,
            }).expect(200);
            expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThanOrEqual(
                new Date(before.body.updatedAt).getTime(),
            );
            const got = await wc(projectA, tokenA).expect(200);
            expect(got.body.circuitJson).toEqual(rev('cc-ok'));
        });

        it('a STALE expectedUpdatedAt is refused with 409, and the draft is NOT overwritten', async () => {
            const stale = await wc(projectA, tokenA).expect(200);
            // Someone else (or another tab) saves in between.
            await put(projectA, tokenA, { circuitJson: rev('cc-winner'), uiJson: {} }).expect(200);

            const res = await put(projectA, tokenA, {
                circuitJson: rev('cc-loser'),
                uiJson: {},
                expectedUpdatedAt: stale.body.updatedAt,
            }).expect(409);
            expect(res.body.code).toBe('WORKING_COPY_CONFLICT');
            // The response carries what is actually there, so the client can reconcile instead of guessing.
            expect(res.body.currentUpdatedAt).toBeTruthy();

            const got = await wc(projectA, tokenA).expect(200);
            expect(got.body.circuitJson).toEqual(rev('cc-winner')); // the loser did NOT clobber it
        });

        it('omitting expectedUpdatedAt keeps last-writer-wins — the old callers are unaffected', async () => {
            await put(projectA, tokenA, { circuitJson: rev('cc-a'), uiJson: {} }).expect(200);
            await put(projectA, tokenA, { circuitJson: rev('cc-b'), uiJson: {} }).expect(200);
            const got = await wc(projectA, tokenA).expect(200);
            expect(got.body.circuitJson).toEqual(rev('cc-b'));
        });

        it('a malformed expectedUpdatedAt is a 400, not a silent full overwrite', async () => {
            await put(projectA, tokenA, {
                circuitJson: rev('cc-bad'),
                uiJson: {},
                expectedUpdatedAt: 'yesterday',
            }).expect(400);
        });
    });

    it('autosaving NEVER creates a version — only explicit "Save version" does (no history flood)', async () => {
        const before = (await versions(projectA).expect(200)).body.total; // just versionA1 so far
        await put(projectA, tokenA, { circuitJson: rev('c4'), uiJson: {} }).expect(200);
        await put(projectA, tokenA, { circuitJson: rev('c5'), uiJson: {} }).expect(200);
        const afterAutosaves = (await versions(projectA).expect(200)).body.total;
        expect(afterAutosaves).toBe(before); // autosaves did NOT add versions

        // The explicit checkpoint (the "photo") is the only thing that grows history.
        await request(server)
            .post(`/projects/${projectA}/versions`)
            .set('Authorization', `Bearer ${tokenA}`)
            .send({ circuitJson: rev('c5'), uiJson: {} })
            .expect(201);
        const afterSave = (await versions(projectA).expect(200)).body.total;
        expect(afterSave).toBe(before + 1);
    });

    it("a draft cannot point at another project's version → 400", async () => {
        await put(projectA, tokenA, { circuitJson: rev('x'), uiJson: {}, baseVersionId: versionOther }).expect(400);
    });

    it('member authz: a non-member cannot read, write, or discard the draft → 403', async () => {
        await wc(projectA, tokenB).expect(403);
        await put(projectA, tokenB, { circuitJson: rev('hack'), uiJson: {} }).expect(403);
        await request(server)
            .delete(`/projects/${projectA}/working-copy`)
            .set('Authorization', `Bearer ${tokenB}`)
            .expect(403);
    });

    it("last-writer attribution: a second member's autosave flips updatedByUserId to them", async () => {
        // No member-management endpoint exists yet, so seed the membership directly (this must run AFTER the
        // non-member authz test above, which relies on B being an outsider).
        await prisma.orgMembership.create({ data: { orgId: orgA, userId: userIdB, role: 'MEMBER' } });
        const ack = await put(projectA, tokenB, { circuitJson: rev('by-b'), uiJson: {} }).expect(200);
        expect(ack.body.updatedByUserId).toBe(userIdB); // the draft now records B as the last writer, not A
        const got = await wc(projectA, tokenA).expect(200);
        expect(got.body.updatedByUserId).toBe(userIdB);
        expect(got.body.circuitJson).toEqual(rev('by-b'));
    });

    it('blob isolation: the project read + list paths never carry the circuit/UI blobs', async () => {
        const proj = await request(server)
            .get(`/projects/${projectA}`)
            .set('Authorization', `Bearer ${tokenA}`)
            .expect(200);
        expect(proj.body).not.toHaveProperty('circuitJson');
        expect(proj.body).not.toHaveProperty('workingCopy');
        const list = await request(server)
            .get(`/orgs/${orgA}/projects`)
            .set('Authorization', `Bearer ${tokenA}`)
            .expect(200);
        for (const p of list.body.items) {
            expect(p).not.toHaveProperty('circuitJson');
            expect(p).not.toHaveProperty('workingCopy');
        }
    });

    it('DELETE discards the draft (revert to last saved); idempotent', async () => {
        await request(server)
            .delete(`/projects/${projectA}/working-copy`)
            .set('Authorization', `Bearer ${tokenA}`)
            .expect(200);
        await wc(projectA, tokenA).expect(404);
        // no draft left, but discarding again is a no-op, not an error
        await request(server)
            .delete(`/projects/${projectA}/working-copy`)
            .set('Authorization', `Bearer ${tokenA}`)
            .expect(200);
    });
});
