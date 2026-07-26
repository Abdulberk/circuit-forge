/**
 * assessTransientCompleteness — the ONE rule (shared by the worker runner, the inline API simulate, AND the
 * MC/corner/sweep variant runner) for "did this .tran reach its requested stopTime?". A run that stops well
 * short is a silently-truncated / collapsed transient and must NOT be measured.
 */
import { assessTransientCompleteness, TRANSIENT_COMPLETE_FRACTION } from '../src/analysis/transient-completeness';

const series = (lastX: number) => [{ points: [{ x: 0 }, { x: lastX }] }];

describe('assessTransientCompleteness', () => {
    it('flags a run that ended well before stopTime (below the 90% completeness fraction)', () => {
        const r = assessTransientCompleteness(series(1e-3), 10e-3); // reached 1ms of 10ms = 10%
        expect(r.endedEarly).toBe(true);
        expect(r.lastTime).toBeCloseTo(1e-3);
    });

    it('accepts a run that reached (near) stopTime', () => {
        expect(assessTransientCompleteness(series(9.5e-3), 10e-3).endedEarly).toBe(false); // 95% ≥ 90%
        expect(assessTransientCompleteness(series(10e-3), 10e-3).endedEarly).toBe(false); // exactly complete
    });

    it('is exactly bounded by TRANSIENT_COMPLETE_FRACTION', () => {
        const stop = 1;
        // Just under the fraction → early; at/above → complete.
        expect(assessTransientCompleteness(series(TRANSIENT_COMPLETE_FRACTION * stop - 1e-6), stop).endedEarly).toBe(
            true,
        );
        expect(assessTransientCompleteness(series(TRANSIENT_COMPLETE_FRACTION * stop), stop).endedEarly).toBe(false);
    });

    it('DISABLES the check when stopTime is unknown/non-positive (never fail a run we cannot bound)', () => {
        expect(assessTransientCompleteness(series(1e-3), 0).endedEarly).toBe(false);
        expect(assessTransientCompleteness(series(1e-3), -1).endedEarly).toBe(false);
    });

    it('reports lastTime = 0 (and never early) for an empty / point-less result', () => {
        expect(assessTransientCompleteness([], 10e-3)).toEqual({ endedEarly: false, lastTime: 0 });
        expect(assessTransientCompleteness([{ points: [] }], 10e-3)).toEqual({ endedEarly: false, lastTime: 0 });
    });

    it('takes the MAX last-time across multiple series (a probe with fewer points must not trip the guard)', () => {
        const multi = [{ points: [{ x: 0 }, { x: 9.9e-3 }] }, { points: [{ x: 0 }, { x: 2e-3 }] }];
        expect(assessTransientCompleteness(multi, 10e-3).endedEarly).toBe(false); // max 9.9ms is complete
        expect(assessTransientCompleteness(multi, 10e-3).lastTime).toBeCloseTo(9.9e-3);
    });
});
