/**
 * The synchronous design checks, against the real app.
 *
 * What makes these worth having is the alternative: before them, the only way to learn that a pin was
 * connected to nothing was to save a version, start a job, wait minutes and read a failure — or for the
 * client to answer from its own copy of the rules, which is a second authority and therefore a wrong one.
 *
 * So the properties under test are that the answer is the SAME one the design loop is judged against, that
 * it costs nothing, and that an unreadable body is refused rather than reported as a design verdict.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../src/prisma/prisma.service';

/** A sound divider: source, two resistors, a ground. Nothing for ERC to complain about. */
const SOUND = {
    version: '1.0',
    components: [
        {
            id: 'v1',
            type: 'voltage_source',
            designator: 'V1',
            value: 'DC 5',
            pins: [
                { pinId: '+', netId: 'vin' },
                { pinId: '-', netId: 'gnd' },
            ],
        },
        {
            id: 'r1',
            type: 'resistor',
            designator: 'R1',
            value: '1k',
            pins: [
                { pinId: '1', netId: 'vin' },
                { pinId: '2', netId: 'mid' },
            ],
        },
        {
            id: 'r2',
            type: 'resistor',
            designator: 'R2',
            value: '2k',
            pins: [
                { pinId: '1', netId: 'mid' },
                { pinId: '2', netId: 'gnd' },
            ],
        },
        { id: 'gnd1', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [
        { id: 'vin', name: 'VIN' },
        { id: 'mid', name: 'MID' },
        { id: 'gnd', name: 'GND', isGround: true },
    ],
};

/** The same divider with the ground removed — the classic error every ERC exists to catch. */
const NO_GROUND = {
    ...SOUND,
    components: SOUND.components.filter((c) => c.type !== 'ground'),
    nets: SOUND.nets.map((n) => (n.id === 'gnd' ? { id: 'gnd', name: 'GND' } : n)),
};

describe('POST /design-checks/erc', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let token: string;

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
        app.useGlobalFilters(new AllExceptionsFilter());
        await app.init();
        prisma = app.get(PrismaService);

        const reg = await request(app.getHttpServer())
            .post('/auth/register')
            .send({ email: `erc-${Date.now()}@example.test`, password: 'erc-check-pass-1', name: 'ERC' })
            .expect(201);
        token = (reg.body as { accessToken: string }).accessToken;
    }, 60_000);

    afterAll(async () => {
        await prisma.$disconnect();
        await app.close();
    });

    const erc = (circuit: unknown) =>
        request(app.getHttpServer())
            .post('/design-checks/erc')
            .set('Authorization', `Bearer ${token}`)
            .send({ circuit });

    it('answers a sound circuit with a pass, and the full verdict shape', async () => {
        const res = await erc(SOUND).expect(200);
        const body = res.body as {
            passed: boolean;
            issues: unknown[];
            summary: { errors: number; warnings: number; infos: number };
        };

        expect(body.passed).toBe(true);
        expect(body.summary.errors).toBe(0);
        // The WHOLE shape, not a subset — this endpoint's job is to hand back exactly what eda-core said, and
        // a field quietly missing here would be a second contract drifting from the first.
        expect(Object.keys(body).sort()).toEqual(['issues', 'passed', 'summary']);
        expect(Object.keys(body.summary).sort()).toEqual(['errors', 'infos', 'warnings']);
    });

    it('finds a real error and names what it is about', async () => {
        const res = await erc(NO_GROUND).expect(200);
        const body = res.body as {
            passed: boolean;
            issues: Array<{ code: string; severity: string; message: string; relatedIds: string[] }>;
            summary: { errors: number };
        };

        expect(body.passed).toBe(false);
        expect(body.summary.errors).toBeGreaterThan(0);
        // Each issue carries a machine code, a severity and the ids it concerns — everything an editor needs
        // to put the message next to the offending part rather than in a general banner.
        for (const issue of body.issues) {
            expect(typeof issue.code).toBe('string');
            expect(['error', 'warning', 'info']).toContain(issue.severity);
            expect(Array.isArray(issue.relatedIds)).toBe(true);
        }
    });

    it('REFUSES a body it cannot read, rather than reporting a verdict about it', async () => {
        // The failure this prevents is the worst kind: `passed: false, issues: []` for a malformed body reads
        // as a design verdict when it is a parse failure, and the user goes looking for a fault in a circuit
        // that was never examined.
        const res = await erc({ nope: true }).expect(400);
        expect(JSON.stringify((res.body as { message: string[] }).message)).toContain('circuit');
    });

    it('refuses a circuit whose parts are malformed, naming the field', async () => {
        const badDesignator = { ...SOUND, components: [{ ...SOUND.components[0], designator: 'not a designator' }] };
        const res = await erc(badDesignator).expect(400);
        expect(JSON.stringify((res.body as { message: string[] }).message)).toMatch(/designator/i);
    });

    it('needs no saved version, no project and no layout — it checks what is on screen', async () => {
        // The whole reason it takes a body. Requiring a saved version first would make the check useless
        // exactly when it matters: while the design is being written.
        await erc(SOUND).expect(200);
        const rows = await prisma.projectVersion.count();
        await erc(SOUND).expect(200);
        expect(await prisma.projectVersion.count()).toBe(rows); // nothing was persisted
    });

    it('requires a session — a check is still an authenticated operation', async () => {
        await request(app.getHttpServer()).post('/design-checks/erc').send({ circuit: SOUND }).expect(401);
    });

    describe('POST /design-checks/preflight', () => {
        const preflight = (circuit: unknown) =>
            request(app.getHttpServer())
                .post('/design-checks/preflight')
                .set('Authorization', `Bearer ${token}`)
                .send({ circuit });

        it('says what each part would become on a board', async () => {
            const res = await preflight(SOUND).expect(200);
            const body = res.body as {
                plans: Array<{ component: { id: string }; role: string; footprint?: unknown }>;
                diagnostics: Array<{ code: string; severity: string }>;
                completeness: string;
                layoutable: boolean;
            };

            expect(body.layoutable).toBe(true);
            // EVERY component gets a plan, including the ones that will not become copper — a ground marker
            // comes back as `net-only` rather than being left out. That is the more useful answer: an editor
            // can say "this is a net reference, not a part" instead of the user wondering where it went.
            expect(body.plans.map((p) => p.component.id).sort()).toEqual(['gnd1', 'r1', 'r2', 'v1']);
            expect(body.plans.find((p) => p.component.id === 'gnd1')?.role).toBe('net-only');
            for (const physical of ['r1', 'r2', 'v1']) {
                expect({ physical, role: body.plans.find((p) => p.component.id === physical)?.role }).not.toEqual({
                    physical,
                    role: 'excluded',
                });
            }
            expect(['full', 'partial']).toContain(body.completeness);
        });

        it('reports that pad accounting DID NOT RUN, rather than passing silently', async () => {
            // The endpoint deliberately runs without the footprint oracle — see preflight.md. The whole
            // value of that decision depends on the absence being VISIBLE: a board must never be declared
            // accounted-for by a check that never happened.
            const res = await preflight(SOUND).expect(200);
            const codes = (res.body as { diagnostics: Array<{ code: string }> }).diagnostics.map((d) => d.code);
            expect(codes).toContain('PCB006');
        });

        it('names a part it cannot place, which is the question this endpoint exists to answer fast', async () => {
            // Before this route, learning "this part has no physical mapping" cost a multi-minute layout job
            // and a quota unit. A `switch` in our vocabulary is the 4-pin voltage-controlled SPICE device,
            // which has no defensible v1 footprint.
            const unplaceable = {
                ...SOUND,
                components: [
                    ...SOUND.components,
                    {
                        id: 's1',
                        type: 'switch',
                        designator: 'S1',
                        pins: [
                            { pinId: '+', netId: 'vin' },
                            { pinId: '-', netId: 'gnd' },
                            { pinId: 'c+', netId: 'vin' },
                            { pinId: 'c-', netId: 'gnd' },
                        ],
                    },
                ],
            };
            const res = await preflight(unplaceable).expect(200);
            const body = res.body as {
                plans: Array<{ component: { id: string }; role: string }>;
                diagnostics: Array<{ code: string; message: string }>;
            };

            // It is reported, not silently dropped — the difference between "excluded" and "absent".
            const excluded = body.plans.find((p) => p.component.id === 's1');
            expect(excluded?.role).toBe('excluded');
            expect(JSON.stringify(body.diagnostics)).toMatch(/S1/);
        });

        it('refuses a body it cannot read, same as ERC', async () => {
            await preflight({ nope: true }).expect(400);
        });

        it('persists nothing and needs no project', async () => {
            const jobs = await prisma.layoutJob.count();
            await preflight(SOUND).expect(200);
            expect(await prisma.layoutJob.count()).toBe(jobs);
        });

        it('requires a session', async () => {
            await request(app.getHttpServer()).post('/design-checks/preflight').send({ circuit: SOUND }).expect(401);
        });
    });

    it('rejects an unknown field rather than ignoring it', async () => {
        await request(app.getHttpServer())
            .post('/design-checks/erc')
            .set('Authorization', `Bearer ${token}`)
            .send({ circuit: SOUND, sneaky: 1 })
            .expect(400);
    });
});
