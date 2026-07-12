/**
 * summarizeSeries — single-pass min/max/final. Guards the regression where Math.min(...ys) /
 * Math.max(...ys) threw RangeError ("Maximum call stack size exceeded") once a transient series
 * passed ~100k points (exactly the large runs that matter). No ngspice needed — pure function.
 */
import { summarizeSeries } from './circuit-simulator.service';
import type { DataSeries } from '@circuit-forge/eda-core';

describe('summarizeSeries', () => {
    it('handles a 200k-point series WITHOUT a stack-overflow and reports correct min/max/final/pp', () => {
        // y = sin-ish ramp so min/max/final are known: y(i) = (i % 1000) - 500 → min -500, max 499.
        const points = Array.from({ length: 200_000 }, (_, i) => ({ x: i, y: (i % 1000) - 500 }));
        const last = points[points.length - 1]!.y;
        const r = summarizeSeries({ name: 'v(out)', points } as DataSeries);
        expect(r.node).toBe('v(out)');
        expect(r.min).toBe(-500);
        expect(r.max).toBe(499);
        expect(r.final).toBe(last);
        expect(r.pp).toBe(999); // 499 - (-500)
    });

    it('ignores non-finite samples and uses the last FINITE value as final', () => {
        const r = summarizeSeries({
            name: 'v(n1)',
            points: [
                { x: 0, y: 1 },
                { x: 1, y: NaN },
                { x: 2, y: 5 },
                { x: 3, y: Infinity },
                { x: 4, y: 3 },
            ],
        } as DataSeries);
        expect(r.min).toBe(1);
        expect(r.max).toBe(5);
        expect(r.final).toBe(3); // last finite, not Infinity
        expect(r.pp).toBe(4);
    });

    it('yields NaN (NOT zeros) for an all-empty / all-non-finite series — a 0 would silently satisfy specs', () => {
        // A series with NO finite samples returns NaN, not 0 (arch-review debt #8): a 0 would SATISFY a spec
        // like "v(x) < 1" on data we never measured, so the assertion evaluator's finite-guard turns NaN into an
        // UNMEASURABLE verdict (actual:null) instead of a silent pass. Assert the COMPLETE shape (Jest toEqual
        // treats NaN as equal to NaN) so a future drift back to 0 is caught.
        const n = Number.NaN;
        const noData = { node: 'v(x)', min: n, max: n, final: n, pp: n, avg: n, rms: n, raw: { min: n, max: n, final: n, pp: n, avg: n, rms: n } };
        expect(summarizeSeries({ name: 'v(x)', points: [] } as DataSeries)).toEqual(noData);
        expect(summarizeSeries({ name: 'v(x)', points: [{ x: 0, y: Number.NaN }] } as DataSeries)).toEqual(noData);
    });
});
