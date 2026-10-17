/**
 * The claim, against a fake client. Three outcomes, and the two that are not 'claimed' are the reason the
 * module exists: a job with no row must be recognised rather than retried, and a CANCELED row must stay
 * canceled.
 */
import { claimSimulationJob, isRecordNotFound, type ClaimDb } from './claim';

type Status = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT';

type Row = { id: string; status: Status };
type UpdateManyArgs = { where: { id: string; status: { in: Status[] } }; data: { status: Status } };

/** A one-row table that applies the claim's WHERE the way Postgres would. */
function fakeDb(row: Row | null): { db: ClaimDb; updateMany: jest.Mock; row: Row | null } {
    const updateMany = jest.fn((args: UpdateManyArgs) => {
        if (!row || row.id !== args.where.id || !args.where.status.in.includes(row.status)) {
            return Promise.resolve({ count: 0 });
        }
        row.status = args.data.status;
        return Promise.resolve({ count: 1 });
    });
    const findUnique = jest.fn((args: { where: { id: string } }) =>
        Promise.resolve(row && row.id === args.where.id ? { status: row.status } : null),
    );
    return { db: { simulationJob: { updateMany, findUnique } } as unknown as ClaimDb, updateMany, row };
}

describe('claimSimulationJob', () => {
    it('claims a QUEUED row and moves it to RUNNING', async () => {
        const { db, row } = fakeDb({ id: 'j1', status: 'QUEUED' });
        await expect(claimSimulationJob(db, 'j1')).resolves.toBe('claimed');
        expect(row?.status).toBe('RUNNING');
    });

    it('claims a RUNNING row, because a retry of the same job finds its own row there', async () => {
        const { db } = fakeDb({ id: 'j1', status: 'RUNNING' });
        await expect(claimSimulationJob(db, 'j1')).resolves.toBe('claimed');
    });

    it.each<Status>(['CANCELED', 'SUCCEEDED', 'FAILED', 'TIMED_OUT'])('leaves a %s row alone and reports it terminal', async (status) => {
        const { db, row } = fakeDb({ id: 'j1', status });
        await expect(claimSimulationJob(db, 'j1')).resolves.toBe('terminal');
        expect(row?.status).toBe(status);
    });

    it('reports a job with no row as orphaned instead of throwing', async () => {
        const { db } = fakeDb(null);
        await expect(claimSimulationJob(db, 'gone')).resolves.toBe('orphaned');
    });

    it('stamps startedAt with the time it was given', async () => {
        const { db, updateMany } = fakeDb({ id: 'j1', status: 'QUEUED' });
        const now = new Date('2026-10-14T18:00:00Z');
        await claimSimulationJob(db, 'j1', now);
        expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'RUNNING', startedAt: now } }));
    });
});

describe('isRecordNotFound', () => {
    it("recognises Prisma's P2025", () => {
        expect(isRecordNotFound(Object.assign(new Error('Record to update not found.'), { code: 'P2025' }))).toBe(true);
    });

    it.each([new Error('connection refused'), { code: 'P2002' }, null, undefined, 'P2025'])('rejects %p', (error) => {
        expect(isRecordNotFound(error)).toBe(false);
    });
});
