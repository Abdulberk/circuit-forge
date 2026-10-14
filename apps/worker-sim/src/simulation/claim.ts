/**
 * Taking a simulation job off the queue, and recognising the ones that must not run.
 *
 * The design and PCB workers claim their row with a conditional update. This worker used to write RUNNING
 * unconditionally, which failed two ways:
 *
 *   • A job whose row no longer exists — its org was deleted, or a test suite enqueued into a shared Redis —
 *     threw "Record to update not found" on every attempt and was retried until the attempts ran out.
 *   • A row an admin had CANCELED was flipped back to RUNNING and simulated anyway.
 *
 * The claim decides which of those it is before anything runs.
 */
import type { PrismaClient } from '@prisma/client';

export type ClaimOutcome = 'claimed' | 'terminal' | 'orphaned';

/** The part of the client the claim touches, so a test can hand in a fake. */
export type ClaimDb = Pick<PrismaClient, 'simulationJob'>;

export async function claimSimulationJob(db: ClaimDb, jobId: string, now: Date = new Date()): Promise<ClaimOutcome> {
    // RUNNING is claimable as well as QUEUED. A retry of this same job finds its row still RUNNING from the
    // attempt before (the retry path deliberately leaves it there), and so does a stalled job BullMQ
    // re-delivers. Every other status is a decision somebody already made.
    const claim = await db.simulationJob.updateMany({
        where: { id: jobId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'RUNNING', startedAt: now },
    });
    if (claim.count > 0) return 'claimed';

    const row = await db.simulationJob.findUnique({ where: { id: jobId }, select: { status: true } });
    return row ? 'terminal' : 'orphaned';
}

/** Prisma's "record to update not found": the row went away while the job was running. */
export function isRecordNotFound(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2025';
}
