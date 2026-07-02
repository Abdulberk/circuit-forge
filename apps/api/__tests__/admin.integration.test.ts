/**
 * Platform Admin API e2e — real app, real Postgres + Redis, NO mocks.
 *
 * Proves the whole admin surface end to end:
 *  - AUTHZ: /admin/* is 401 without a token, 403 for a NONE user, and enforces the graduated ladder
 *    (SUPPORT reads but can't mutate; OPERATOR mutates but can't change roles; ADMIN can).
 *  - LIVE ROLE: the guard reads platformRole from the DB every request, so a promote/demote takes effect
 *    on the SAME token with no re-login.
 *  - REAL EFFECT (before→after): suspending an org actually blocks that org's next write (403 ORG_SUSPENDED),
 *    and reinstating restores it; a per-org quota override is stored and reflected in effective limits.
 *  - LIFECYCLE: locking a user revokes its live sessions; the last-owner guard blocks orphaning an org.
 *  - AUDIT: every mutation writes an admin.* AuditLog row with adminActorId + before/after + requestId.
 *
 * Requires Postgres + Redis up (like e2e-smoke / authz-isolation) and the test DB migrated.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

const DUMMY_NETLIST = '* admin-e2e\nV1 in 0 DC 5\nR1 in 0 1k\n.op\n.end\n';

describe('Platform Admin API (e2e, real stack)', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let server: import('http').Server;

    const stamp = Date.now();
    const mk = (tag: string) => ({ email: `admin-e2e-${tag}-${stamp}@test.com`, password: 'SecurePassword123!', name: tag });

    // actors + targets
    let adminTok = '', opTok = '', supTok = '', tenantTok = '';
    let adminId = '', opId = '', supId = '', tenantId = '', lockId = '', roleId = '';
    let roleTok = '';
    let tenantOrg = '';
    const createdUserIds: string[] = [];

    const register = async (tag: string) => {
        const res = await request(server).post('/auth/register').send(mk(tag)).expect(201);
        const id = res.body.user.id as string;
        createdUserIds.push(id);
        return { token: res.body.accessToken as string, userId: id };
    };
    const get = (path: string, token: string) => request(server).get(path).set('Authorization', `Bearer ${token}`);
    const post = (path: string, token: string, body?: unknown) =>
        request(server).post(path).set('Authorization', `Bearer ${token}`).send(body ?? {});
    const patch = (path: string, token: string, body?: unknown) =>
        request(server).patch(path).set('Authorization', `Bearer ${token}`).send(body ?? {});
    const del = (path: string, token: string, body?: unknown) =>
        request(server).delete(path).set('Authorization', `Bearer ${token}`).send(body ?? {});

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
        app.useGlobalFilters(new AllExceptionsFilter());
        await app.init();
        prisma = app.get(PrismaService);
        server = app.getHttpServer();

        ({ token: adminTok, userId: adminId } = await register('admin'));
        ({ token: opTok, userId: opId } = await register('op'));
        ({ token: supTok, userId: supId } = await register('sup'));
        ({ token: tenantTok, userId: tenantId } = await register('tenant'));
        ({ userId: lockId } = await register('lock'));
        ({ token: roleTok, userId: roleId } = await register('role'));

        // Assign platform roles directly (simulating bootstrap/promote). The guard reads them LIVE per request.
        await prisma.user.update({ where: { id: adminId }, data: { platformRole: 'ADMIN' } });
        await prisma.user.update({ where: { id: opId }, data: { platformRole: 'OPERATOR' } });
        await prisma.user.update({ where: { id: supId }, data: { platformRole: 'SUPPORT' } });

        // The tenant's primary org (createQuickSim uses findAllForUser[0]); create one if register didn't.
        let orgs = (await get('/orgs', tenantTok).expect(200)).body as Array<{ id: string }>;
        if (!orgs.length) {
            await post('/orgs', tenantTok, { name: 'Tenant Org' }).expect(201);
            orgs = (await get('/orgs', tenantTok).expect(200)).body;
        }
        tenantOrg = orgs[0]!.id;
    }, 60000);

    afterAll(async () => {
        // Audit rows now SetNull on user delete (they outlive the subject) → remove the test's rows explicitly.
        await prisma.auditLog
            .deleteMany({ where: { OR: [{ userId: { in: createdUserIds } }, { adminActorId: { in: createdUserIds } }, { orgId: tenantOrg }] } })
            .catch(() => undefined);
        await prisma.orgQuotaOverride.deleteMany({ where: { orgId: tenantOrg } }).catch(() => undefined);
        await prisma.simulationJob.deleteMany({ where: { orgId: tenantOrg } }).catch(() => undefined);
        for (const id of createdUserIds) {
            await prisma.orgMembership.deleteMany({ where: { userId: id } }).catch(() => undefined);
        }
        await prisma.refreshToken.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => undefined);
        // Orgs created by register (personal) cascade-delete their memberships/jobs.
        const orgs = await prisma.orgMembership.findMany({ where: { userId: { in: createdUserIds } }, select: { orgId: true } }).catch(() => []);
        for (const { orgId } of orgs) await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => undefined);
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => undefined);
        await app.close();
    }, 30000);

    // ---------------------------------------------------------------- authz
    describe('authorization', () => {
        it('401 without a token', async () => {
            await request(server).get('/admin/me').expect(401);
        });
        it('403 for an ordinary (NONE) user', async () => {
            await get('/admin/me', tenantTok).expect(403);
        });
        it('200 for SUPPORT and reports the live role', async () => {
            const res = await get('/admin/me', supTok).expect(200);
            expect(res.body).toMatchObject({ id: supId, platformRole: 'SUPPORT' });
        });
    });

    // ---------------------------------------------------------------- tier separation
    describe('graduated tiers', () => {
        it('SUPPORT can read but CANNOT mutate (suspend needs OPERATOR)', async () => {
            await get('/admin/users', supTok).expect(200);
            await patch(`/admin/orgs/${tenantOrg}/suspend`, supTok, { suspended: true }).expect(403);
        });
        it('OPERATOR can mutate but CANNOT change platform roles (needs ADMIN)', async () => {
            await patch(`/admin/orgs/${tenantOrg}`, opTok, { name: 'Renamed by Op' }).expect(200);
            await patch(`/admin/users/${roleId}/role`, opTok, { platformRole: 'SUPPORT' }).expect(403);
        });
    });

    // ---------------------------------------------------------------- reads
    describe('read observability', () => {
        it('lists users and finds the tenant', async () => {
            const res = await get(`/admin/users?search=admin-e2e-tenant-${stamp}`, adminTok).expect(200);
            expect(res.body.items.some((u: { id: string }) => u.id === tenantId)).toBe(true);
        });
        it('org detail carries a usage snapshot with effective limits', async () => {
            const res = await get(`/admin/orgs/${tenantOrg}`, adminTok).expect(200);
            expect(res.body.id).toBe(tenantOrg);
            expect(res.body.usage.sim.limits).toHaveProperty('concurrent');
        });
        it('cross-tenant job lists + queue health + health dashboard', async () => {
            await get('/admin/jobs/simulation', adminTok).expect(200);
            await get('/admin/jobs/design', adminTok).expect(200);
            const q = await get('/admin/queues/health', adminTok).expect(200);
            expect(q.body).toHaveProperty('simulations');
            expect(q.body).toHaveProperty('design');
            const h = await get('/admin/health/dashboard', adminTok).expect(200);
            expect(['ok', 'degraded']).toContain(h.body.status);
            expect(h.body.dependencies.database.status).toBe('ok');
        });
    });

    // ---------------------------------------------------------------- suspend → real effect
    describe('org suspension blocks writes (before → after)', () => {
        it('quick-sim works, then suspend blocks it 403 ORG_SUSPENDED, then reinstate restores it', async () => {
            // BEFORE: the tenant can enqueue a quick sim.
            const before = await post('/simulations/quick', tenantTok, { netlist: DUMMY_NETLIST, analysisConfig: { type: 'op' } });
            expect([200, 201, 202]).toContain(before.status);

            // SUSPEND (operator).
            await patch(`/admin/orgs/${tenantOrg}/suspend`, opTok, { suspended: true, reason: 'e2e abuse test' }).expect(200);

            // AFTER: the same write is blocked with the structured 403.
            const during = await post('/simulations/quick', tenantTok, { netlist: DUMMY_NETLIST, analysisConfig: { type: 'op' } });
            expect(during.status).toBe(403);
            expect(JSON.stringify(during.body)).toContain('ORG_SUSPENDED');

            // REINSTATE → writes flow again.
            await patch(`/admin/orgs/${tenantOrg}/suspend`, opTok, { suspended: false }).expect(200);
            const after = await post('/simulations/quick', tenantTok, { netlist: DUMMY_NETLIST, analysisConfig: { type: 'op' } });
            expect([200, 201, 202]).toContain(after.status);
        });
    });

    // ---------------------------------------------------------------- quota override
    describe('per-org quota override', () => {
        it('sets an override and reflects it in the effective limit; clears it back to env', async () => {
            const set = await patch(`/admin/orgs/${tenantOrg}/quota`, opTok, { simConcurrent: 1, reason: 'e2e cap' }).expect(200);
            expect(set.body.simConcurrent).toBe(1);
            const detail = await get(`/admin/orgs/${tenantOrg}`, adminTok).expect(200);
            expect(detail.body.usage.sim.limits.concurrent).toBe(1);
            expect(detail.body.usage.override.simConcurrent).toBe(1);

            await del(`/admin/orgs/${tenantOrg}/quota`, opTok, { reason: 'e2e clear' }).expect(200);
            const cleared = await get(`/admin/orgs/${tenantOrg}`, adminTok).expect(200);
            expect(cleared.body.usage.override).toBeNull();
        });
    });

    // ---------------------------------------------------------------- job control (cancel)
    describe('simulation job cancel (queued)', () => {
        it('cancels a QUEUED sim by removing it from the queue; a second cancel is a 409', async () => {
            // No worker runs in the test, so the enqueued job stays waiting in BullMQ → removable.
            const created = await post('/simulations/quick', tenantTok, { netlist: DUMMY_NETLIST, analysisConfig: { type: 'op' } });
            expect([200, 201, 202]).toContain(created.status);
            const jobId = created.body.jobId as string;

            const cancel = await post(`/admin/jobs/simulation/${jobId}/cancel`, opTok, { reason: 'e2e cancel' }).expect(200);
            expect(cancel.body).toMatchObject({ status: 'CANCELED', removedFromQueue: true });
            const row = await prisma.simulationJob.findUnique({ where: { id: jobId }, select: { status: true } });
            expect(row?.status).toBe('CANCELED');

            // Already terminal → no longer cancelable.
            await post(`/admin/jobs/simulation/${jobId}/cancel`, opTok, {}).expect(409);
        });
    });

    // ---------------------------------------------------------------- lock + session revoke
    describe('lock revokes sessions', () => {
        it('locking a user sets lockedUntil and revokes its live refresh tokens', async () => {
            const before = await prisma.refreshToken.count({ where: { userId: lockId, revokedAt: null } });
            expect(before).toBeGreaterThan(0); // the register session
            const res = await patch(`/admin/users/${lockId}/lock`, opTok, { locked: true, reason: 'e2e lock' }).expect(200);
            expect(res.body.sessionsRevoked).toBeGreaterThanOrEqual(1);
            const after = await prisma.refreshToken.count({ where: { userId: lockId, revokedAt: null } });
            expect(after).toBe(0);
            const user = await prisma.user.findUnique({ where: { id: lockId }, select: { lockedUntil: true } });
            expect(user?.lockedUntil).toBeTruthy();
        });
    });

    // ---------------------------------------------------------------- role change (ADMIN) + live guard
    describe('platform-role change (ADMIN only) takes effect live', () => {
        it('promote reflects immediately on the SAME token; demote revokes + locks the admin surface', async () => {
            // roleTarget starts NONE → 403 on /admin/me
            await get('/admin/me', roleTok).expect(403);
            // ADMIN promotes to SUPPORT
            await patch(`/admin/users/${roleId}/role`, adminTok, { platformRole: 'SUPPORT', reason: 'e2e promote' }).expect(200);
            // Same token now passes — the guard read the new role from the DB (no re-login)
            const me = await get('/admin/me', roleTok).expect(200);
            expect(me.body.platformRole).toBe('SUPPORT');
            // ADMIN demotes back to NONE → the same token is locked out again
            const demote = await patch(`/admin/users/${roleId}/role`, adminTok, { platformRole: 'NONE', reason: 'e2e demote' }).expect(200);
            expect(demote.body.platformRole).toBe('NONE');
            await get('/admin/me', roleTok).expect(403);
        });
        it('an admin cannot change their OWN platform role', async () => {
            await patch(`/admin/users/${adminId}/role`, adminTok, { platformRole: 'OPERATOR' }).expect(400);
        });
    });

    // ---------------------------------------------------------------- last-owner guard
    describe('membership safety', () => {
        it('refuses to remove the last owner of an org', async () => {
            const res = await del(`/admin/orgs/${tenantOrg}/members/${tenantId}`, opTok, {});
            expect(res.status).toBe(400);
            expect(JSON.stringify(res.body).toLowerCase()).toContain('owner');
        });
        it('refuses to DEMOTE the last owner via the add/re-role path', async () => {
            const res = await post(`/admin/orgs/${tenantOrg}/members`, opTok, { userId: tenantId, role: 'MEMBER' });
            expect(res.status).toBe(400);
            expect(JSON.stringify(res.body).toLowerCase()).toContain('owner');
        });
    });

    // ---------------------------------------------------------------- audit trail
    describe('admin audit trail', () => {
        it('every mutation left an admin.* row with adminActorId + before/after + requestId', async () => {
            const suspendLog = await get('/admin/audit-logs?action=admin.org.suspend', adminTok).expect(200);
            expect(suspendLog.body.total).toBeGreaterThanOrEqual(1);
            const row = suspendLog.body.items[0];
            expect(row.adminActorId).toBe(opId);
            expect(row.meta).toHaveProperty('before');
            expect(row.meta).toHaveProperty('after');
            expect(typeof row.meta.requestId).toBe('string');
            expect(row.meta.adminActorEmail).toContain('admin-e2e-op');

            // filter by the acting admin returns the operator's mutations (suspend/reinstate/rename/quota/lock…)
            const byActor = await get(`/admin/audit-logs?adminActorId=${opId}`, adminTok).expect(200);
            expect(byActor.body.total).toBeGreaterThanOrEqual(4);
        });
    });
});
