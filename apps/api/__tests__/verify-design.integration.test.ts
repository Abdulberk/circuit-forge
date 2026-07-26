/**
 * verify-design integration — proves the INCONCLUSIVE verdict end-to-end (the tier the other specs
 * don't cover): a real enqueue with NOTHING draining the queue must NOT become a design 'fail'. This is
 * the founding-rule guarantee — an infra/no-verdict condition (worker down / no consumer / backlog) is
 * never reported to the user as "your design failed".
 *
 * Boots the real AppModule (real Prisma on circuitforge_test, real BullMQ) but ISOLATES Redis to a
 * logical DB (/15) that no worker listens on, so the job stays QUEUED and the server-side poll
 * deterministically returns POLL_TIMEOUT → verdict 'inconclusive'. VERIFY_POLL_TIMEOUT_MS is shortened
 * so the test is fast and never races a worker. The ERC-fail case runs API-side (no worker needed).
 *
 * The PASS verdict over HTTP needs the real worker draining + a real ngspice — covered by
 * verify-design-live.spec.ts (inline + real ngspice) and verification.service.spec.ts (mocked worker);
 * not repeated here. Requires the local Postgres/Redis the other integration tests use.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('verify-design integration (infra → inconclusive, never a design fail)', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let accessToken: string;
    let orgId: string;
    let prevRedis: string | undefined;
    let prevPoll: string | undefined;

    const testUser = {
        email: 'verifyinfra@test-verify.com',
        password: 'SecurePassword123!',
        name: 'Verify Infra Test',
    };

    // 10V / 1k / 1k divider — a perfectly sound design (out = 5V, ground present, ERC-clean).
    const DIVIDER = {
        version: '1.0',
        components: [
            {
                id: 'v1',
                type: 'voltage_source',
                designator: 'V1',
                value: 'DC 10',
                pins: [
                    { pinId: '+', netId: 'in' },
                    { pinId: '-', netId: 'gnd' },
                ],
            },
            {
                id: 'r1',
                type: 'resistor',
                designator: 'R1',
                value: '1k',
                pins: [
                    { pinId: '1', netId: 'in' },
                    { pinId: '2', netId: 'out' },
                ],
            },
            {
                id: 'r2',
                type: 'resistor',
                designator: 'R2',
                value: '1k',
                pins: [
                    { pinId: '1', netId: 'out' },
                    { pinId: '2', netId: 'gnd' },
                ],
            },
            { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
        ],
        nets: [
            { id: 'in', name: 'in' },
            { id: 'out', name: 'out' },
            { id: 'gnd', name: 'gnd', isGround: true },
        ],
    };

    // Same circuit minus a ground net → a deterministic ERC error (no DC path to ground).
    const NO_GROUND = {
        version: '1.0',
        components: [
            {
                id: 'v1',
                type: 'voltage_source',
                designator: 'V1',
                value: 'DC 5',
                pins: [
                    { pinId: '+', netId: 'a' },
                    { pinId: '-', netId: 'b' },
                ],
            },
            {
                id: 'r1',
                type: 'resistor',
                designator: 'R1',
                value: '1k',
                pins: [
                    { pinId: '1', netId: 'a' },
                    { pinId: '2', netId: 'b' },
                ],
            },
        ],
        nets: [
            { id: 'a', name: 'a' },
            { id: 'b', name: 'b' },
        ],
    };

    beforeAll(async () => {
        // Isolate Redis to a logical DB no worker drains → the enqueued job is provably un-consumed, so the
        // server-side poll returns POLL_TIMEOUT deterministically (not a flaky race with a real worker).
        // Shorten the poll budget so it resolves in ~2s. Both are read at module init / service
        // construction, so they MUST be set before compile().
        prevRedis = process.env.REDIS_URL;
        prevPoll = process.env.VERIFY_POLL_TIMEOUT_MS;
        process.env.REDIS_URL = 'redis://localhost:6379/15';
        process.env.VERIFY_POLL_TIMEOUT_MS = '1500';

        const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
        await app.init();
        prisma = app.get(PrismaService);

        const reg = await request(app.getHttpServer()).post('/auth/register').send(testUser);
        accessToken = reg.body.accessToken;
        const org = await request(app.getHttpServer())
            .post('/orgs')
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ name: 'Verify Infra Org' });
        orgId = org.body.id;
    });

    afterAll(async () => {
        if (orgId) {
            await prisma.simulationJob.deleteMany({ where: { orgId } });
            await prisma.orgMembership.deleteMany({ where: { orgId } });
            await prisma.organization.deleteMany({ where: { id: orgId } });
        }
        await prisma.user.deleteMany({ where: { email: testUser.email } });
        await app.close();
        // Restore env (each jest file is isolated, but keep it tidy).
        if (prevRedis === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = prevRedis;
        if (prevPoll === undefined) delete process.env.VERIFY_POLL_TIMEOUT_MS;
        else process.env.VERIFY_POLL_TIMEOUT_MS = prevPoll;
    });

    it('INCONCLUSIVE: a sound design whose job nothing consumes is NOT reported as a design fail', async () => {
        const res = await request(app.getHttpServer())
            .post('/verify-design')
            .set('Authorization', `Bearer ${accessToken}`)
            .send({
                circuit: DIVIDER,
                analysisConfig: { type: 'op' },
                assertions: [{ probe: 'out', metric: 'final', op: 'approx', value: 5, tol: 0.1 }],
            })
            .expect(201);

        expect(res.body.verdict).toBe('inconclusive'); // NOT 'fail' — the design is sound, the sim just couldn't run
        expect(res.body.simStatus).toBe('skipped');
        expect(res.body.runError).toMatch(/did not start|no worker|backlog/i);
        expect(res.body.assertions[0].pass).toBe(false); // can't certify an unmeasured spec
    });

    it('FAIL: a genuine ERC error (no ground) is a real design fail — caught API-side, no worker needed', async () => {
        const res = await request(app.getHttpServer())
            .post('/verify-design')
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ circuit: NO_GROUND, analysisConfig: { type: 'op' }, assertions: [] })
            .expect(201);

        expect(res.body.verdict).toBe('fail'); // a deterministic design fault, independent of the sim infra
        expect(res.body.erc.errors.length).toBeGreaterThan(0);
    });
});
