/**
 * Min-max bucketing downsampler: the display decimation MUST preserve peaks/glitches (that's the
 * whole reason it isn't naive every-Nth sampling) and stay within the requested cap.
 */
import type { SimulationResult } from '../src/types/simulation';
import { downsamplePoints, downsampleResult } from '../src/utils/downsample';

describe('downsamplePoints', () => {
    it('returns the original array when already under the cap', () => {
        const pts = [...Array(50)].map((_, i) => ({ x: i, y: Math.sin(i / 5) }));
        expect(downsamplePoints(pts, 100)).toBe(pts);
    });

    it('caps the point count and keeps both endpoints', () => {
        const pts = [...Array(10_000)].map((_, i) => ({ x: i, y: Math.sin(i / 100) }));
        const out = downsamplePoints(pts, 500);
        expect(out.length).toBeLessThanOrEqual(500);
        expect(out.length).toBeGreaterThan(400);
        expect(out[0]).toEqual(pts[0]);
        expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
        // x stays monotonic (a polyline must never double back)
        for (let i = 1; i < out.length; i++) expect(out[i]!.x).toBeGreaterThanOrEqual(out[i - 1]!.x);
    });

    it('PRESERVES a single-sample glitch that naive sampling would drop', () => {
        // flat zero line with one 5V spike at an arbitrary index
        const pts = [...Array(100_000)].map((_, i) => ({ x: i, y: i === 73_217 ? 5 : 0 }));
        const out = downsamplePoints(pts, 1000);
        expect(out.length).toBeLessThanOrEqual(1000);
        expect(Math.max(...out.map((p) => p.y))).toBe(5); // the glitch survives
        // and the negative counterpart
        const pts2 = [...Array(100_000)].map((_, i) => ({ x: i, y: i === 991 ? -3 : 0 }));
        expect(Math.min(...downsamplePoints(pts2, 1000).map((p) => p.y))).toBe(-3);
    });

    it('preserves the global min AND max of a waveform', () => {
        const pts = [...Array(50_000)].map((_, i) => ({ x: i, y: Math.sin(i / 333) * (1 + i / 50_000) }));
        const out = downsamplePoints(pts, 800);
        const exactMax = Math.max(...pts.map((p) => p.y));
        const exactMin = Math.min(...pts.map((p) => p.y));
        expect(Math.max(...out.map((p) => p.y))).toBe(exactMax);
        expect(Math.min(...out.map((p) => p.y))).toBe(exactMin);
    });
});

describe('downsampleResult', () => {
    const mk = (n: number): SimulationResult => ({
        meta: { analysisType: 'tran', xLabel: 'time', xUnit: 's', pointsCount: n },
        series: [
            { name: 'v(out)', points: [...Array(n)].map((_, i) => ({ x: i, y: Math.sin(i / 10) })) },
            { name: 'v(in)', points: [...Array(n)].map((_, i) => ({ x: i, y: Math.cos(i / 10) })) },
        ],
    });

    it('decimates every series and records downsampledFrom', () => {
        const r = downsampleResult(mk(20_000), 1000);
        expect(r.series.every((s) => s.points.length <= 1000)).toBe(true);
        expect(r.meta.downsampledFrom).toBe(20_000);
        expect(r.meta.pointsCount).toBe(r.series[0]!.points.length);
    });

    it('is a no-op (same object, no downsampledFrom) when under the cap', () => {
        const orig = mk(100);
        const r = downsampleResult(orig, 1000);
        expect(r).toBe(orig);
        expect(r.meta.downsampledFrom).toBeUndefined();
    });
});
