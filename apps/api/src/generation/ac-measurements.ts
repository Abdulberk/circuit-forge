/**
 * AC frequency-response measurements — locate the −3 dB cutoff of a magnitude-vs-frequency curve.
 *
 * Pure: operates on the (frequency, magnitude) points the CSV parser already produces for an `.ac` run
 * (y = |H(f)| = hypot(re, im), x = Hz — see eda-core csv-parser). No ngspice, no I/O. This is the metric
 * that lets "verified" mean a frequency target was actually MEASURED, not proxied by a single amplitude
 * point (which admits a ±30% error in fc).
 */

/** A bare (frequency, magnitude) sample — structurally a DataPoint, kept local so this stays dependency-free. */
export interface FreqMagPoint {
    x: number; // frequency, Hz
    y: number; // magnitude |H(f)|
}

/**
 * The −3 dB cutoff frequency (Hz) of an AC magnitude curve, or `null` when it cannot be located
 * UNAMBIGUOUSLY.
 *
 * Definition: the frequency where |H(f)| crosses `peak / √2` (−3.01 dB below the passband peak). Because the
 * threshold is RELATIVE to the curve's own peak, the result is independent of the AC source magnitude — a
 * source declared "AC 1" or "AC 5" yields the same cutoff (the input magnitude cancels). A first-order or
 * well-damped (Q ≤ 0.707) low- or high-pass has exactly ONE such crossing inside the swept band → that is
 * the cutoff.
 *
 * Returns `null` when there are ZERO crossings (the sweep never reaches the corner, or the response is flat)
 * or MORE than one (band-pass / a resonant peak — "the" cutoff is ambiguous). Reporting "not determinable"
 * is deliberate: certifying a guessed corner is exactly the dishonesty this metric exists to kill, so the
 * caller must treat `null` as an unmet criterion (and widen the sweep / pick band-edge checks), never as a pass.
 */
export function cutoffFrequency(points: ReadonlyArray<FreqMagPoint>): number | null {
    // Keep only physical samples (f > 0 for a log-frequency axis, finite non-negative magnitude), sorted by
    // frequency — ngspice emits ascending, but a defensive sort costs nothing and de-risks reordered input.
    const pts = points
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > 0 && p.y >= 0)
        .sort((a, b) => a.x - b.x);
    if (pts.length < 2) return null;

    let peak = 0;
    for (const p of pts) if (p.y > peak) peak = p.y;
    if (!(peak > 0)) return null; // all-zero response (e.g. no AC source magnitude) — nothing to locate

    const threshold = peak / Math.SQRT2;
    const crossings: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        const aAbove = a.y >= threshold;
        const bAbove = b.y >= threshold;
        if (aAbove === bAbove) continue; // both sides on the same side of the threshold → no crossing here
        // Interpolate the crossing in log10(frequency) (an AC dec/oct sweep is log-spaced) and linearly in
        // magnitude — accurate to well under a point spacing at the ≥10 pts/decade the prompt asks for.
        const dy = b.y - a.y;
        const t = dy === 0 ? 0 : (threshold - a.y) / dy;
        const logf = Math.log10(a.x) + t * (Math.log10(b.x) - Math.log10(a.x));
        crossings.push(10 ** logf);
    }
    return crossings.length === 1 ? crossings[0]! : null;
}

/**
 * True for a magnitude series. The CSV parser appends one `phase(<probe>)` series per probe after the
 * magnitudes; the cutoff applies to |H|, never to a phase curve, so callers skip phase series.
 */
export function isAcMagnitudeSeries(name: string): boolean {
    return !/^phase\(/i.test(name.trim());
}
