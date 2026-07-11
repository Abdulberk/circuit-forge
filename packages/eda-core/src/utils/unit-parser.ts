/**
 * SPICE Value Unit Parser
 * Handles parsing and formatting of SPICE-style values with suffixes
 */

/**
 * SPICE suffix multipliers
 */
const SPICE_SUFFIXES: Record<string, number> = {
    // Standard SI prefixes
    T: 1e12,
    G: 1e9,
    MEG: 1e6,
    K: 1e3,
    M: 1e-3,
    U: 1e-6,
    N: 1e-9,
    P: 1e-12,
    F: 1e-15,

    // Alternative notations
    MIL: 25.4e-6,
};

/**
 * Unit abbreviations
 */
const UNIT_ABBREVS: Record<string, string> = {
    OHM: 'Ω',
    OHMS: 'Ω',
    FARAD: 'F',
    HENRY: 'H',
    VOLT: 'V',
    VOLTS: 'V',
    AMP: 'A',
    AMPS: 'A',
    AMPERE: 'A',
    AMPERES: 'A',
    WATT: 'W',
    WATTS: 'W',
    HERTZ: 'Hz',
    HZ: 'Hz',
    SECOND: 's',
    SECONDS: 's',
    SEC: 's',
};

/**
 * Parse result
 */
export interface ParsedValue {
    value: number;
    unit?: string;
    original: string;
    isValid: boolean;
    error?: string;
}

/**
 * Parse a SPICE-style value string to a number
 * Supports suffixes like K, MEG, M, U, N, P, F
 * 
 * Examples:
 * - "1K" -> 1000
 * - "10MEG" -> 10000000
 * - "100n" -> 0.0000001
 * - "1.5u" -> 0.0000015
 * - "47pF" -> 4.7e-11 (with unit 'F')
 */
export function parseSpiceValue(input: string): ParsedValue {
    const original = input.trim();

    if (!original) {
        return { value: 0, original, isValid: false, error: 'Empty value' };
    }

    // Handle pure numbers INCLUDING scientific notation (1e3, 1.5e-6, 2E4). Without the [eE][+-]?\d+ group
    // these fell through to the suffix branch, which can't match an "e3"-style exponent (it contains a
    // digit) → isValid:false, value:0. That silently broke any value written in sci notation — and, worse,
    // perturbCircuit skips an unparseable value, so a TOLERANCED part in sci notation was treated as
    // zero-tolerance and inflated the reported Monte-Carlo yield. (The types/analysis.ts parser already had
    // the exponent group; this aligns the two.)
    const pureNumber = parseFloat(original);
    if (!isNaN(pureNumber) && /^[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(original)) {
        return { value: pureNumber, original, isValid: true };
    }

    // Regex to match value with optional suffix and unit
    // Examples: 1K, 10MEG, 100nF, 1.5uH, 47pF, 1e3k. A leading '+' AND a scientific-notation mantissa
    // are both accepted so this parser is a strict SUPERSET of SpiceValueSchema (which allows [+-]? … exponent …
    // [a-zA-Z]*): nothing the schema admits may fall through as unparseable, else a schema-valid analysis value
    // (e.g. a "1e-4m" step) would silently bypass the MAX_SIM_POINTS guard that reads this parser's isValid.
    const regex = /^([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*([A-Za-z]+)?$/i;
    const match = original.match(regex);

    if (!match) {
        return { value: 0, original, isValid: false, error: 'Invalid format' };
    }

    const numPart = parseFloat(match[1] || '0');
    const suffixPart = (match[2] || '').toUpperCase();

    if (isNaN(numPart)) {
        return { value: 0, original, isValid: false, error: 'Invalid number' };
    }

    if (!suffixPart) {
        return { value: numPart, original, isValid: true };
    }

    // Try to find a matching suffix
    let multiplier = 1;
    let unit: string | undefined;

    // Check for MEG first (3 letters)
    if (suffixPart.startsWith('MEG')) {
        multiplier = SPICE_SUFFIXES['MEG'] || 1e6;
        const remaining = suffixPart.slice(3);
        if (remaining) {
            unit = UNIT_ABBREVS[remaining] || remaining;
        }
    }
    // Check for MIL
    else if (suffixPart.startsWith('MIL')) {
        multiplier = SPICE_SUFFIXES['MIL'] || 25.4e-6;
        const remaining = suffixPart.slice(3);
        if (remaining) {
            unit = UNIT_ABBREVS[remaining] || remaining;
        }
    }
    // Check single letter suffixes
    else if (suffixPart.length >= 1) {
        const firstChar = suffixPart[0] || '';
        if (SPICE_SUFFIXES[firstChar] !== undefined) {
            multiplier = SPICE_SUFFIXES[firstChar] || 1;
            const remaining = suffixPart.slice(1);
            if (remaining) {
                unit = UNIT_ABBREVS[remaining] || remaining;
            }
        } else {
            // No suffix, entire thing is a unit
            unit = UNIT_ABBREVS[suffixPart] || suffixPart;
        }
    }

    return {
        value: numPart * multiplier,
        unit,
        original,
        isValid: true,
    };
}

/**
 * Format a number as a SPICE value string
 */
export function formatSpiceValue(value: number, unit?: string): string {
    if (value === 0) {
        return unit ? `0${unit}` : '0';
    }

    const absValue = Math.abs(value);
    const sign = value < 0 ? '-' : '';

    let suffix = '';
    let scaledValue = absValue;

    if (absValue >= 1e12) {
        suffix = 'T';
        scaledValue = absValue / 1e12;
    } else if (absValue >= 1e9) {
        suffix = 'G';
        scaledValue = absValue / 1e9;
    } else if (absValue >= 1e6) {
        suffix = 'MEG';
        scaledValue = absValue / 1e6;
    } else if (absValue >= 1e3) {
        suffix = 'K';
        scaledValue = absValue / 1e3;
    } else if (absValue >= 1) {
        suffix = '';
        scaledValue = absValue;
    } else if (absValue >= 1e-3) {
        suffix = 'm';
        scaledValue = absValue / 1e-3;
    } else if (absValue >= 1e-6) {
        suffix = 'u';
        scaledValue = absValue / 1e-6;
    } else if (absValue >= 1e-9) {
        suffix = 'n';
        scaledValue = absValue / 1e-9;
    } else if (absValue >= 1e-12) {
        suffix = 'p';
        scaledValue = absValue / 1e-12;
    } else {
        suffix = 'f';
        scaledValue = absValue / 1e-15;
    }

    // Format number to reasonable precision (4 sig figs). Round via toPrecision, then normalize with parseFloat
    // so trailing zeros drop cleanly. NOTE: a naive `.replace(/\.?0+$/, '')` is WRONG when toPrecision rounds a
    // banded mantissa UP to an integer string like "1000" (e.g. 999.99 → "1000"): it would strip the SIGNIFICANT
    // zeros → "1", a 1000x error (and, on a clamped step, a defeated MAX_SIM_POINTS guard). parseFloat keeps the
    // value: parseFloat("1000")=1000, parseFloat("4.700")=4.7.
    let formatted: string;
    if (Number.isInteger(scaledValue)) {
        formatted = scaledValue.toString();
    } else {
        formatted = Number.parseFloat(scaledValue.toPrecision(4)).toString();
    }

    return `${sign}${formatted}${suffix}${unit || ''}`;
}

/**
 * Normalize a value to base units
 */
export function normalizeValue(input: string): number {
    const parsed = parseSpiceValue(input);
    return parsed.isValid ? parsed.value : 0;
}

/**
 * Compare two SPICE values for equality (within tolerance)
 */
export function valuesEqual(a: string, b: string, tolerance: number = 1e-9): boolean {
    const parsedA = parseSpiceValue(a);
    const parsedB = parseSpiceValue(b);

    if (!parsedA.isValid || !parsedB.isValid) {
        return false;
    }

    const diff = Math.abs(parsedA.value - parsedB.value);
    const maxVal = Math.max(Math.abs(parsedA.value), Math.abs(parsedB.value));

    if (maxVal === 0) {
        return diff === 0;
    }

    return diff / maxVal < tolerance;
}

/**
 * Parse time value (handles s, ms, us, ns, ps)
 */
export function parseTimeValue(input: string): number {
    const parsed = parseSpiceValue(input);
    // Time values should be in seconds
    return parsed.value;
}

/**
 * Parse frequency value (handles Hz, kHz, MHz, GHz)
 */
export function parseFrequencyValue(input: string): number {
    const parsed = parseSpiceValue(input);
    // Frequency values should be in Hz
    return parsed.value;
}