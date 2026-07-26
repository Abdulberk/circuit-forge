/**
 * Org-scoped audit-log e2e — a tenant OWNER/ADMIN reads THEIR OWN org's audit trail (access transparency),
 * and the read is (1) OWNER/ADMIN-gated, (2) org-isolated, and (3) REDACTED. Redaction is the load-bearing
 * part and is tested against the ACTUAL leak paths: top-level operator PII (adminActorEmail/requestId/raw
 * adminActorId), the raw operator id embedded INSIDE a quota-override snapshot (after.updatedByAdminId),
 * unexpected top-level meta keys, and operators' internal `reason` on non-suspension actions. Audit rows are
 * seeded directly (only platform-admin actions write them today). Boots the real app + DB. Requires Postgres.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Org audit log (GET /orgs/:orgId/audit-logs)', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let server: import('http').Server;

    let tokenA = '',
        userIdA = '',
        orgA = '',
        orgZero = '';
    let tokenB = '',
        userIdB = '',
        orgB = '';
    let tokenC = '',
        userIdC = ''; // a plain MEMBER of orgA
    let rowAdmin = '',
        rowTenant = '',
        rowQuota = '',
        rowExtra = '',
        rowNullMeta = '',
        rowOther = '';

    const audit = (org: string, token: string, q = '') =>
        request(server).get(`/orgs/${org}/audit-logs${q}`).set('Authorization', `Bearer ${token}`);

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
        await app.init();
        prisma = app.get(PrismaService);
        server = app.getHttpServer();

        const reg = async (p: string) =>
            (
                await request(server)
                    .post('/auth/register')
                    .send({ email: `${p}-${Date.now()}@test.com`, password: 'SecurePassword123!', name: p })
                    .expect(201)
            ).body;
        const a = await reg('aud-a');
        tokenA = a.accessToken;
        userIdA = a.user.id;
        const b = await reg('aud-b');
        tokenB = b.accessToken;
        userIdB = b.user.id;
        const c = await reg('aud-c');
        tokenC = c.accessToken;
        userIdC = c.user.id;
        orgA = (
            await request(server)
                .post('/orgs')
                .set('Authorization', `Bearer ${tokenA}`)
                .send({ name: 'Aud Org A' })
                .expect(201)
        ).body.id;
        orgB = (
            await request(server)
                .post('/orgs')
                .set('Authorization', `Bearer ${tokenB}`)
                .send({ name: 'Aud Org B' })
                .expect(201)
        ).body.id;
        orgZero = (
            await request(server)
                .post('/orgs')
                .set('Authorization', `Bearer ${tokenA}`)
                .send({ name: 'Aud Org Zero' })
                .expect(201)
        ).body.id;
        await prisma.orgMembership.create({ data: { orgId: orgA, userId: userIdC, role: 'MEMBER' } });

        const mk = async (data: Parameters<typeof prisma.auditLog.create>[0]['data']) =>
            (await prisma.auditLog.create({ data })).id;
        // 1) operator suspension — reason IS tenant-facing; PII in meta must be stripped.
        rowAdmin = await mk({
            orgId: orgA,
            adminActorId: userIdB,
            action: 'admin.org.suspend',
            entityType: 'Organization',
            entityId: orgA,
            meta: {
                requestId: 'req-secret-1',
                adminActorEmail: 'operator@internal.example',
                reason: 'Terms violation',
                before: { suspendedAt: null },
                after: { suspendedAt: '2026-07-15T00:00:00.000Z' },
            },
        });
        // 2) the org's OWN action (no admin actor) — reason is the org's own note, shown.
        rowTenant = await mk({
            orgId: orgA,
            userId: userIdC,
            action: 'org.member.role',
            entityType: 'OrgMembership',
            entityId: userIdC,
            meta: { reason: 'promote to admin', before: { role: 'MEMBER' }, after: { role: 'ADMIN' } },
        });
        // 3) operator quota override — the snapshot embeds updatedByAdminId (the raw operator id) — MUST be stripped
        //    from before/after; reason is an internal operator note on a non-suspend action — MUST be withheld.
        rowQuota = await mk({
            orgId: orgA,
            adminActorId: userIdB,
            action: 'admin.org.quota_override',
            entityType: 'OrgQuotaOverride',
            entityId: orgA,
            meta: {
                requestId: 'req-secret-q',
                adminActorEmail: 'operator@internal.example',
                reason: 'internal note SEC-4412 do not disclose',
                before: { simConcurrent: 2, updatedByAdminId: userIdB },
                after: { simConcurrent: 10, updatedByAdminId: userIdB },
            },
        });
        // 4) an operator action with an UNEXPECTED top-level meta key — must never be projected (whitelist, not blacklist).
        rowExtra = await mk({
            orgId: orgA,
            adminActorId: userIdB,
            action: 'admin.org.rename',
            entityType: 'Organization',
            entityId: orgA,
            meta: { internalNote: 'ops-only: flagged for review', reason: 'internal rename note' },
        });
        // 5) a row with NO meta at all — the defensive branch must yield reason/before/after = null, still 200.
        rowNullMeta = await mk({
            orgId: orgA,
            userId: userIdC,
            action: 'project.create',
            entityType: 'Project',
            entityId: 'proj-a1',
        });
        // other org — must never surface for orgA.
        rowOther = await mk({
            orgId: orgB,
            action: 'project.create',
            entityType: 'Project',
            entityId: 'proj-x',
            meta: { reason: 'n/a', after: { name: 'secret-b-project' } },
        });
    });

    afterAll(async () => {
        await prisma.auditLog
            .deleteMany({ where: { id: { in: [rowAdmin, rowTenant, rowQuota, rowExtra, rowNullMeta, rowOther] } } })
            .catch(() => undefined);
        await prisma.orgMembership
            .deleteMany({ where: { orgId: { in: [orgA, orgB, orgZero] } } })
            .catch(() => undefined);
        await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB, orgZero] } } }).catch(() => undefined);
        await prisma.user.deleteMany({ where: { id: { in: [userIdA, userIdB, userIdC] } } }).catch(() => undefined);
        await app.close();
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const find = (body: { items: any[] }, id: string): any => body.items.find((x) => x.id === id);

    it('an OWNER reads their org trail — paginated envelope, only their org rows', async () => {
        const r = await audit(orgA, tokenA).expect(200);
        expect(r.body).toMatchObject({ total: 5, limit: 50, offset: 0, hasMore: false });
        const ids = r.body.items.map((x: { id: string }) => x.id);
        expect(ids.sort()).toEqual([rowAdmin, rowTenant, rowQuota, rowExtra, rowNullMeta].sort());
        expect(ids).not.toContain(rowOther);
    });

    it('REDACTION (suspend): exposes reason/before/after + byPlatformAdmin, but NO operator PII', async () => {
        const item = find((await audit(orgA, tokenA).expect(200)).body, rowAdmin);
        expect(item).toMatchObject({
            byPlatformAdmin: true,
            reason: 'Terms violation',
            before: { suspendedAt: null },
            after: { suspendedAt: '2026-07-15T00:00:00.000Z' },
        });
        for (const k of ['meta', 'adminActorId', 'adminActorEmail', 'requestId']) expect(item).not.toHaveProperty(k);
        const blob = JSON.stringify(item);
        expect(blob).not.toContain('operator@internal.example');
        expect(blob).not.toContain('req-secret-1');
        expect(blob).not.toContain(userIdB);
    });

    it('REDACTION (quota override): strips the raw operator id embedded in before/after, keeps org-domain fields, withholds internal reason', async () => {
        const item = find((await audit(orgA, tokenA).expect(200)).body, rowQuota);
        expect(item.byPlatformAdmin).toBe(true);
        expect(item.reason).toBeNull(); // internal operator note on a non-suspend action → withheld
        expect(item.after).toMatchObject({ simConcurrent: 10 }); // org-domain data kept
        expect(item.after).not.toHaveProperty('updatedByAdminId'); // embedded operator id stripped
        expect(item.before).not.toHaveProperty('updatedByAdminId');
        const blob = JSON.stringify(item);
        expect(blob).not.toContain(userIdB); // the raw operator id must not appear anywhere
        expect(blob).not.toContain('req-secret-q');
        expect(blob).not.toContain('SEC-4412');
    });

    it('REDACTION (unexpected key): a meta key outside the whitelist is never projected; non-suspend operator reason withheld', async () => {
        const item = find((await audit(orgA, tokenA).expect(200)).body, rowExtra);
        expect(item.reason).toBeNull();
        expect(JSON.stringify(item)).not.toContain('ops-only: flagged for review');
    });

    it('a row with no meta yields null reason/before/after (defensive branch), still returned', async () => {
        const item = find((await audit(orgA, tokenA).expect(200)).body, rowNullMeta);
        expect(item).toMatchObject({ byPlatformAdmin: false, reason: null, before: null, after: null });
    });

    it('a tenant-authored row is flagged byPlatformAdmin=false and shows its own reason', async () => {
        const item = find((await audit(orgA, tokenA).expect(200)).body, rowTenant);
        expect(item).toMatchObject({ byPlatformAdmin: false, reason: 'promote to admin', userId: userIdC });
    });

    it('gate: a plain MEMBER cannot read the trail → 403', async () => {
        await audit(orgA, tokenC).expect(403);
    });

    it('gate: a non-member cannot read another org trail → 403', async () => {
        await audit(orgA, tokenB).expect(403);
    });

    it('isolation: org B owner sees only org B rows, never org A', async () => {
        const ids = (await audit(orgB, tokenB).expect(200)).body.items.map((x: { id: string }) => x.id);
        expect(ids).toContain(rowOther);
        expect(ids).not.toContain(rowAdmin);
        expect(ids).not.toContain(rowQuota);
    });

    it('an org with no audit rows returns an empty envelope', async () => {
        const r = await audit(orgZero, tokenA).expect(200);
        expect(r.body).toMatchObject({ total: 0, items: [], hasMore: false });
    });

    it('paging walks the full set without overlap or loss', async () => {
        const p0 = (await audit(orgA, tokenA, '?limit=2&offset=0').expect(200)).body;
        expect(p0).toMatchObject({ total: 5, limit: 2, hasMore: true });
        expect(p0.items).toHaveLength(2);
        const p1 = (await audit(orgA, tokenA, '?limit=2&offset=2').expect(200)).body;
        const p2 = (await audit(orgA, tokenA, '?limit=2&offset=4').expect(200)).body;
        expect(p2).toMatchObject({ hasMore: false });
        const all = [...p0.items, ...p1.items, ...p2.items].map((x: { id: string }) => x.id);
        expect(new Set(all).size).toBe(5); // no overlap, no loss across pages
    });

    it('the action filter narrows to a single row', async () => {
        const r = await audit(orgA, tokenA, '?action=admin.org.suspend').expect(200);
        expect(r.body.total).toBe(1);
        expect(r.body.items[0].id).toBe(rowAdmin);
    });

    it('the list is bounded — over-cap limit → 400', async () => {
        await audit(orgA, tokenA, '?limit=1000').expect(400);
    });
});
