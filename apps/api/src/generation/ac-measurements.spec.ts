/**
 * Unit tests for the −3 dB cutoff locator. No ngspice: synthetic magnitude curves with a KNOWN corner so we
 * can assert the located fc against the analytic answer, plus the honest-`null` cases (ambiguous / out-of-band).
 */
import { cutoffFrequency, isAcMagnitudeSeries, type FreqMagPoint } from './ac-measurements';

/** Log-spaced frequency grid, `ppd` points per decade from `fStart` to `fStop` (inclusive-ish). */
function logSweep(fStart: number, fStop: number, ppd = 20): number[] {
    const out: number[] = [];
    const decades = Math.log10(fStop / fStart);
    const n = Math.round(decades * ppd);
    for (let i = 0; i <= n; i++) out.push(fStart * 10 ** ((i / n) * decades));
    return out;
}

/** First-order low-pass |H(f)| = 1/√(1+(f/fc)²), peak (=1) at DC, −3 dB exactly at fc. */
const lowPass = (fc: number) => (f: number): FreqMagPoint => ({ x: f, y: 1 / Math.sqrt(1 + (f / fc) ** 2) });
/** First-order high-pass |H(f)| = (f/fc)/√(1+(f/fc)²), peak (→1) at high f, −3 dB exactly at fc. */
const highPass = (fc: number) => (f: number): FreqMagPoint => {
    const r = f / fc;
    return { x: f, y: r / Math.sqrt(1 + r ** 2) };
};
/** Band-pass with centre f0 and quality Q — peaks at f0, falls on BOTH sides (two −3 dB edges). */
const bandPass = (f0: number, q: number) => (f: number): FreqMagPoint => ({
    x: f,
    y: 1 / Math.sqrt(1 + (q * (f / f0 - f0 / f)) ** 2),
});

describe('cutoffFrequency', () => {
    it('locates the −3 dB corner of a first-order LOW-PASS within a few % of the analytic fc', () => {
        const fc = 1000;
        const pts = logSweep(10, 100_000).map(lowPass(fc));
        const got = cutoffFrequency(pts);
        expect(got).not.toBeNull();
        expect(got!).toBeGreaterThan(fc * 0.95);
        expect(got!).toBeLessThan(fc * 1.05);
    });

    it('locates the −3 dB corner of a first-order HIGH-PASS', () => {
        const fc = 2000;
        const pts = logSweep(20, 200_000).map(highPass(fc));
        const got = cutoffFrequency(pts);
        expect(got).not.toBeNull();
        expect(got!).toBeGreaterThan(fc * 0.95);
        expect(got!).toBeLessThan(fc * 1.05);
    });

    it('is independent of the AC source magnitude (peak-relative threshold) — scaling |H| leaves fc unchanged', () => {
        const fc = 1000;
        const base = logSweep(10, 100_000).map(lowPass(fc));
        const scaled = base.map((p) => ({ x: p.x, y: p.y * 7.3 })); // as if the source were "AC 7.3"
        const a = cutoffFrequency(base)!;
        const b = cutoffFrequency(scaled)!;
        expect(b).toBeCloseTo(a, 6);
    });

    it('returns null for a FLAT response (no crossing of peak/√2)', () => {
        const pts = logSweep(10, 100_000).map((f) => ({ x: f, y: 2 }));
        expect(cutoffFrequency(pts)).toBeNull();
    });

    it('returns null when the sweep does NOT reach the corner (zero crossings in-band)', () => {
        // Low-pass fc=1000 but we only sweep 10..500 Hz — |H| never falls to peak/√2 → not determinable.
        const pts = logSweep(10, 500).map(lowPass(1000));
        expect(cutoffFrequency(pts)).toBeNull();
    });

    it('returns null for a BAND-PASS (two −3 dB edges — "the" cutoff is ambiguous)', () => {
        const pts = logSweep(100, 100_000).map(bandPass(3000, 3));
        // Sanity: the curve really does dip below peak/√2 on both sides (so the null is from ambiguity, not absence).
        const peak = Math.max(...pts.map((p) => p.y));
        expect(pts.some((p) => p.y < peak / Math.SQRT2)).toBe(true);
        expect(cutoffFrequency(pts)).toBeNull();
    });

    it('returns null for an all-zero response (e.g. a source with no AC magnitude)', () => {
        const pts = logSweep(10, 100_000).map((f) => ({ x: f, y: 0 }));
        expect(cutoffFrequency(pts)).toBeNull();
    });

    it('returns null with fewer than two usable points', () => {
        expect(cutoffFrequency([])).toBeNull();
        expect(cutoffFrequency([{ x: 100, y: 1 }])).toBeNull();
    });

    it('ignores non-physical samples (f ≤ 0, NaN/Inf) instead of being derailed by them', () => {
        const fc = 1000;
        const clean = logSweep(10, 100_000).map(lowPass(fc));
        const dirty: FreqMagPoint[] = [
            { x: 0, y: 1 }, // f=0 (the .op row some producers prepend) — dropped
            { x: -5, y: 1 }, // negative freq — dropped
            { x: NaN, y: 1 },
            { x: 100, y: Infinity },
            ...clean,
        ];
        const got = cutoffFrequency(dirty);
        expect(got).not.toBeNull();
        expect(got!).toBeGreaterThan(fc * 0.95);
        expect(got!).toBeLessThan(fc * 1.05);
    });
});

describe('isAcMagnitudeSeries', () => {
    it('accepts magnitude series and rejects the appended phase series', () => {
        expect(isAcMagnitudeSeries('v(out)')).toBe(true);
        expect(isAcMagnitudeSeries('@r1[i]')).toBe(true);
        expect(isAcMagnitudeSeries('phase(v(out))')).toBe(false);
        expect(isAcMagnitudeSeries('  PHASE(v(out))')).toBe(false);
    });
});
