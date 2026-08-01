/**
 * Waiting for a long-running job.
 *
 * WHICH SET IS CLOSED. The API has three job kinds and they do not share a status vocabulary: layout and
 * design end in SUCCEEDED / FAILED / CANCELED, simulation adds TIMED_OUT. A poller built on a list of
 * TERMINAL statuses would therefore hang forever the first time it met a status added after it was written —
 * the job finished, the UI spins, and nothing anywhere is wrong enough to log.
 *
 * So the closed set is the PENDING one. QUEUED and RUNNING mean keep waiting; everything else, known or not,
 * means the job is over and the caller is handed the row to interpret. Being wrong in this direction shows a
 * status the UI does not recognise, which someone notices in a second; being wrong in the other direction
 * produces a spinner that never stops.
 *
 * NO FIXED INTERVAL. A job that takes four minutes polled every second is 240 requests to learn nothing 239
 * times. The delay grows geometrically to a ceiling, so a job that finishes immediately is seen immediately
 * and a slow one costs a bounded trickle.
 */
import { ApiError } from './errors';

/** The statuses that mean "not finished". Everything outside this set ends the wait. */
const PENDING = new Set(['QUEUED', 'RUNNING']);

export const isPending = (status: string): boolean => PENDING.has(status);

export interface PollOptions {
    signal?: AbortSignal;
    /** First delay, in ms. Kept short so a fast job feels instant. */
    initialDelayMs?: number;
    /** Ceiling on the delay, so a long job settles into a steady trickle rather than growing unboundedly. */
    maxDelayMs?: number;
    factor?: number;
    /** Total wall-clock budget. Reached, it throws rather than waiting forever on a job nobody will finish. */
    timeoutMs?: number;
    /** Called with each observed row, for progress display. */
    onUpdate?: (row: { status: string }) => void;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new ApiError('aborted', 'Cancelled.'));
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        function onAbort() {
            // The timer is cleared, not merely orphaned: a pending timer keeps the whole closure — and the
            // job row it captured — alive until it fires, which on a page that polls continuously is a leak
            // that grows for as long as the tab is open.
            clearTimeout(timer);
            reject(new ApiError('aborted', 'Cancelled.'));
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });

/**
 * Poll `fetchRow` until the job leaves the pending set.
 *
 * Returns the final row whatever its status — FAILED is an outcome, not an exception. The caller decides how
 * to present it, and a `throw` here would force every call site into a try/catch to handle the ordinary case
 * of a job that did not succeed.
 */
export async function pollUntilSettled<T extends { status: string }>(
    fetchRow: (signal?: AbortSignal) => Promise<T>,
    options: PollOptions = {},
): Promise<T> {
    const {
        signal,
        initialDelayMs = 400,
        maxDelayMs = 5_000,
        factor = 1.5,
        timeoutMs = 15 * 60_000,
        onUpdate,
    } = options;

    const deadline = Date.now() + timeoutMs;
    let delay = initialDelayMs;

    for (;;) {
        const row = await fetchRow(signal);
        onUpdate?.(row);
        if (!isPending(row.status)) return row;

        if (Date.now() >= deadline) {
            throw new ApiError('network', `The job was still ${row.status} after ${Math.round(timeoutMs / 1000)}s.`, {
                body: row,
            });
        }
        // Never sleep past the deadline: without this the last wait could overshoot the budget by a full
        // interval, so a caller's timeout would be advisory rather than a bound.
        await sleep(Math.min(delay, Math.max(0, deadline - Date.now())), signal);
        delay = Math.min(delay * factor, maxDelayMs);
    }
}
