import { NotFoundException } from '@nestjs/common';
import { DesignJobService } from './design-job.service';

function setup() {
    const designJob = {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
    };
    const prisma = { designJob } as never;
    const orgs = {
        findAllForUser: jest.fn().mockResolvedValue([{ id: 'org-1' }]),
        checkMembership: jest.fn().mockResolvedValue(undefined),
    } as never;
    const design = { design: jest.fn() } as never;
    const svc = new DesignJobService(prisma, orgs, design);
    return { svc, designJob, orgs: orgs as unknown as { findAllForUser: jest.Mock; checkMembership: jest.Mock }, design: design as unknown as { design: jest.Mock } };
}

/** statuses written via prisma.designJob.update, in order. */
function updateStatuses(designJob: { update: jest.Mock }): string[] {
    return designJob.update.mock.calls.map((c) => c[0].data.status).filter(Boolean);
}

describe('DesignJobService.create', () => {
    it('creates a QUEUED job under the user’s first org', async () => {
        const { svc, designJob, orgs } = setup();
        designJob.create.mockResolvedValue({ id: 'j1', status: 'QUEUED' });

        const r = await svc.create('u1', { prompt: 'an LED driver', maxRounds: 2 });

        expect(orgs.findAllForUser).toHaveBeenCalledWith('u1');
        expect(designJob.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ orgId: 'org-1', userId: 'u1', status: 'QUEUED', prompt: 'an LED driver', maxRounds: 2 }),
            }),
        );
        expect(r).toEqual({ id: 'j1', status: 'QUEUED' });
    });

    it('throws when the user has no organization', async () => {
        const { svc, orgs } = setup();
        orgs.findAllForUser.mockResolvedValue([]);
        await expect(svc.create('u1', { prompt: 'x', maxRounds: 1 })).rejects.toBeInstanceOf(NotFoundException);
    });
});

describe('DesignJobService.getForUser', () => {
    it('returns status + result and enforces org membership', async () => {
        const { svc, designJob, orgs } = setup();
        designJob.findUnique.mockResolvedValue({
            id: 'j1', orgId: 'org-1', status: 'SUCCEEDED', result: { ok: true }, errorMessage: null,
            createdAt: new Date(0), startedAt: new Date(1), finishedAt: new Date(2),
        });

        const r = await svc.getForUser('j1', 'u1');

        expect(orgs.checkMembership).toHaveBeenCalledWith('org-1', 'u1');
        expect(r.status).toBe('SUCCEEDED');
        expect(r.result).toEqual({ ok: true });
    });

    it('throws NotFound for a missing job', async () => {
        const { svc, designJob } = setup();
        designJob.findUnique.mockResolvedValue(null);
        await expect(svc.getForUser('nope', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    });
});

describe('DesignJobService.requestCancel', () => {
    it('cancels a QUEUED job immediately', async () => {
        const { svc, designJob, orgs } = setup();
        designJob.findUnique.mockResolvedValue({ id: 'j1', orgId: 'org-1', status: 'QUEUED' });

        const r = await svc.requestCancel('j1', 'u1');

        expect(orgs.checkMembership).toHaveBeenCalledWith('org-1', 'u1');
        expect(r).toEqual({ id: 'j1', status: 'CANCELED' });
        expect(designJob.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELED', abortRequested: true }) }),
        );
    });

    it('sets the abort flag for a RUNNING job without changing its status', async () => {
        const { svc, designJob } = setup();
        designJob.findUnique.mockResolvedValue({ id: 'j1', orgId: 'org-1', status: 'RUNNING' });

        const r = await svc.requestCancel('j1', 'u1');

        expect(r).toEqual({ id: 'j1', status: 'RUNNING' });
        expect(designJob.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { abortRequested: true } }),
        );
    });

    it('is a no-op for an already-terminal job', async () => {
        const { svc, designJob } = setup();
        designJob.findUnique.mockResolvedValue({ id: 'j1', orgId: 'org-1', status: 'SUCCEEDED' });

        const r = await svc.requestCancel('j1', 'u1');

        expect(r).toEqual({ id: 'j1', status: 'SUCCEEDED' });
        expect(designJob.update).not.toHaveBeenCalled();
    });

    it('throws NotFound for a missing job', async () => {
        const { svc, designJob } = setup();
        designJob.findUnique.mockResolvedValue(null);
        await expect(svc.requestCancel('nope', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    });
});

describe('DesignJobService.runDetached', () => {
    it('runs the loop and persists RUNNING → SUCCEEDED with the result', async () => {
        const { svc, designJob, design } = setup();
        designJob.findUnique.mockResolvedValue({ abortRequested: false });
        design.design.mockResolvedValue({ ok: true, circuit: { components: [] } });

        await svc.runDetached('j1', { prompt: 'p', maxRounds: 2 }, 'u1');

        expect(design.design).toHaveBeenCalledWith({ prompt: 'p', constraints: undefined, maxRounds: 2 }, 'u1');
        expect(updateStatuses(designJob)).toEqual(['RUNNING', 'SUCCEEDED']);
        const last = designJob.update.mock.calls.at(-1)![0];
        expect(last.data.result).toEqual({ ok: true, circuit: { components: [] } });
    });

    it('skips the loop and cancels when an abort was requested before it starts', async () => {
        const { svc, designJob, design } = setup();
        designJob.findUnique.mockResolvedValue({ abortRequested: true });

        await svc.runDetached('j1', { prompt: 'p', maxRounds: 2 }, 'u1');

        expect(design.design).not.toHaveBeenCalled();
        expect(updateStatuses(designJob)).toEqual(['CANCELED']);
    });

    it('discards the result and cancels when an abort arrives mid-run', async () => {
        const { svc, designJob, design } = setup();
        let aborted = false;
        designJob.findUnique.mockImplementation(() => Promise.resolve({ abortRequested: aborted }));
        design.design.mockImplementation(async () => {
            aborted = true; // a cancel landed while the loop was running
            return { ok: true };
        });

        await svc.runDetached('j1', { prompt: 'p', maxRounds: 2 }, 'u1');

        expect(updateStatuses(designJob)).toEqual(['RUNNING', 'CANCELED']);
    });

    it('captures a loop failure as FAILED + message (never throws)', async () => {
        const { svc, designJob, design } = setup();
        designJob.findUnique.mockResolvedValue({ abortRequested: false });
        design.design.mockRejectedValue(new Error('LLM provider down'));

        await expect(svc.runDetached('j1', { prompt: 'p', maxRounds: 2 }, 'u1')).resolves.toBeUndefined();

        expect(updateStatuses(designJob)).toEqual(['RUNNING', 'FAILED']);
        const last = designJob.update.mock.calls.at(-1)![0];
        expect(last.data.errorMessage).toBe('LLM provider down');
    });
});
