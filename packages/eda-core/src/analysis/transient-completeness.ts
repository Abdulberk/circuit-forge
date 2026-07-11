/**
 * Transient completeness — the ONE rule for "did this `.tran` run actually reach its requested stopTime?".
 *
 * ngspice can exit 0 yet HALT far before stopTime when the adaptive timestep collapses (a floating node, a
 * missing DC path to ground, or too-hard a switching edge). The wrdata CSV then holds a PARTIAL waveform that
 * looks like a clean result — measuring it (reporting "ok", or folding it into a Monte-Carlo / corner / sweep
 * metric) is silently wrong. This rule lives in eda-core so every run path applies the IDENTICAL completeness
 * test: the worker runner (runner.ts), the inline API simulate (circuit-simulator.service.ts), AND the
 * per-variant MC/corner/sweep runner (variant-runner.ts) — which previously had NO such guard and so measured
 * clipped variant waveforms as if they were real pass/fail results.
 */

/** Fraction of the requested stopTime a transient must reach to count as complete. A run that ends before this
 *  is treated as a timestep-collapse / non-convergence, not a usable result. */
export const TRANSIENT_COMPLETE_FRACTION = 0.9;

export interface TransientCompleteness {
    /** True when the run stopped meaningfully short of stopTime (a silently-truncated / collapsed transient). */
    endedEarly: boolean;
    /** The last simulated time across all series (seconds); 0 when there are no data points. */
    lastTime: number;
}

/**
 * Assess whether a transient result reached its requested stopTime. `stopTime` is the requested end in SECONDS —
 * the caller parses its own source (the netlist `.tran` card, or the AnalysisConfig's stopTime) via
 * parseSpiceValue and passes the numeric value. A non-positive / unknown stopTime DISABLES the check
 * (endedEarly:false): we never fail a run whose intended length we can't bound.
 */
export function assessTransientCompleteness(
    series: ReadonlyArray<{ points: ReadonlyArray<{ x: number }> }>,
    stopTime: number,
): TransientCompleteness {
    const lastTime = Math.max(0, ...series.map((s) => (s.points.length ? s.points[s.points.length - 1]!.x : 0)));
    const endedEarly = stopTime > 0 && lastTime > 0 && lastTime < TRANSIENT_COMPLETE_FRACTION * stopTime;
    return { endedEarly, lastTime };
}
