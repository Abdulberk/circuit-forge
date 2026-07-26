/**
 * Simulation Integration Tests
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Simulation Integration Tests', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let accessToken: string;
    let orgId: string;
    let projectId: string;
    let versionId: string;

    const testUser = {
        email: 'simtest@test-sim.com',
        password: 'SecurePassword123!',
        name: 'Simulation Test User',
    };

    // A valid voltage-divider in the current CircuitJson shape: pins are an ARRAY of {pinId, netId},
    // every component has a designator, and pins reference net IDs (the ground net carries isGround).
    const simpleCircuit = {
        version: '1.0',
        components: [
            {
                id: 'V1',
                type: 'voltage_source',
                designator: 'V1',
                value: 'DC 5',
                pins: [
                    { pinId: '+', netId: 'vcc' },
                    { pinId: '-', netId: '0' },
                ],
            },
            {
                id: 'R1',
                type: 'resistor',
                designator: 'R1',
                value: '1k',
                pins: [
                    { pinId: '1', netId: 'vcc' },
                    { pinId: '2', netId: 'out' },
                ],
            },
            {
                id: 'R2',
                type: 'resistor',
                designator: 'R2',
                value: '1k',
                pins: [
                    { pinId: '1', netId: 'out' },
                    { pinId: '2', netId: '0' },
                ],
            },
        ],
        nets: [
            { id: 'vcc', name: 'vcc' },
            { id: 'out', name: 'out' },
            { id: '0', name: '0', isGround: true },
        ],
    };

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
        await app.init();

        prisma = app.get(PrismaService);

        // Register and login
        const authResponse = await request(app.getHttpServer())
            .post('/auth/register')
            .send(testUser);
        accessToken = authResponse.body.accessToken;

        // Create org
        const orgResponse = await request(app.getHttpServer())
            .post('/orgs')
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ name: 'Sim Test Org' });
        orgId = orgResponse.body.id;

        // Create project
        const projectResponse = await request(app.getHttpServer())
            .post(`/orgs/${orgId}/projects`)
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ name: 'Test Circuit', description: 'A test circuit' });
        projectId = projectResponse.body.id;

        // Create version
        const versionResponse = await request(app.getHttpServer())
            .post(`/projects/${projectId}/versions`)
            .set('Authorization', `Bearer ${accessToken}`)
            .send({
                circuitJson: simpleCircuit,
                uiJson: { layout: 'grid' },
            });
        versionId = versionResponse.body.id;
    });

    afterAll(async () => {
        // Clean up
        await prisma.simulationJob.deleteMany({
            where: { orgId },
        });
        await prisma.projectVersion.deleteMany({
            where: { project: { orgId } },
        });
        await prisma.project.deleteMany({
            where: { orgId },
        });
        await prisma.orgMembership.deleteMany({
            where: { orgId },
        });
        await prisma.organization.deleteMany({
            where: { id: orgId },
        });
        await prisma.user.deleteMany({
            where: { email: testUser.email },
        });
        await app.close();
    });

    describe('POST /versions/:versionId/simulations', () => {
        it('should queue a simulation job', async () => {
            const response = await request(app.getHttpServer())
                .post(`/versions/${versionId}/simulations`)
                .set('Authorization', `Bearer ${accessToken}`)
                .send({
                    analysisConfig: {
                        type: 'op',
                    },
                    probes: ['out'],
                })
                .expect(201);

            expect(response.body).toHaveProperty('jobId');
            expect(response.body.jobId).toBeDefined();
        });

        it('should queue transient simulation', async () => {
            const response = await request(app.getHttpServer())
                .post(`/versions/${versionId}/simulations`)
                .set('Authorization', `Bearer ${accessToken}`)
                .send({
                    analysisConfig: {
                        type: 'tran',
                        stepTime: '1u',
                        stopTime: '10m',
                    },
                    probes: ['out', 'vcc'],
                })
                .expect(201);

            expect(response.body).toHaveProperty('jobId');
        });

        it('should reject simulation without auth', async () => {
            await request(app.getHttpServer())
                .post(`/versions/${versionId}/simulations`)
                .send({
                    analysisConfig: { type: 'op' },
                })
                .expect(401);
        });

        it('should reject invalid analysis config', async () => {
            await request(app.getHttpServer())
                .post(`/versions/${versionId}/simulations`)
                .set('Authorization', `Bearer ${accessToken}`)
                .send({
                    analysisConfig: {
                        type: 'invalid_type',
                    },
                })
                .expect(400);
        });
    });

    describe('GET /simulations/:jobId', () => {
        let jobId: string;

        beforeAll(async () => {
            const response = await request(app.getHttpServer())
                .post(`/versions/${versionId}/simulations`)
                .set('Authorization', `Bearer ${accessToken}`)
                .send({
                    analysisConfig: { type: 'op' },
                });
            jobId = response.body.jobId;
        });

        it('should get simulation status', async () => {
            const response = await request(app.getHttpServer())
                .get(`/simulations/${jobId}`)
                .set('Authorization', `Bearer ${accessToken}`)
                .expect(200);

            expect(response.body).toHaveProperty('id', jobId);
            expect(response.body).toHaveProperty('status');
            expect(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']).toContain(response.body.status);
        });

        it('should reject status check without auth', async () => {
            await request(app.getHttpServer())
                .get(`/simulations/${jobId}`)
                .expect(401);
        });

        it('should return 404 for non-existent job', async () => {
            await request(app.getHttpServer())
                .get('/simulations/00000000-0000-0000-0000-000000000000')
                .set('Authorization', `Bearer ${accessToken}`)
                .expect(404);
        });
    });

    describe('POST /simulations/quick', () => {
        it('should run quick simulation with raw netlist', async () => {
            const netlist = `* Quick Test
V1 vcc 0 DC 5
R1 vcc out 1k
R2 out 0 1k
.op
.end`;

            const response = await request(app.getHttpServer())
                .post('/simulations/quick')
                .set('Authorization', `Bearer ${accessToken}`)
                .send({
                    netlist,
                    analysisConfig: { type: 'op' },
                })
                .expect(201);

            expect(response.body).toHaveProperty('jobId');
        });

        it('should reject quick simulation without netlist', async () => {
            await request(app.getHttpServer())
                .post('/simulations/quick')
                .set('Authorization', `Bearer ${accessToken}`)
                .send({
                    analysisConfig: { type: 'op' },
                })
                .expect(400);
        });
    });
});