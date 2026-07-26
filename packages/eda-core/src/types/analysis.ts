/**
 * Analysis configuration types for SPICE simulations
 */
// SPICE-value parsing/formatting is the ONE tolerant implementation in utils/unit-parser (dependency-free, so no
// import cycle). This file used to carry a SECOND, private parser that THREW on any multiplier+unit token (e.g.
// "10ms", "1ns") — schema-valid values (SpiceValueSchema admits trailing letters) that crashed netlist generation
// via calculateDefaultStep, and silently disabled the MAX_SIM_POINTS guard (its throw was swallowed by a catch).
// Both paths now share the tolerant parser, so what the schema admits, the generator can always emit.
import { parseSpiceValue, formatSpiceValue } from '../utils/unit-parser';

/**
 * Union type for all analysis configurations
 */
export type AnalysisConfig = TranAnalysis | AcAnalysis | DcAnalysis | OpAnalysis | NoiseAnalysis | SensAnalysis;

/**
 * Optional ngspice solver tuning (`.options` card) — the convergence/accuracy levers a power-electronics
 * run sometimes needs (a stiff switcher that trips "Timestep too small" can often be rescued by a looser
 * reltol or a small gmin). All values are SPICE number strings; the generator validates each against an
 * anchored numeric pattern and SILENTLY DROPS invalid ones (an unvalidated token would be netlist
 * injection). Omit entirely for ngspice defaults — the defaults are right for most circuits.
 */
export interface SolverOptions {
    /** Relative error tolerance (ngspice default 1e-3). Looser (e.g. "0.01") helps stiff circuits converge. */
    reltol?: string;
    /** Absolute current error tolerance (default 1e-12). */
    abstol?: string;
    /** Absolute voltage error tolerance (default 1e-6). */
    vntol?: string;
    /** Minimum conductance (default 1e-12). Raising (e.g. "1e-9") tames near-singular matrices. */
    gmin?: string;
    /** Transient integration method (default "trap"; "gear" damps numerical ringing on stiff circuits). */
    method?: 'trap' | 'gear';
    /** Transient per-timepoint iteration limit (default 10). Raising helps hard switching edges. */
    itl4?: number;
}

/**
 * Transient analysis - time domain simulation
 */
export interface TranAnalysis {
    type: 'tran';
    stopTime: string; // e.g., "10m" for 10ms
    stepTime?: string; // e.g., "1u" for 1μs
    startTime?: string; // Default: 0
    maxStep?: string; // Maximum step size
    uic?: boolean; // Use Initial Conditions
    /**
     * Initial node voltages keyed by NET ID, e.g. { cap: 0.1 }. The generator emits a `.ic v(<node>)=<v>`
     * card per entry (net id sanitized to its SPICE node). It does NOT force `uic` — set `uic` yourself to
     * pick the idiom, because the two are opposite:
     *   • LEAVE uic UNSET (default) to KICK a self-starting oscillator that has a supply rail: ngspice solves
     *     the DC op-point with these nodes pinned then releases them, so the supply stays energized and the
     *     seed breaks the symmetric equilibrium. (Forcing uic here would zero the supply and abort the run.)
     *   • SET uic:true for pure-reactive seeding (a charged cap / lossless LC tank, no supply): ngspice skips
     *     the op-point and starts every unlisted node at 0 (cap=V, iL=0) — without uic such a circuit diverges.
     * Unknown net ids and ground are skipped (no phantom `.ic`).
     */
    initialConditions?: Record<string, number>;
    /** Optional ngspice solver tuning — see SolverOptions. */
    options?: SolverOptions;
    /**
     * Request ngspice `.four` Fourier analysis on this transient: the THD + harmonic breakdown of each listed
     * probe at `fundamentalFreq`. REPORT-ONLY — surfaced in the result (SimulationResult.fourier); it does NOT
     * gate the pass/fail verdict. For a meaningful THD the fundamental must match the dominant excitation
     * frequency, and the run should cover several full periods at a fine enough step.
     */
    fourier?: {
        /** Fundamental frequency as a SPICE value, e.g. "1k" — typically the source frequency. */
        fundamentalFreq: string;
        /** Voltage/current probes to analyze, e.g. ["v(out)"]. Each is node-remapped like a wrdata probe. */
        probes: string[];
    };
    /**
     * Request ngspice `.meas` measurements on this transient — timing/extrema/integral metrics computed by the
     * simulator (e.g. peak value + when it occurs, threshold-crossing time, signal integral). REPORT-ONLY:
     * surfaced in SimulationResult.measurements; does NOT gate the verdict. `.meas` rides on the existing run
     * (no extra simulation). Each spec is emitted as a validated `.meas tran <name> …` card — no raw passthrough.
     */
    measurements?: MeasureSpec[];
}

/** A single `.meas` measurement spec. The generator builds the `.meas` card from these VALIDATED fields (never
 *  a raw statement). max/min/pp/avg/rms/integ measure the probe over the run; `when` finds the time the probe
 *  crosses `value` (on the given edge). */
export interface MeasureSpec {
    /** Result label (letters/digits/underscore), e.g. "vpeak" or "t_settle". */
    name: string;
    /** Measurement kind. max/min = extremum (+ time); pp = peak-to-peak; avg/rms = mean/RMS over the run;
     *  integ = time integral; when = the time the probe crosses `value`. */
    type: 'max' | 'min' | 'pp' | 'avg' | 'rms' | 'integ' | 'when';
    /** Probe to measure, e.g. "v(out)" — node-remapped like a wrdata probe. */
    probe: string;
    /** For type "when": the threshold the probe must reach (SI base units). Ignored otherwise. */
    value?: number;
    /** For type "when": which crossing direction to time. Default "cross" (either direction). */
    edge?: 'rise' | 'fall' | 'cross';
}

/**
 * AC analysis - frequency domain (small-signal)
 */
export interface AcAnalysis {
    type: 'ac';
    variation: 'dec' | 'oct' | 'lin';
    points: number; // Points per decade/octave or total for lin
    startFreq: string; // e.g., "1" for 1Hz
    stopFreq: string; // e.g., "1MEG" for 1MHz
    /** Optional ngspice solver tuning — see SolverOptions. */
    options?: SolverOptions;
}

/**
 * DC analysis - DC sweep
 */
export interface DcAnalysis {
    type: 'dc';
    source: string; // Source designator (e.g., "V1")
    startVal: string; // Start value
    stopVal: string; // Stop value
    increment: string; // Step size
    /** Optional ngspice solver tuning — see SolverOptions. */
    options?: SolverOptions;
}

/**
 * Operating point analysis - single DC solution
 */
export interface OpAnalysis {
    type: 'op';
    /** Optional ngspice solver tuning — see SolverOptions. */
    options?: SolverOptions;
    /**
     * Request ngspice `.tf` DC small-signal transfer function on top of this operating point: the gain
     * Vout/Vin plus the input/output impedances. REPORT-ONLY — surfaced in SimulationResult.transferFunction;
     * does NOT gate the verdict. Rides on the op run (the op already writes the wrdata series, so no extra
     * handling). Emitted as the validated `tf <output> <inputSource>` control command + an explicit print.
     */
    tf?: {
        /** Output probe to measure, e.g. "v(out)" — node-remapped like a wrdata probe. */
        output: string;
        /** Input source designator the transfer is referenced to, e.g. "V1". */
        inputSource: string;
    };
}

/**
 * Noise analysis — small-signal noise vs frequency. Produces the output/input-referred noise SPECTRUM (voltage
 * density per √Hz, surfaced as series onoise_spectrum/inoise_spectrum) + the integrated TOTALS (surfaced in
 * SimulationResult.noise). REPORT-ONLY. NOTE: the input source MUST carry an AC magnitude (e.g. value
 * "DC 0 AC 1") or the noise is meaningless/zero — the caller is responsible for that on the source.
 */
export interface NoiseAnalysis {
    type: 'noise';
    /** Output node to evaluate noise at, e.g. "v(out)". */
    output: string;
    /** Input source the noise is referred back to, e.g. "V1". */
    inputSource: string;
    variation: 'dec' | 'oct' | 'lin';
    points: number;
    startFreq: string;
    stopFreq: string;
    /** Optional ngspice solver tuning — see SolverOptions. */
    options?: SolverOptions;
}

/**
 * DC sensitivity analysis — d(output)/d(each component value/parameter) at the operating point. Produces a
 * SCALAR TABLE (no series), surfaced in SimulationResult.sensitivity. REPORT-ONLY.
 */
export interface SensAnalysis {
    type: 'sens';
    /** Output node whose sensitivity to each element is computed, e.g. "v(out)". */
    output: string;
    /** Optional ngspice solver tuning — see SolverOptions. */
    options?: SolverOptions;
}

/**
 * Get the analysis type string
 */
export function getAnalysisType(config: AnalysisConfig): string {
    return config.type;
}

/**
 * Hard ceiling on the OUTPUT rows a single analysis may request. A tiny step over a long stop (tran), a
 * tiny dc increment, or an absurd ac points-per-decade could otherwise ask ngspice for millions/billions
 * of rows — a memory/IO/time runaway. The print step only sets OUTPUT density (solver accuracy is
 * governed by maxStep + tolerances, not the print step), and downstream stores at most ~20k points, so
 * flooring the step coarser is safe and invisible for any reasonable request. The worker's byte cap
 * (SIM_MAX_OUTPUT_BYTES) remains the final backstop.
 */
export const MAX_SIM_POINTS = 1_000_000;

/**
 * Floor a tran/dc step so (|stop - start|)/step <= MAX_SIM_POINTS. Returns the step UNCHANGED when it is
 * already within budget, or when the values can't be parsed (let ngspice surface its own error).
 */
function clampStepToPointBudget(start: string, stop: string, step: string): string {
    const pStop = parseSpiceValue(stop);
    const pStart = parseSpiceValue(start);
    const pStep = parseSpiceValue(step);
    // Any value unparseable → emit as-authored and let ngspice surface its own error. (The OLD private parser
    // THREW on a unit suffix like "1ns", so this guard was silently skipped for such values; the tolerant
    // parser reports isValid instead, so the point-budget clamp now actually fires on unit-suffixed values.)
    if (!pStop.isValid || !pStart.isValid || !pStep.isValid) return step;
    const span = Math.abs(pStop.value - pStart.value);
    const st = pStep.value;
    if (!(span > 0) || !(st > 0)) return step;
    if (span / st <= MAX_SIM_POINTS) return step;
    return formatSpiceValue(span / MAX_SIM_POINTS);
}

/**
 * Convert analysis config to SPICE command
 */
export function analysisToSpice(config: AnalysisConfig): string {
    switch (config.type) {
        case 'tran': {
            const start = config.startTime || '0';
            // Bound output density so a tiny step over a long stop can't request billions of rows.
            const step = clampStepToPointBudget(
                start,
                config.stopTime,
                config.stepTime || calculateDefaultStep(config.stopTime),
            );
            let cmd = `.tran ${step} ${config.stopTime} ${start}`;
            if (config.maxStep) {
                cmd += ` ${config.maxStep}`;
            }
            if (config.uic) {
                cmd += ' uic';
            }
            return cmd;
        }
        case 'ac': {
            // SINGLE-POINT sweep (startFreq == stopFreq): `.ac dec/oct N f f` makes ngspice run with
            // "No. of Data Rows : 0" — the wrdata then fails ("no such vector") and the caller gets zero
            // data with a misleading error. A degenerate log sweep over one point is `.ac lin 1 f f`.
            let samePoint = config.startFreq === config.stopFreq;
            if (!samePoint) {
                const pStart = parseSpiceValue(config.startFreq);
                const pStop = parseSpiceValue(config.stopFreq);
                // Only collapse to a single point when BOTH parse and are numerically equal; otherwise emit
                // as-authored and let ngspice report its own error (matches the prior catch-guarded behaviour).
                samePoint = pStart.isValid && pStop.isValid && pStart.value === pStop.value;
            }
            if (samePoint) return `.ac lin 1 ${config.startFreq} ${config.stopFreq}`;
            // Bound points-per-decade/total so an absurd count can't blow up the row count.
            const points = Math.min(config.points, MAX_SIM_POINTS);
            return `.ac ${config.variation} ${points} ${config.startFreq} ${config.stopFreq}`;
        }
        case 'dc': {
            // Bound the sweep density so a tiny increment over a wide range can't request millions of rows.
            const increment = clampStepToPointBudget(config.startVal, config.stopVal, config.increment);
            return `.dc ${config.source} ${config.startVal} ${config.stopVal} ${increment}`;
        }
        case 'op':
            return '.op';
        case 'noise': {
            // `.noise <output> <src> <variation> <pts> <fstart> <fstop>`. The generator pre-rewrites `output` to
            // the SPICE node before calling this. Points bounded like the ac sweep.
            const points = Math.min(config.points, MAX_SIM_POINTS);
            return `.noise ${config.output} ${config.inputSource} ${config.variation} ${points} ${config.startFreq} ${config.stopFreq}`;
        }
        case 'sens':
            // `.sens <output>` — DC sensitivity. The generator pre-rewrites `output` to the SPICE node.
            return `.sens ${config.output}`;
        default:
            throw new Error(`Unknown analysis type: ${(config as AnalysisConfig).type}`);
    }
}

/**
 * Calculate a reasonable default step time based on stop time
 */
function calculateDefaultStep(stopTime: string): string {
    // Default step = 1/1000th of the stop time. If the stop is unparseable (shouldn't happen for a
    // SpiceValueSchema-valid value, since the tolerant parser is a superset), emit it as-authored so ngspice
    // surfaces its own error rather than CRASHING netlist generation — which is exactly what the old throwing
    // parser did for a value like "10ms" (it rejected the "ms" suffix the schema accepts).
    const parsed = parseSpiceValue(stopTime);
    if (!parsed.isValid || !(parsed.value > 0)) return stopTime;
    return formatSpiceValue(parsed.value / 1000);
}
