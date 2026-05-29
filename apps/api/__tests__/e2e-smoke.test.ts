/**
 * E2E Smoke Test
 * Full workflow: register -> login -> create org -> create project -> save version -> simulate -> poll -> get result
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('E2E Smoke Test - Full Simulation Workflow', () => {
    let app: INestApplication;
    let prisma: PrismaService;

    // Test data - will be populated during test
    let accessToken: string;
    let refreshToken: string;
    let userId: string;
    let orgId: string;
    let projectId: string;
    let versionId: string;
    let jobId: string;

    const testUser = {
        email: `smoke-test-${Date.now()}@test.com`,
        password: 'SecurePassword123!',
        name: 'Smoke Test User',
    };

    const rcFilterCircuit = {
        version: '1.0',
        components: [
            {
                id: 'V1',
                type: 'voltage_source',
                value: 'SIN(0 1 1k)',
                pins: { positive: 'in', negative: '0' },
            },
            {
                id: 'R1',
                type: 'resistor',
                value: '1k',
                pins: { '1': 'in', '2': 'out' },
            },
            {
                id: 'C1',
                type: 'capacitor',
                value: '100n',
                pins: { '1': 'out', '2': '0' },
            },
        ],
        nets: [
            { id: 'n1', name: 'in' },
            { id: 'n2', name: 'out' },
            { id: 'n3', name: '0' },
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
    });

    afterAll(async () => {
        // Cleanup in reverse order of creation
        if (jobId) {
            await prisma.simulationJob.deleteMany({ where: { id: jobId } }).catch(() => { });
        }
        if (versionId) {
            await prisma.projectVersion.deleteMany({ where: { id: versionId } }).catch(() => { });
        }
        if (projectId) {
            await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => { });
        }
        if (orgId) {
            await prisma.orgMembership.deleteMany({ where: { orgId } }).catch(() => { });
            await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => { });
        }
        if (userId) {
            await prisma.user.deleteMany({ where: { id: userId } }).catch(() => { });
        }
        await app.close();
    });

    describe('Step 1: User Registration', () => {
        it('should register a new user', async () => {
            const response = await request(app.getHttpServer())
                .post('/auth/register')
                .send(testUser)
                .expect(201);

            expect(response.body).toHaveProperty('accessToken');
            expect(response.body).toHaveProperty('refreshToken');
            expect(response.body).toHaveProperty('user');

            accessToken = response.body.accessToken;
            refreshToken = response.body.refreshToken;
            userId = response.body.user.id;

            console.log('✓ User registered:', response.body.user.email);
        });
    });

    describe('Step 2: Token Refresh', () => {
        it('should refresh the access token', async () => {
            const response = await request(app.getHttpServer())
                .post('/auth/refresh')
                .send({ refreshToken })
                .expect(200);

            expect(response.body).toHaveProperty('accessToken');
            accessToken = response.body.accessToken;

            console.log('✓ Token refreshed');
        });
    });

    describe('Step 3: Create Organization', () => {
        it('should create a new organization', async () => {
            const response = await request(app.getHttpServer())
                .post('/orgs')
                .set('Authorization', `Bearer ${accessToken}`)
                .send({ name: 'Smoke Test Organization' })
                .expect(201);

            expect(response.body).toHaveProperty('id');
            expect(response.body.name).toBe('Smoke Test Organization');

            orgId = response.body.id;

            console.log('✓ Organization created:', orgId);
        });
    });

    describe('Step 4: Create Project', () => {
        it('should create a new project in the organization', async () => {
            const response = await request(app.getHttpServer())
                .post(`/orgs/${orgId}/projects`)
                .set('Authorization', `Bearer ${accessToken}`)
                .send({
                    name: 'RC Low-Pass Filter',
                    description: 'A simple RC low-pass filter for testing',
                })
                .expect(201);

            expect(response.body).toHaveProperty('id');
            expect(response.body.name).toBe('RC Low-Pass Filter');

            projectId = response.body.id;

            console.log('✓ Project created:', projectId);
        });
    });

    describe('Step 5: Save Circuit Version', () => {
        it('should save a new version with circuit JSON', async () => {
            const response = await request(app.getHttpServer())
                .post(`/projects/${projectId}/versions`)
                .set('Authorization', `Bearer ${accessToken}`)
                .send({
                    circuitJson: rcFilterCircuit,
                    uiJson: {
                        layout: 'hierarchical',
                        positions: {
                            V1: { x: 100, y: 100 },
                            R1: { x: 200, y: 100 },
                            C1: { x: 300, y: 100 },
                        },
                    },
                })
                .expect(201);

            expect(response.body).toHaveProperty('id');
            expect(response.body).toHaveProperty('versionNumber', 1);

            versionId = response.body.id;

            console.log('✓ Version saved:', versionId, '(v1)');
        });
    });

    describe('Step 6: List Versions', () => {
        it('should list all versions for the project', async () => {
            const response = await request(app.getHttpServer())
                .get(`/projects/${projectId}/versions`)
                .set('Authorization', `Bearer ${accessToken}`)
                .expect(200);

            expect(Array.isArray(response.body)).toBe(true);
            expect(response.body.length).toBeGreaterThanOrEqual(1);
            expect(response.body[0]).toHaveProperty('versionNumber', 1);

            console.log('✓ Versions listed:', response.body.length, 'version(s)');
        });
    });

    describe('Step 7: Run Simulation', () => {
        it('should queue a transient simulation job', async () => {
            const response = await request(app.getHttpServer())
                .post(`/versions/${versionId}/simulations`)
                .set('Authorization', `Bearer ${accessToken}`)
                .send({
                    analysisConfig: {
                        type: 'tran',
                        tstep: '10u',
                        tstop: '5m',
                    },
                    probes: ['in', 'out'],
                })
                .expect(201);

            expect(response.body).toHaveProperty('jobId');

            jobId = response.body.jobId;

            console.log('✓ Simulation queued:', jobId);
        });
    });

    describe('Step 8: Poll Simulation Status', () => {
        it('should get simulation status', async () => {
            const response = await request(app.getHttpServer())
                .get(`/simulations/${jobId}`)
                .set('Authorization', `Bearer ${accessToken}`)
                .expect(200);

            expect(response.body).toHaveProperty('id', jobId);
            expect(response.body).toHaveProperty('status');
            expect(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT']).toContain(response.body.status);

            console.log('✓ Simulation status:', response.body.status);
        });
    });

    describe('Step 9: Health Check', () => {
        it('should return healthy status', async () => {
            const response = await request(app.getHttpServer())
                .get('/health')
                .expect(200);

            expect(response.body).toHaveProperty('status', 'ok');

            console.log('✓ Health check passed');
        });

        it('should return readiness with dependency status', async () => {
            const response = await request(app.getHttpServer())
                .get('/health/ready')
                .expect(200);

            expect(response.body).toHaveProperty('status');
            expect(response.body).toHaveProperty('checks');
            expect(response.body.checks).toHaveProperty('database');

            console.log('✓ Readiness check passed, database:', response.body.checks.database.status);
        });
    });

    describe('Summary', () => {
        it('should have completed all steps successfully', () => {
            expect(userId).toBeDefined();
            expect(orgId).toBeDefined();
            expect(projectId).toBeDefined();
            expect(versionId).toBeDefined();
            expect(jobId).toBeDefined();

            console.log('\n========================================');
            console.log('E2E Smoke Test Summary');
            console.log('========================================');
            console.log('User ID:', userId);
            console.log('Organization ID:', orgId);
            console.log('Project ID:', projectId);
            console.log('Version ID:', versionId);
            console.log('Simulation Job ID:', jobId);
            console.log('========================================\n');
        });
    });
});