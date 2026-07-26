/**
 * Simulation result types
 */

/**
 * Complete simulation result structure
 */
export interface SimulationResult {
    meta: ResultMeta;
    series: DataSeries[];
    /** Fourier/THD results (one per `.four` probe), present only when a transient requested `fourier`.
     *  REPORT-ONLY: surfaced for the user/analysis, NOT wired into the pass/fail verdict. */
    fourier?: FourierResult[];
    /** `.meas` results (one per requested measurement), present only when the analysis requested `measurements`.
     *  REPORT-ONLY: surfaced for the user/analysis, NOT wired into the pass/fail verdict. */
    measurements?: MeasurementResult[];
    /** `.tf` DC small-signal transfer function (gain + input/output impedance), present only when an `op`
     *  analysis requested `tf`. REPORT-ONLY: surfaced for the user/analysis, NOT wired into the verdict. */
    transferFunction?: TransferFunctionResult;
    /** `.noise` integrated totals, present only for a `noise` analysis (the per-frequency spectrum is carried in
     *  `series` as onoise_spectrum/inoise_spectrum). REPORT-ONLY: NOT wired into the verdict. */
    noise?: NoiseResult;
    /** `.sens` DC sensitivity table (d(output)/d(component)), present only for a `sens` analysis. REPORT-ONLY. */
    sensitivity?: SensitivityResult;
}

/** ngspice `.sens` result: the output's DC sensitivity to each circuit element/parameter. */
export interface SensitivityResult {
    /** Non-zero sensitivity entries: each is d(output)/d(value) for an element/source/parameter, in
     *  output-units per the element's base unit (e.g. V/Ω for a resistor, V/V for a source). */
    entries: SensitivityEntry[];
}

export interface SensitivityEntry {
    /** The element/source/parameter name as ngspice reports it (e.g. "r1", "v1", "r1_scale"). */
    name: string;
    /** d(output)/d(this parameter). */
    value: number;
}

/** ngspice `.noise` integrated totals (the spectrum lives in SimulationResult.series). */
export interface NoiseResult {
    /** Integrated OUTPUT-referred noise over the swept band, in volts RMS (null if unparseable). */
    onoiseTotalV: number | null;
    /** Integrated INPUT-referred noise over the swept band, in volts RMS (null if unparseable). */
    inoiseTotalV: number | null;
}

/** ngspice `.tf` result: the DC small-signal transfer ratio + the impedances it reports. */
export interface TransferFunctionResult {
    /** Small-signal Vout/Vin (dimensionless), NaN if unparseable. */
    gain: number;
    /** The probed output node, e.g. "v(out)" (parsed from output_impedance_at_<node>). */
    outputNode: string;
    /** Output impedance at the probed node, in ohms (null if unparseable). */
    outputImpedanceOhms: number | null;
    /** The input source, e.g. "v1" (parsed from <src>#input_impedance). */
    inputSource: string;
    /** Input impedance seen by the source, in ohms (null if unparseable). */
    inputImpedanceOhms: number | null;
}

/** One ngspice `.meas` measurement result. A FAILED measure (e.g. a WHEN threshold never reached) is surfaced
 *  with value=null + failed=true — it never fails the simulation. */
export interface MeasurementResult {
    /** The measurement label the caller requested, e.g. "vmax" or "settle". */
    name: string;
    /** Primary scalar result in SI base units (V/A/s), or null when the measure failed. */
    value: number | null;
    /** Trailing qualifiers ngspice prints alongside the value (at=, from=, to=, targ=, trig=), in SI units. */
    qualifiers?: Record<string, number>;
    /** True when ngspice reported the measure failed (its value is null). */
    failed?: boolean;
    /** The raw ngspice line explaining the failure, when failed. */
    failureReason?: string;
}

/** One ngspice `.four` block: the harmonic decomposition + THD of a node's transient waveform. */
export interface FourierResult {
    /** The analyzed probe, e.g. "v(out)". */
    probe: string;
    /** Fundamental frequency the analysis used (Hz), i.e. the harmonic-1 frequency. */
    fundamentalFreq: number;
    /** Total Harmonic Distortion as a PERCENT (ngspice reports %, e.g. 42.92 means 42.92%), over the
     *  harmonics computed (default 10) — a TRUNCATED THD, not infinite-harmonic. NaN if unparseable. */
    thd: number;
    /** Per-harmonic breakdown (order 0 = DC, 1 = fundamental, …). */
    harmonics: FourierHarmonic[];
}

/** A single row of a `.four` harmonic table. */
export interface FourierHarmonic {
    /** Harmonic number: 0 = DC, 1 = fundamental, 2 = 2nd harmonic, … */
    order: number;
    frequency: number;
    magnitude: number;
    /** Phase in degrees. */
    phase: number;
    /** Magnitude normalized to the fundamental (harmonic 1 = 1). */
    normMag: number;
    /** Phase normalized to the fundamental, in degrees. */
    normPhase: number;
}

/**
 * Result metadata
 */
export interface ResultMeta {
    analysisType: string;
    xLabel: string;
    xUnit?: string;
    pointsCount: number;
    simulationTime?: number; // Runtime in milliseconds
    /** Present when the series were decimated for display (?maxPoints): the ORIGINAL point count. */
    downsampledFrom?: number;
}

/**
 * Data series for a single signal
 */
export interface DataSeries {
    name: string;
    unit?: string;
    points: DataPoint[];
}

/**
 * Single data point
 */
export interface DataPoint {
    x: number;
    y: number;
}

/**
 * Probe specification for output
 */
export interface Probe {
    type: 'voltage' | 'current';
    signal: string; // e.g., "v(n1)", "i(R1)"
    label?: string;
}

/**
 * Parse a probe string to determine type and signal
 */
export function parseProbe(probe: string): Probe {
    const voltageMatch = probe.match(/^v\(([^)]+)\)$/i);
    if (voltageMatch) {
        return {
            type: 'voltage',
            signal: probe.toLowerCase(),
            label: voltageMatch[1],
        };
    }

    const currentMatch = probe.match(/^i\(([^)]+)\)$/i);
    if (currentMatch) {
        return {
            type: 'current',
            signal: probe.toLowerCase(),
            label: currentMatch[1],
        };
    }

    // Default to voltage if no prefix
    return {
        type: 'voltage',
        signal: `v(${probe})`.toLowerCase(),
        label: probe,
    };
}

/**
 * Generate probe signals from circuit for default output
 */
export function generateDefaultProbes(nodeNames: string[]): string[] {
    return nodeNames
        .filter((name) => name !== '0') // Exclude ground
        .map((name) => `v(${name})`);
}

/**
 * Metrics from simulation run
 */
export interface SimulationMetrics {
    runtimeMs: number;
    peakMemBytes?: number;
    pointsCount: number;
    dataSize?: number;
}
