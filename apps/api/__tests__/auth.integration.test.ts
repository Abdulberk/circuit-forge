/**
 * Auth Integration Tests
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Auth Integration Tests', () => {
    let app: INestApplication;
    let prisma: PrismaService;

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
        // Clean up test data
        await prisma.user.deleteMany({
            where: { email: { contains: '@test-auth.com' } },
        });
        await app.close();
    });

    describe('POST /auth/register', () => {
        const testUser = {
            email: 'newuser@test-auth.com',
            password: 'SecurePassword123!',
            name: 'Test User',
        };

        afterEach(async () => {
            await prisma.user.deleteMany({
                where: { email: testUser.email },
            });
        });

        it('should register a new user successfully', async () => {
            const response = await request(app.getHttpServer())
                .post('/auth/register')
                .send(testUser)
                .expect(201);

            expect(response.body).toHaveProperty('accessToken');
            expect(response.body).toHaveProperty('refreshToken');
            expect(response.body).toHaveProperty('user');
            expect(response.body.user.email).toBe(testUser.email);
            expect(response.body.user.name).toBe(testUser.name);
            expect(response.body.user).not.toHaveProperty('passwordHash');
        });

        it('should reject duplicate email', async () => {
            // First registration
            await request(app.getHttpServer())
                .post('/auth/register')
                .send(testUser)
                .expect(201);

            // Duplicate registration
            await request(app.getHttpServer())
                .post('/auth/register')
                .send(testUser)
                .expect(409);
        });

        it('should reject invalid email format', async () => {
            await request(app.getHttpServer())
                .post('/auth/register')
                .send({ ...testUser, email: 'invalid-email' })
                .expect(400);
        });

        it('should reject weak password', async () => {
            await request(app.getHttpServer())
                .post('/auth/register')
                .send({ ...testUser, password: '123' })
                .expect(400);
        });

        it('should reject missing required fields', async () => {
            await request(app.getHttpServer())
                .post('/auth/register')
                .send({ email: testUser.email })
                .expect(400);
        });
    });

    describe('POST /auth/login', () => {
        const testUser = {
            email: 'logintest@test-auth.com',
            password: 'SecurePassword123!',
            name: 'Login Test User',
        };

        beforeAll(async () => {
            await request(app.getHttpServer())
                .post('/auth/register')
                .send(testUser);
        });

        afterAll(async () => {
            await prisma.user.deleteMany({
                where: { email: testUser.email },
            });
        });

        it('should login with valid credentials', async () => {
            const response = await request(app.getHttpServer())
                .post('/auth/login')
                .send({
                    email: testUser.email,
                    password: testUser.password,
                })
                .expect(200);

            expect(response.body).toHaveProperty('accessToken');
            expect(response.body).toHaveProperty('refreshToken');
            expect(response.body).toHaveProperty('user');
        });

        it('should reject invalid password', async () => {
            await request(app.getHttpServer())
                .post('/auth/login')
                .send({
                    email: testUser.email,
                    password: 'wrongpassword',
                })
                .expect(401);
        });

        it('should reject non-existent user', async () => {
            await request(app.getHttpServer())
                .post('/auth/login')
                .send({
                    email: 'nonexistent@test-auth.com',
                    password: testUser.password,
                })
                .expect(401);
        });
    });

    describe('POST /auth/refresh', () => {
        let refreshToken: string;
        const testUser = {
            email: 'refreshtest@test-auth.com',
            password: 'SecurePassword123!',
            name: 'Refresh Test User',
        };

        beforeAll(async () => {
            const response = await request(app.getHttpServer())
                .post('/auth/register')
                .send(testUser);
            refreshToken = response.body.refreshToken;
        });

        afterAll(async () => {
            await prisma.user.deleteMany({
                where: { email: testUser.email },
            });
        });

        it('should refresh tokens with valid refresh token', async () => {
            const response = await request(app.getHttpServer())
                .post('/auth/refresh')
                .send({ refreshToken })
                .expect(200);

            expect(response.body).toHaveProperty('accessToken');
            expect(response.body).toHaveProperty('refreshToken');
        });

        it('should reject invalid refresh token', async () => {
            await request(app.getHttpServer())
                .post('/auth/refresh')
                .send({ refreshToken: 'invalid-token' })
                .expect(401);
        });
    });

    describe('Protected Routes', () => {
        let accessToken: string;
        const testUser = {
            email: 'protected@test-auth.com',
            password: 'SecurePassword123!',
            name: 'Protected Test User',
        };

        beforeAll(async () => {
            const response = await request(app.getHttpServer())
                .post('/auth/register')
                .send(testUser);
            accessToken = response.body.accessToken;
        });

        afterAll(async () => {
            await prisma.user.deleteMany({
                where: { email: testUser.email },
            });
        });

        it('should allow access with valid token', async () => {
            await request(app.getHttpServer())
                .get('/orgs')
                .set('Authorization', `Bearer ${accessToken}`)
                .expect(200);
        });

        it('should reject access without token', async () => {
            await request(app.getHttpServer())
                .get('/orgs')
                .expect(401);
        });

        it('should reject access with invalid token', async () => {
            await request(app.getHttpServer())
                .get('/orgs')
                .set('Authorization', 'Bearer invalid-token')
                .expect(401);
        });
    });
});