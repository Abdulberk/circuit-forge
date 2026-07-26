import { runWithRequestId, getRequestId } from '../context/request-context';

import { AuditService } from './audit.service';

describe('AuditService', () => {
    const makeService = () => {
        const create = jest.fn().mockResolvedValue({ id: 'a1' });
        const prisma = { auditLog: { create } } as any;
        return { service: new AuditService(prisma), create };
    };

    it('buildData maps scalars and merges meta (requestId + before/after + email + reason + extra)', () => {
        const { service } = makeService();
        runWithRequestId('req-123', () => {
            const data = service.buildData({
                action: 'admin.org.suspend',
                entityType: 'Organization',
                entityId: 'org1',
                orgId: 'org1',
                adminActorId: 'admin1',
                adminActorEmail: 'admin@x.io',
                reason: 'abuse',
                before: { suspendedAt: null },
                after: { suspendedAt: new Date('2026-07-02T00:00:00.000Z') },
                extra: { targetUserId: 'u9' },
            });
            expect(data.action).toBe('admin.org.suspend');
            expect(data.orgId).toBe('org1');
            expect(data.adminActorId).toBe('admin1');
            expect(data.userId).toBeNull();
            const meta = data.meta as Record<string, unknown>;
            expect(meta.requestId).toBe('req-123');
            expect(meta.adminActorEmail).toBe('admin@x.io');
            expect(meta.reason).toBe('abuse');
            expect(meta.targetUserId).toBe('u9');
            expect(meta.before).toEqual({ suspendedAt: null });
            // Date is JSON-serialized to an ISO string (Prisma-safe).
            expect((meta.after as Record<string, unknown>).suspendedAt).toBe('2026-07-02T00:00:00.000Z');
        });
    });

    it('omits requestId when outside a request context', () => {
        const { service } = makeService();
        const data = service.buildData({ action: 'x', entityType: 'User', entityId: 'u1' });
        expect((data.meta as Record<string, unknown>).requestId).toBeUndefined();
    });

    it('record() awaits the create and rejects on failure (mutations must not lose the trail silently)', async () => {
        const { service, create } = makeService();
        create.mockRejectedValueOnce(new Error('db down'));
        await expect(service.record({ action: 'x', entityType: 'User', entityId: 'u1' })).rejects.toThrow('db down');
    });

    it('recordSafe() never throws even when the write fails', async () => {
        const { service, create } = makeService();
        create.mockRejectedValueOnce(new Error('db down'));
        expect(() => service.recordSafe({ action: 'x', entityType: 'User', entityId: 'u1' })).not.toThrow();
        // let the swallowed rejection settle
        await new Promise((r) => setImmediate(r));
    });
});

describe('request-context', () => {
    it('getRequestId returns the id inside runWithRequestId and undefined outside', () => {
        expect(getRequestId()).toBeUndefined();
        runWithRequestId('abc', () => {
            expect(getRequestId()).toBe('abc');
        });
        expect(getRequestId()).toBeUndefined();
    });
});
