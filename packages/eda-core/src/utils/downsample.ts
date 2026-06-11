/**
 * Waveform downsampling for display: MIN-MAX BUCKETING — the EDA-standard decimation. The x-range is
 * split into buckets and each bucket contributes its minimum AND maximum point (in x order), so peaks,
 * glitches and ringing survive (naive every-Nth sampling silently hides exactly the artifacts an
 * engineer is looking for). Endpoints are always kept. Deterministic, pure, O(n).
 */
import type { DataPoint, DataSeries, SimulationResult } from '../types/simulation';

/**
 * Downsample one point array to at most `maxPoints` points (≥ 4). Returns the original array when it
 * is already small enough. Points are assumed x-ascending (ngspice output is).
 */
export function downsamplePoints(points: DataPoint[], maxPoints: number): DataPoint[] {
    const cap = Math.max(4, Math.floor(maxPoints));
    if (points.length <= cap) return points;

    const first = points[0]!;
    const last = points[points.length - 1]!;
    const buckets = Math.max(1, Math.floor((cap - 2) / 2)); // 2 points (min+max) per bucket + endpoints
    const inner = points.slice(1, points.length - 1);
    const perBucket = inner.length / buckets;

    const out: DataPoint[] = [first];
    for (let b = 0; b < buckets; b++) {
        const start = Math.floor(b * perBucket);
        const end = Math.min(inner.length, Math.floor((b + 1) * perBucket));
        if (start >= end) continue;
        let min = inner[start]!;
        let max = inner[start]!;
        for (let i = start + 1; i < end; i++) {
            const p = inner[i]!;
            if (p.y < min.y) min = p;
            if (p.y > max.y) max = p;
        }
        // Emit in x order so the polyline never doubles back.
        if (min === max) out.push(min);
        else if (min.x <= max.x) out.push(min, max);
        else out.push(max, min);
    }
    out.push(last);
    return out;
}

/**
 * Downsample every series of a SimulationResult to at most `maxPoints` points each. When anything was
 * actually reduced, `meta.pointsCount` keeps the DOWNSAMPLED length of the first series (consistent
 * with the returned data) and `meta.downsampledFrom` records the original length, so a client can both
 * render what it received and tell the user the full resolution is available without the parameter.
 */
export function downsampleResult(result: SimulationResult, maxPoints: number): SimulationResult {
    const series: DataSeries[] = result.series.map((s) => ({
        ...s,
        points: downsamplePoints(s.points, maxPoints),
    }));
    const reduced = series.some((s, i) => s.points.length < result.series[i]!.points.length);
    if (!reduced) return result;
    return {
        meta: {
            ...result.meta,
            pointsCount: series[0]?.points.length ?? 0,
            downsampledFrom: result.meta.pointsCount,
        },
        series,
    };
}
