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