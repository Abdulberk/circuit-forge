/**
 * The poller, at the two edges that matter: a status it has never seen, and a job that never ends.
 */
import { ApiError } from './errors';
import { isPending, pollUntilSettled } from './poll';

const rows = (...statuses: string[]) => {
    let i = 0;
    return {
        next: () => Promise.resolve({ status: statuses[Math.min(i++, statuses.length - 1)]! }),
        get calls() {
            return i;
        },
    };
};

const FAST = { initialDelayMs: 1, maxDelayMs: 2, factor: 1 } as const;

describe('waiting for a job', () => {
    it('returns the final row for every terminal status the API defines', async () => {
        // Three job kinds, three vocabularies: layout and design end SUCCEEDED / FAILED / CANCELED,
        // simulation adds TIMED_OUT. All of them must end the wait.
        for (const status of ['SUCCEEDED', 'FAILED', 'CANCELED', 'TIMED_OUT']) {
            const source = rows('QUEUED', 'RUNNING', status);
            await expect(pollUntilSettled(source.next, FAST)).resolves.toEqual({ status });
        }
    });

    it('stops on a status it has never heard of, rather than waiting forever', async () => {
        // THE inversion this file exists for. If TERMINAL were the closed set, a status added server-side
        // after this shipped would keep the spinner turning with nothing anywhere reporting a problem — the
        // job is done, the UI says it is not. Being wrong the other way shows an unfamiliar status, which
        // someone notices immediately.
        const source = rows('RUNNING', 'SUPERSEDED_BY_A_FUTURE_RELEASE');
        await expect(pollUntilSettled(source.next, FAST)).resolves.toEqual({
            status: 'SUPERSEDED_BY_A_FUTURE_RELEASE',
        });
        expect(isPending('SUPERSEDED_BY_A_FUTURE_RELEASE')).toBe(false);
        expect(isPending('QUEUED')).toBe(true);
        expect(isPending('RUNNING')).toBe(true);
    });

    it('does not return FAILED as an exception — it is an outcome', async () => {
        // A board that cannot be routed is ordinary. Throwing would force every call site into a try/catch
        // that then cannot tell "unroutable" from "the API is down".
        const source = rows('FAILED');
        await expect(pollUntilSettled(source.next, FAST)).resolves.toEqual({ status: 'FAILED' });
    });

    it('reports the status it gave up on when the budget runs out', async () => {
        const source = rows('RUNNING');
        const err = (await pollUntilSettled(source.next, { ...FAST, timeoutMs: 30 }).catch(
            (e: unknown) => e,
        )) as ApiError;
        expect(err).toBeInstanceOf(ApiError);
        expect(err.message).toContain('RUNNING');
    });

    it('honours the budget as a bound, not a suggestion', async () => {
        // Without clamping the final sleep, the last wait could overshoot by a whole interval — so a 100 ms
        // budget with a 5 s delay would return after five seconds.
        const source = rows('QUEUED');
        const started = Date.now();
        await pollUntilSettled(source.next, { initialDelayMs: 5_000, maxDelayMs: 5_000, timeoutMs: 60 }).catch(
            () => undefined,
        );
        expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('stops immediately when cancelled, and leaves no timer running', async () => {
        const controller = new AbortController();
        const source = rows('RUNNING');
        const pending = pollUntilSettled(source.next, { ...FAST, initialDelayMs: 5_000, signal: controller.signal });
        // Let the first fetch resolve so the poller is genuinely inside its sleep.
        await Promise.resolve();
        controller.abort();
        await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    });

    it('reports each observed row so a caller can show progress', async () => {
        const seen: string[] = [];
        const source = rows('QUEUED', 'RUNNING', 'SUCCEEDED');
        await pollUntilSettled(source.next, { ...FAST, onUpdate: (r) => seen.push(r.status) });
        expect(seen).toEqual(['QUEUED', 'RUNNING', 'SUCCEEDED']);
    });

    it('backs off instead of hammering a slow job', async () => {
        // Fixed-interval polling of a four-minute job is 240 requests to learn nothing 239 times.
        const source = rows('RUNNING', 'RUNNING', 'RUNNING', 'RUNNING', 'RUNNING', 'SUCCEEDED');
        const started = Date.now();
        await pollUntilSettled(source.next, { initialDelayMs: 10, factor: 2, maxDelayMs: 1_000 });
        // 10 + 20 + 40 + 80 + 160 = 310 ms of waiting for five pending observations; a fixed 10 ms would be 50.
        expect(Date.now() - started).toBeGreaterThan(250);
        expect(source.calls).toBe(6);
    });
});
