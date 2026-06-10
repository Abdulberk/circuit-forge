/**
 * Analysis configuration types for SPICE simulations
 */

/**
 * Union type for all analysis configurations
 */
export type AnalysisConfig = TranAnalysis | AcAnalysis | DcAnalysis | OpAnalysis;

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
}

/**
 * Operating point analysis - single DC solution
 */
export interface OpAnalysis {
    type: 'op';
}

/**
 * Get the analysis type string
 */
export function getAnalysisType(config: AnalysisConfig): string {
    return config.type;
}

/**
 * Convert analysis config to SPICE command
 */
export function analysisToSpice(config: AnalysisConfig): string {
    switch (config.type) {
        case 'tran': {
            const step = config.stepTime || calculateDefaultStep(config.stopTime);
            const start = config.startTime || '0';
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
                try {
                    samePoint = parseSpiceValue(config.startFreq) === parseSpiceValue(config.stopFreq);
                } catch {
                    samePoint = false; // unparseable values: emit as-authored, ngspice reports its own error
                }
            }
            if (samePoint) return `.ac lin 1 ${config.startFreq} ${config.stopFreq}`;
            return `.ac ${config.variation} ${config.points} ${config.startFreq} ${config.stopFreq}`;
        }
        case 'dc':
            return `.dc ${config.source} ${config.startVal} ${config.stopVal} ${config.increment}`;
        case 'op':
            return '.op';
        default:
            throw new Error(`Unknown analysis type: ${(config as AnalysisConfig).type}`);
    }
}

/**
 * Calculate a reasonable default step time based on stop time
 */
function calculateDefaultStep(stopTime: string): string {
    // Parse the stop time and return 1/1000th as default step
    const parsed = parseSpiceValue(stopTime);
    return formatSpiceValue(parsed / 1000);
}

/**
 * Parse a SPICE value string to a number
 */
export function parseSpiceValue(value: string): number {
    const suffixes: Record<string, number> = {
        T: 1e12,
        G: 1e9,
        MEG: 1e6,
        K: 1e3,
        k: 1e3,
        M: 1e-3, // Note: M alone usually means milli in SPICE
        m: 1e-3,
        U: 1e-6,
        u: 1e-6,
        N: 1e-9,
        n: 1e-9,
        P: 1e-12,
        p: 1e-12,
        F: 1e-15,
        f: 1e-15,
    };

    const match = value.match(/^([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*([a-zA-Z]*)/);
    if (!match) {
        throw new Error(`Invalid SPICE value: ${value}`);
    }

    const numericPart = parseFloat(match[1] || '0');
    const suffix = match[2] || '';

    if (suffix === '') {
        return numericPart;
    }

    // Check for MEG first (case insensitive)
    if (suffix.toUpperCase() === 'MEG') {
        return numericPart * 1e6;
    }

    const multiplier = suffixes[suffix] || suffixes[suffix.toUpperCase()];
    if (multiplier === undefined) {
        throw new Error(`Unknown SPICE suffix: ${suffix}`);
    }

    return numericPart * multiplier;
}

/**
 * Format a number as a SPICE value string
 */
export function formatSpiceValue(value: number): string {
    const absValue = Math.abs(value);
    const sign = value < 0 ? '-' : '';

    if (absValue >= 1e12) return `${sign}${absValue / 1e12}T`;
    if (absValue >= 1e9) return `${sign}${absValue / 1e9}G`;
    if (absValue >= 1e6) return `${sign}${absValue / 1e6}MEG`;
    if (absValue >= 1e3) return `${sign}${absValue / 1e3}k`;
    if (absValue >= 1) return `${sign}${absValue}`;
    if (absValue >= 1e-3) return `${sign}${absValue * 1e3}m`;
    if (absValue >= 1e-6) return `${sign}${absValue * 1e6}u`;
    if (absValue >= 1e-9) return `${sign}${absValue * 1e9}n`;
    if (absValue >= 1e-12) return `${sign}${absValue * 1e12}p`;
    if (absValue >= 1e-15) return `${sign}${absValue * 1e15}f`;

    return `${sign}${absValue}`;
}