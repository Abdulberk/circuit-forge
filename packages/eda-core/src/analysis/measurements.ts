/**
 * Distil a raw simulation series into the compact per-node measurement the assertion evaluator + the AI loop
 * reason about. Pure; shared by the API (inline + worker-result paths) AND the worker (Monte-Carlo batch),
 * which is why it lives in eda-core rather than the API.
 */
import type { DataSeries } from '../types/simulation';
import { cutoffFrequency, isAcMagnitudeSeries } from './ac-measurements';

/** One node's behaviour over the run, distilled to a few numbers the model can reason about. */
export interface SimMeasurement {
    node: string;
    min: number;
    max: number;
    final: number;
    pp: number; // peak-to-peak (max - min)
    /** TIME-WEIGHTED average (mean) over the run: ∫y·dt / T via trapezoidal integration on the (x,y) points.
     *  Time-weighted — NOT a sample mean — because ngspice uses ADAPTIVE timesteps, so samples cluster where
     *  the signal moves fast; a naive sample mean is biased. Falls back to the sample mean when the x-axis is
     *  unusable (non-monotonic / zero span / single point → avg = the value). Most meaningful for `tran`. */
    avg: number;
    /** TIME-WEIGHTED RMS over the run: sqrt(∫y²·dt / T) (trapezoidal). Same adaptive-timestep reasoning as
     *  `avg`; always ≥ 0. Single point → |value|. The canonical "RMS output / ripple" measurement. */
    rms: number;
    /** −3 dB cutoff frequency (Hz) of this node's AC magnitude response. Present (number or null) ONLY for an
     *  `.ac` magnitude series — `null` when the sweep doesn't bracket exactly one −3 dB crossing (flat,
     *  out-of-band, or band-pass/resonant ambiguity). Undefined for tran/dc/op and for phase series. */
    cutoff?: number | null;
    /** Total Harmonic Distortion (PERCENT, e.g. 0.27 = 0.27%) of this node, from a `.four`/fourier request on a
     *  transient. NOT derivable from the series — folded in from SimulationResult.fourier by attachFourierThd.
     *  Undefined unless fourier ran for this probe. Lets a `thd` criterion gate the verdict like any other metric. */
    thd?: number;
    /** FULL-PRECISION min/max/final/pp/avg/rms for the assertion evaluator. The fields above are rounded to 4
     *  sig figs for display/AI reasoning, but that rounding can flip a marginal approx/relational check (audit
     *  #8), so the verdict math reads these instead. Optional so an older serialized measurement degrades
     *  gracefully to the rounded fields. */
    raw?: { min: number; max: number; final: number; pp: number; avg: number; rms: number };
}

/** Distil one series to {min,max,final,pp} (+ the −3 dB cutoff for an AC magnitude series). Empty series
 *  degrade to zeros (caller reports nodeCount=0). Pass `analysisType` so an `.ac` run also yields the
 *  frequency-domain cutoff — without it the frequency axis is collapsed away and a cutoff spec can only be
 *  proxied by a single amplitude point. */
export function summarizeSeries(s: DataSeries, analysisType?: string): SimMeasurement {
    // Single pass: Math.min(...ys)/Math.max(...ys) would throw RangeError ("max call stack") once a
    // transient series passes ~100k points. This also avoids allocating the intermediate ys array.
    let min = Infinity;
    let max = -Infinity;
    let final = 0;
    let count = 0;
    // Sample-based fallback accumulators (used when the x-axis can't time-weight).
    let sum = 0;
    let sumSq = 0;
    // Time-weighted (trapezoidal) accumulators: ∫y·dx and ∫y²·dx across consecutive finite samples.
    let area = 0;
    let areaSq = 0;
    let firstX = NaN;
    let lastX = NaN;
    let prevX = NaN;
    let prevY = NaN;
    let xUsable = true; // cleared if any x is non-finite or the x-axis goes non-monotonic
    for (const p of s.points) {
        if (!Number.isFinite(p.y)) continue;
        if (p.y < min) min = p.y;
        if (p.y > max) max = p.y;
        final = p.y; // last finite sample
        sum += p.y;
        sumSq += p.y * p.y;
        const x = p.x;
        if (Number.isFinite(x)) {
            if (count === 0) firstX = x;
            else if (Number.isFinite(prevX)) {
                const dx = x - prevX;
                if (dx > 0) {
                    area += 0.5 * (prevY + p.y) * dx;
                    areaSq += 0.5 * (prevY * prevY + p.y * p.y) * dx;
                } else if (dx < 0) {
                    xUsable = false; // non-monotonic time/freq axis → trapezoid is meaningless
                }
            }
            prevX = x;
            lastX = x;
        } else {
            xUsable = false;
        }
        prevY = p.y;
        count++;
    }
    // Locate the −3 dB corner only for an AC MAGNITUDE series (not the appended phase(...) series). The
    // (x=freq, y=|H|) points survive here untouched — summarize derives the scalar fc alongside the
    // time/DC stats. Result is `null` when not determinable.
    const ac = analysisType === 'ac' && isAcMagnitudeSeries(s.name);
    if (count === 0) {
        return { node: s.name, min: 0, max: 0, final: 0, pp: 0, avg: 0, rms: 0, raw: { min: 0, max: 0, final: 0, pp: 0, avg: 0, rms: 0 }, ...(ac ? { cutoff: null } : {}) };
    }
    const round = (n: number) => Number(n.toPrecision(4));
    const rawPp = max - min;
    // Prefer the TIME-WEIGHTED integral; fall back to the sample mean when the x-axis is unusable (single
    // point, non-monotonic, or non-finite x — e.g. an op point or a degenerate sweep).
    const span = xUsable && Number.isFinite(firstX) && Number.isFinite(lastX) ? lastX - firstX : 0;
    const avg = span > 0 ? area / span : sum / count;
    const rms = Math.sqrt(Math.max(0, span > 0 ? areaSq / span : sumSq / count));
    return {
        node: s.name,
        // Rounded for display / AI reasoning…
        min: round(min),
        max: round(max),
        final: round(final),
        pp: round(rawPp),
        avg: round(avg),
        rms: round(rms),
        // …full precision for the verdict (audit #8 — rounding here can flip a marginal check).
        raw: { min, max, final, pp: rawPp, avg, rms },
        ...(ac ? { cutoff: cutoffFrequency(s.points) } : {}),
    };
}
