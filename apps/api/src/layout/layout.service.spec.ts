/**
 * The layout LIST projection — what a PCB grid binds to.
 *
 * A board KiCad rejected and a board it certified both finish as `SUCCEEDED` with no `errorMessage`: the
 * analysis completed in each case and only the verdict differs. The list row carried nothing that told them
 * apart, so a client had to issue one detail request per row — each returning the entire result blob, tens
 * of kilobytes of geometry and DRC findings, to read a single boolean.
 *
 * These pin the mapping rather than the storage detail: `gerbersKey` is the verdict (the worker writes it
 * only on the manufacturable branch) but is not part of the client contract, and `manufacturable` is null
 * — not false — while the question has no answer yet.
 */
import { LayoutService } from './layout.service';

type Row = Record<string, unknown>;

const findMany = jest.fn();
const count = jest.fn();

const makeService = (): LayoutService =>
    new LayoutService(
        { layoutJob: { findMany, count } } as never, // prisma
        { findAllForUser: jest.fn().mockResolvedValue([{ id: 'org-1' }]) } as never, // orgs
        {} as never, // queue
        { get: jest.fn() } as never, // config
    );

const job = (over: Row = {}): Row => ({
    id: 'job-1',
    projectId: null,
    versionId: null,
    status: 'SUCCEEDED',
    errorMessage: null,
    createdAt: new Date('2026-07-28T00:00:00Z'),
    startedAt: new Date('2026-07-28T00:00:01Z'),
    finishedAt: new Date('2026-07-28T00:01:00Z'),
    gerbersKey: 'layouts/job-1/manufacturing.json',
    ...over,
});

const list = async (rows: Row[]): Promise<Row[]> => {
    findMany.mockResolvedValue(rows);
    count.mockResolvedValue(rows.length);
    const res = (await makeService().findAllForUser('user-1', { limit: 20, offset: 0 })) as { items: Row[] };
    return res.items;
};

beforeEach(() => jest.clearAllMocks());

describe('findAllForUser — the row must state the verdict, not just that the job finished', () => {
    it('a delivered board is manufacturable: true', async () => {
        const [row] = await list([job()]);
        expect(row!.status).toBe('SUCCEEDED');
        expect(row!.manufacturable).toBe(true);
    });

    it('a WITHHELD board is manufacturable: false — same status, opposite verdict', async () => {
        // This is the pair the old projection could not distinguish: both SUCCEEDED, both errorMessage null.
        const [row] = await list([job({ gerbersKey: null })]);
        expect(row!.status).toBe('SUCCEEDED');
        expect(row!.errorMessage).toBeNull();
        expect(row!.manufacturable).toBe(false);
    });

    it.each(['QUEUED', 'RUNNING', 'FAILED', 'CANCELED'])(
        'a %s job reports manufacturable: null — the question has no answer yet',
        async (status) => {
            // Deliberately not `false`: that reads as "we checked it and it failed", which is an over-claim
            // about a board nothing has judged.
            const [row] = await list([job({ status, gerbersKey: null })]);
            expect(row!.manufacturable).toBeNull();
        },
    );

    it('does NOT leak the storage key — a path is not part of the client contract', async () => {
        const [row] = await list([job()]);
        expect(row).not.toHaveProperty('gerbersKey');
    });

    it('still selects gerbersKey from the database — the mapping needs it', async () => {
        await list([job()]);
        expect(findMany.mock.calls[0]![0].select).toMatchObject({ gerbersKey: true });
    });

    it('keeps the rest of the row intact for the grid', async () => {
        const [row] = await list([job({ projectId: 'p1', versionId: 'v1' })]);
        expect(row).toMatchObject({ id: 'job-1', projectId: 'p1', versionId: 'v1', status: 'SUCCEEDED' });
    });

    it('returns an empty page for a user with no orgs, without querying', async () => {
        const svc = new LayoutService(
            { layoutJob: { findMany, count } } as never,
            { findAllForUser: jest.fn().mockResolvedValue([]) } as never,
            {} as never,
            { get: jest.fn() } as never,
        );
        const res = (await svc.findAllForUser('user-1', { limit: 20, offset: 0 })) as { items: Row[] };
        expect(res.items).toEqual([]);
        expect(findMany).not.toHaveBeenCalled();
    });
});

/**
 * WHICH ORG a layout belongs to.
 *
 * The ad-hoc path guesses: the user's first membership, which by construction is their personal workspace.
 * The client could neither choose it nor observe it, so a layout meant for a team landed somewhere the team
 * cannot see — invisible in their list, its quota charged elsewhere, and its presigned fab bundle
 * downloadable by whoever the caller shares that personal workspace with. The guess stays (it is the right
 * default for a one-off board), but it is now stateable and always reported back.
 */
describe('create — the org is stated or verified, never silently assumed without saying so', () => {
    const prismaStub = (): Record<string, unknown> => ({
        projectVersion: { findUnique: jest.fn() },
        layoutJob: { create: jest.fn().mockResolvedValue({ id: 'job-9', status: 'QUEUED' }), updateMany: jest.fn() },
    });

    const build = (over: { orgs?: Record<string, unknown>; prisma?: Record<string, unknown> } = {}) => {
        const prisma = over.prisma ?? prismaStub();
        const orgs = over.orgs ?? {
            findAllForUser: jest.fn().mockResolvedValue([{ id: 'org-personal' }, { id: 'org-team' }]),
            checkMembership: jest.fn().mockResolvedValue(undefined),
        };
        const queue = { add: jest.fn().mockResolvedValue(undefined) };
        const usage = { createLayoutGuarded: jest.fn((_org: string, fn: (tx: unknown) => unknown) => fn(prisma)) };
        return { svc: new LayoutService(prisma as never, orgs as never, usage as never, queue as never), orgs, usage };
    };

    const dto = { circuit: {} } as never;

    it('an EXPLICIT orgId is used, after membership is verified exactly as on the versioned path', async () => {
        const { svc, orgs, usage } = build();
        const res = await svc.create('user-1', { ...(dto as object), orgId: 'org-team' } as never);
        expect(orgs.checkMembership).toHaveBeenCalledWith('org-team', 'user-1');
        expect(usage.createLayoutGuarded).toHaveBeenCalledWith('org-team', expect.any(Function));
        expect(res.orgId).toBe('org-team');
    });

    it('an org the caller does not belong to is refused, not silently redirected', async () => {
        const orgs = {
            findAllForUser: jest.fn(),
            checkMembership: jest.fn().mockRejectedValue(new Error('Not a member of this organization')),
        };
        const { svc } = build({ orgs });
        await expect(svc.create('user-1', { ...(dto as object), orgId: 'org-other' } as never)).rejects.toThrow(
            /not a member/i,
        );
    });

    it('with no orgId it still guesses the first membership — but REPORTS which one it chose', async () => {
        const { svc, usage } = build();
        const res = await svc.create('user-1', dto);
        expect(usage.createLayoutGuarded).toHaveBeenCalledWith('org-personal', expect.any(Function));
        expect(res.orgId).toBe('org-personal'); // the caller can now notice the guess
    });

    it("a versioned layout takes the VERSION's org, and an orgId that disagrees is rejected", async () => {
        // Resolving the conflict silently in either direction would discard one of the caller's two stated
        // intentions without a word.
        const prisma = prismaStub();
        (prisma.projectVersion as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
            id: 'v1',
            projectId: 'p1',
            project: { orgId: 'org-team' },
        });
        const { svc, usage } = build({ prisma });
        const ok = await svc.create('user-1', { ...(dto as object), versionId: 'v1' } as never);
        expect(ok.orgId).toBe('org-team');
        expect(usage.createLayoutGuarded).toHaveBeenCalledWith('org-team', expect.any(Function));

        const conflicting = build({
            prisma: (() => {
                const p = prismaStub();
                (p.projectVersion as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
                    id: 'v1',
                    projectId: 'p1',
                    project: { orgId: 'org-team' },
                });
                return p;
            })(),
        });
        await expect(
            conflicting.svc.create('user-1', { ...(dto as object), versionId: 'v1', orgId: 'org-personal' } as never),
        ).rejects.toThrow(/conflicts with the version/i);
    });
});

describe('LayoutService.requestCancel — the same contract the design queue already uses', () => {
    const findUnique = jest.fn();
    const update = jest.fn();
    const checkMembership = jest.fn().mockResolvedValue(undefined);

    const cancelService = (): LayoutService =>
        new LayoutService(
            { layoutJob: { findUnique, update } } as never,
            { checkMembership } as never,
            {} as never,
            { get: jest.fn() } as never,
        );

    beforeEach(() => {
        findUnique.mockReset();
        update.mockReset();
        checkMembership.mockClear();
    });

    it('a QUEUED job is canceled outright — it has not started, so there is nothing to wind down', async () => {
        findUnique.mockResolvedValue({ id: 'j1', orgId: 'org-1', status: 'QUEUED' });
        await expect(cancelService().requestCancel('j1', 'u1')).resolves.toEqual({ id: 'j1', status: 'CANCELED' });
        expect(update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: 'CANCELED', abortRequested: true }),
            }),
        );
    });

    it('a RUNNING job only gets the flag — the worker owns when it actually stops', async () => {
        // Reporting CANCELED here would be a lie for as long as the worker keeps going, and the status is
        // what a client polls. The flag is the request; the worker writes the terminal status.
        findUnique.mockResolvedValue({ id: 'j2', orgId: 'org-1', status: 'RUNNING' });
        await expect(cancelService().requestCancel('j2', 'u1')).resolves.toEqual({ id: 'j2', status: 'RUNNING' });
        expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { abortRequested: true } }));
    });

    it.each(['SUCCEEDED', 'FAILED', 'CANCELED'])('a %s job is returned unchanged, not an error', async (status) => {
        // Idempotent on purpose: asking to stop something that has already stopped is not a failure, and a
        // client retrying a cancel after a dropped response must not get a 4xx for being careful.
        findUnique.mockResolvedValue({ id: 'j3', orgId: 'org-1', status });
        await expect(cancelService().requestCancel('j3', 'u1')).resolves.toEqual({ id: 'j3', status });
        expect(update).not.toHaveBeenCalled();
    });

    it('checks org membership before touching anything', async () => {
        // Cancelling someone else's job is a write. The membership check must gate it, not decorate it.
        findUnique.mockResolvedValue({ id: 'j4', orgId: 'org-9', status: 'QUEUED' });
        checkMembership.mockRejectedValueOnce(new Error('not a member'));
        await expect(cancelService().requestCancel('j4', 'intruder')).rejects.toThrow('not a member');
        expect(update).not.toHaveBeenCalled();
    });

    it('a missing job is a 404, never a silent success', async () => {
        findUnique.mockResolvedValue(null);
        await expect(cancelService().requestCancel('nope', 'u1')).rejects.toThrow(/not found/i);
        expect(checkMembership).not.toHaveBeenCalled();
    });
});
