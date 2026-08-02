/**
 * Four defects an editor would have walked straight into. All four were reproduced against the running API
 * before being fixed; these run against a real database so they cannot drift back in unnoticed.
 *
 * They share a shape worth naming: each was a place where the API knew the right answer somewhere and told
 * the client something else. A quota the enforcer applies and the report denies. A rejection the server
 * understands and reports as its own failure. A guard on the write and none on the erase. A validator on the
 * throwaway draft and none on the permanent record.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../src/prisma/prisma.service';

const CIRCUIT = { version: '1.0', components: [], nets: [] };

describe('the API an editor leans on', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let token: string;
    let orgId: string;
    let projectId: string;

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
        app.useGlobalFilters(new AllExceptionsFilter());
        await app.init();
        prisma = app.get(PrismaService);

        const email = `editor-safety-${Date.now()}@example.test`;
        const reg = await request(app.getHttpServer())
            .post('/auth/register')
            .send({ email, password: 'editor-safety-pass-1', name: 'Editor Safety' })
            .expect(201);
        token = (reg.body as { accessToken: string }).accessToken;

        const orgs = await request(app.getHttpServer()).get('/orgs').set('Authorization', `Bearer ${token}`);
        orgId = (orgs.body as Array<{ id: string }>)[0]!.id;

        const project = await request(app.getHttpServer())
            .post(`/orgs/${orgId}/projects`)
            .set('Authorization', `Bearer ${token}`)
            .send({ name: `editor-safety-${Date.now()}` })
            .expect(201);
        projectId = (project.body as { id: string }).id;
    }, 60_000);

    afterAll(async () => {
        await prisma.$disconnect();
        await app.close();
    });

    const auth = () => request(app.getHttpServer());

    it('reports the layout concurrency limit the enforcer actually applies', async () => {
        // It reported `null` — unlimited — while refusing the third job with "2 of 2 used this period",
        // because the report read the raw env value and the enforcer read the accessor that supplies the
        // default. A client shown one number and judged against another cannot be right.
        const res = await auth().get(`/orgs/${orgId}/usage`).set('Authorization', `Bearer ${token}`).expect(200);
        const body = res.body as { layout: { limits: { concurrent: number | null } } };
        expect(body.layout.limits.concurrent).toBe(2);
    });

    it('refuses a non-circuit on the PERMANENT record, not just the draft', async () => {
        // A version has no DELETE route, so `{"nope": true}` accepted here stayed forever — while the
        // throwaway draft beside it rejected the same body. The weakest validation was on the strongest
        // record.
        const res = await auth()
            .post(`/projects/${projectId}/versions`)
            .set('Authorization', `Bearer ${token}`)
            .send({ circuitJson: { nope: true }, uiJson: {} })
            .expect(400);
        expect(JSON.stringify((res.body as { message: string[] }).message)).toContain('components');
    });

    it('still accepts a real circuit as a version', async () => {
        await auth()
            .post(`/projects/${projectId}/versions`)
            .set('Authorization', `Bearer ${token}`)
            .send({ circuitJson: CIRCUIT, uiJson: {} })
            .expect(201);
    });

    describe('discarding a draft honours the same concurrency token as saving one', () => {
        it('refuses a STALE discard and leaves the draft intact', async () => {
            // DELETE was an unconditional deleteMany while PUT had a real compare-and-set, so "revert to last
            // saved" from a second tab silently destroyed a draft the first tab was still typing into — the
            // exact loss the PUT guard exists to prevent, through the one door that erases everything.
            await auth()
                .put(`/projects/${projectId}/working-copy`)
                .set('Authorization', `Bearer ${token}`)
                .send({ circuitJson: CIRCUIT, uiJson: {} })
                .expect(200);

            const loaded = await auth()
                .get(`/projects/${projectId}/working-copy`)
                .set('Authorization', `Bearer ${token}`)
                .expect(200);
            const stale = (loaded.body as { updatedAt: string }).updatedAt;

            // Someone else saves.
            await auth()
                .put(`/projects/${projectId}/working-copy`)
                .set('Authorization', `Bearer ${token}`)
                .send({ circuitJson: CIRCUIT, uiJson: { viewport: { x: 1, y: 0, zoom: 1 } } })
                .expect(200);

            const refused = await auth()
                .delete(`/projects/${projectId}/working-copy`)
                .query({ expectedUpdatedAt: stale })
                .set('Authorization', `Bearer ${token}`)
                .expect(409);
            expect((refused.body as { code: string }).code).toBe('WORKING_COPY_CONFLICT');

            // The whole point: the work is still there.
            const survived = await auth()
                .get(`/projects/${projectId}/working-copy`)
                .set('Authorization', `Bearer ${token}`)
                .expect(200);
            expect((survived.body as { uiJson: { viewport?: { x: number } } }).uiJson.viewport?.x).toBe(1);
        });

        it('allows a CURRENT discard, and stays idempotent without a token', async () => {
            const loaded = await auth()
                .get(`/projects/${projectId}/working-copy`)
                .set('Authorization', `Bearer ${token}`)
                .expect(200);

            await auth()
                .delete(`/projects/${projectId}/working-copy`)
                .query({ expectedUpdatedAt: (loaded.body as { updatedAt: string }).updatedAt })
                .set('Authorization', `Bearer ${token}`)
                .expect(200);

            // Discarding nothing is the goal state, not a conflict — the contract says idempotent.
            await auth()
                .delete(`/projects/${projectId}/working-copy`)
                .query({ expectedUpdatedAt: new Date().toISOString() })
                .set('Authorization', `Bearer ${token}`)
                .expect(200);

            // And the unguarded form still works, so no existing caller changed.
            await auth()
                .delete(`/projects/${projectId}/working-copy`)
                .set('Authorization', `Bearer ${token}`)
                .expect(200);
        });
    });

    it('answers an oversized body with 413, not an internal error', async () => {
        // body-parser rejects with a plain Error carrying `status`, not an HttpException, so the filter
        // classified it as a server fault: an editor autosaving a large design was told the server had
        // broken, with nothing to act on, forever.
        const res = await auth()
            .put(`/projects/${projectId}/working-copy`)
            .set('Authorization', `Bearer ${token}`)
            .send({ circuitJson: { ...CIRCUIT, blob: 'x'.repeat(2 * 1024 * 1024) }, uiJson: {} })
            .expect(413);
        expect((res.body as { code: string }).code).toBe('PAYLOAD_TOO_LARGE');
        expect((res.body as { message: string }).message).toMatch(/too large/i);
    }, 30_000);
});
