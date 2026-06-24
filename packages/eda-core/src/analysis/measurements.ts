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
    /** −3 dB cutoff frequency (Hz) of this node's AC magnitude response. Present (number or null) ONLY for an
     *  `.ac` magnitude series — `null` when the sweep doesn't bracket exactly one −3 dB crossing (flat,
     *  out-of-band, or band-pass/resonant ambiguity). Undefined for tran/dc/op and for phase series. */
    cutoff?: number | null;
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
    for (const p of s.points) {
        if (!Number.isFinite(p.y)) continue;
        if (p.y < min) min = p.y;
        if (p.y > max) max = p.y;
        final = p.y; // last finite sample
        count++;
    }
    // Locate the −3 dB corner only for an AC MAGNITUDE series (not the appended phase(...) series). The
    // (x=freq, y=|H|) points survive here untouched — summarize derives the scalar fc alongside the
    // time/DC stats. Result is `null` when not determinable.
    const ac = analysisType === 'ac' && isAcMagnitudeSeries(s.name);
    if (count === 0) {
        return { node: s.name, min: 0, max: 0, final: 0, pp: 0, ...(ac ? { cutoff: null } : {}) };
    }
    const round = (n: number) => Number(n.toPrecision(4));
    return {
        node: s.name,
        min: round(min),
        max: round(max),
        final: round(final),
        pp: round(max - min),
        ...(ac ? { cutoff: cutoffFrequency(s.points) } : {}),
    };
}
