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
