/**
 * Unit tests for the −3 dB cutoff locator (moved into eda-core from the API). Synthetic magnitude curves with
 * a KNOWN corner so we assert the located fc against the analytic answer, plus the honest-`null` cases.
 */
import { cutoffFrequency, isAcMagnitudeSeries, type FreqMagPoint } from '../src/analysis/ac-measurements';

/** Log-spaced frequency grid, `ppd` points per decade from `fStart` to `fStop`. */
function logSweep(fStart: number, fStop: number, ppd = 20): number[] {
    const out: number[] = [];
    const decades = Math.log10(fStop / fStart);
    const n = Math.round(decades * ppd);
    for (let i = 0; i <= n; i++) out.push(fStart * 10 ** ((i / n) * decades));
    return out;
}

const lowPass = (fc: number) => (f: number): FreqMagPoint => ({ x: f, y: 1 / Math.sqrt(1 + (f / fc) ** 2) });
const highPass = (fc: number) => (f: number): FreqMagPoint => {
    const r = f / fc;
    return { x: f, y: r / Math.sqrt(1 + r ** 2) };
};
const bandPass = (f0: number, q: number) => (f: number): FreqMagPoint => ({
    x: f,
    y: 1 / Math.sqrt(1 + (q * (f / f0 - f0 / f)) ** 2),
});

describe('cutoffFrequency', () => {
    it('locates the −3 dB corner of a first-order LOW-PASS within a few % of the analytic fc', () => {
        const got = cutoffFrequency(logSweep(10, 100_000).map(lowPass(1000)));
        expect(got).not.toBeNull();
        expect(got!).toBeGreaterThan(950);
        expect(got!).toBeLessThan(1050);
    });
    it('locates the −3 dB corner of a first-order HIGH-PASS', () => {
        const got = cutoffFrequency(logSweep(20, 200_000).map(highPass(2000)));
        expect(got).not.toBeNull();
        expect(got!).toBeGreaterThan(1900);
        expect(got!).toBeLessThan(2100);
    });
    it('is independent of the AC source magnitude (peak-relative threshold)', () => {
        const base = logSweep(10, 100_000).map(lowPass(1000));
        const scaled = base.map((p) => ({ x: p.x, y: p.y * 7.3 }));
        expect(cutoffFrequency(scaled)!).toBeCloseTo(cutoffFrequency(base)!, 6);
    });
    it('returns null for a FLAT response (no crossing of peak/√2)', () => {
        expect(cutoffFrequency(logSweep(10, 100_000).map((f) => ({ x: f, y: 2 })))).toBeNull();
    });
    it('returns null when the sweep does NOT reach the corner', () => {
        expect(cutoffFrequency(logSweep(10, 500).map(lowPass(1000)))).toBeNull();
    });
    it('returns null when the sweep sits entirely in the ROLL-OFF (no flat passband captured — audit #10)', () => {
        // A 1 kHz low-pass swept 2 kHz–1 MHz: every sample is already attenuated, so the in-window maximum
        // is a lone edge sample. The old code anchored −3 dB to it and certified a bogus ~3 kHz corner;
        // without a captured passband plateau the honest answer is null.
        const pts = logSweep(2000, 1_000_000).map(lowPass(1000));
        const peak = Math.max(...pts.map((p) => p.y));
        // there IS a peak/√2 crossing in-window, so the OLD code would have returned a (wrong) number
        expect(pts.some((p) => p.y < peak / Math.SQRT2)).toBe(true);
        expect(cutoffFrequency(pts)).toBeNull();
    });
    it('returns null for a BAND-PASS (two −3 dB edges — ambiguous)', () => {
        const pts = logSweep(100, 100_000).map(bandPass(3000, 3));
        const peak = Math.max(...pts.map((p) => p.y));
        expect(pts.some((p) => p.y < peak / Math.SQRT2)).toBe(true);
        expect(cutoffFrequency(pts)).toBeNull();
    });
    it('returns null for an all-zero response and for <2 usable points', () => {
        expect(cutoffFrequency(logSweep(10, 100_000).map((f) => ({ x: f, y: 0 })))).toBeNull();
        expect(cutoffFrequency([])).toBeNull();
        expect(cutoffFrequency([{ x: 100, y: 1 }])).toBeNull();
    });
    it('ignores non-physical samples (f ≤ 0, NaN/Inf)', () => {
        const dirty: FreqMagPoint[] = [
            { x: 0, y: 1 }, { x: -5, y: 1 }, { x: NaN, y: 1 }, { x: 100, y: Infinity },
            ...logSweep(10, 100_000).map(lowPass(1000)),
        ];
        const got = cutoffFrequency(dirty);
        expect(got).not.toBeNull();
        expect(got!).toBeGreaterThan(950);
        expect(got!).toBeLessThan(1050);
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
