/**
 * IEC 60063 E-series preferred values (E12/E24/E96) and snapping helpers.
 *
 * AI- or formula-derived component values are arbitrary reals (a divider asks for 3.27 kΩ, an RC filter for
 * 1591.5 Ω) — values you cannot BUY and the BOM/sourcing layer cannot map to a real MPN. Snapping to the
 * nearest preferred value yields a manufacturable design. Pure: numbers in, numbers/strings out.
 */
import type { CircuitJson } from '../types/circuit';

import { parseSpiceValue, formatSpiceValue } from './unit-parser';

export type ESeries = 'E12' | 'E24' | 'E96';

// Mantissas (1.00..9.xx) per IEC 60063. E96 is the standard 1%-tolerance table (hardcoded, not computed,
// so the canonical rounded values are exact).
const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
const E24 = [
    1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0,
    3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1,
];
const E96 = [
    1.0, 1.02, 1.05, 1.07, 1.1, 1.13, 1.15, 1.18, 1.21, 1.24, 1.27, 1.3, 1.33, 1.37, 1.4, 1.43,
    1.47, 1.5, 1.54, 1.58, 1.62, 1.65, 1.69, 1.74, 1.78, 1.82, 1.87, 1.91, 1.96, 2.0, 2.05, 2.1,
    2.15, 2.21, 2.26, 2.32, 2.37, 2.43, 2.49, 2.55, 2.61, 2.67, 2.74, 2.8, 2.87, 2.94, 3.01, 3.09,
    3.16, 3.24, 3.32, 3.4, 3.48, 3.57, 3.65, 3.74, 3.83, 3.92, 4.02, 4.12, 4.22, 4.32, 4.42, 4.53,
    4.64, 4.75, 4.87, 4.99, 5.11, 5.23, 5.36, 5.49, 5.62, 5.76, 5.9, 6.04, 6.19, 6.34, 6.49, 6.65,
    6.81, 6.98, 7.15, 7.32, 7.5, 7.68, 7.87, 8.06, 8.25, 8.45, 8.66, 8.87, 9.09, 9.31, 9.53, 9.76,
];

const MANTISSAS: Record<ESeries, number[]> = { E12, E24, E96 };

/**
 * The nearest E-series preferred value to `value` (> 0), chosen in LOG space (the series is log-spaced, so a
 * linear nearest would bias toward larger values). Returns `value` unchanged for non-finite / non-positive
 * input (let the caller's normal validation handle it).
 */
export function nearestESeries(value: number, series: ESeries = 'E24'): number {
    if (!Number.isFinite(value) || value <= 0) return value;
    const decade = Math.floor(Math.log10(value));
    const base = 10 ** decade;
    // Candidate mantissas in [1,10) PLUS 10 (= the next decade's 1.0) so a value near the top of a decade
    // snaps up correctly (e.g. 9.9 -> 10, not 9.1).
    const candidates = [...MANTISSAS[series], 10];
    const targetLog = Math.log10(value / base); // in [0,1)
    let best = candidates[0]!;
    let bestErr = Infinity;
    for (const m of candidates) {
        const err = Math.abs(Math.log10(m) - targetLog);
        if (err < bestErr) {
            bestErr = err;
            best = m;
        }
    }
    return best * base;
}

/**
 * True when `value` already IS (within `relTol`, default 0.1%) a preferred value of the series — i.e. it is
 * manufacturable as-is. A computed value like 1591.5 Ω sits ~0.5% off the nearest E24 (1.6 kΩ) and reads
 * false; an authored 4.7 kΩ reads true. The tight default catches near-misses while tolerating float noise.
 */
export function isESeriesValue(value: number, series: ESeries = 'E24', relTol = 0.001): boolean {
    if (!Number.isFinite(value) || value <= 0) return false;
    const nearest = nearestESeries(value, series);
    return Math.abs(value - nearest) / nearest <= relTol;
}

/**
 * Snap a SPICE value STRING ("3.27k") to the nearest preferred value, preserving the unit and returning a
 * formatted SPICE string ("3.3k"). Returns null when the input can't be parsed as a number (the caller keeps
 * the original). The unit (Ω/F/H, if any) rides through unchanged.
 */
export function snapValueString(spiceValue: string, series: ESeries = 'E24'): string | null {
    const parsed = parseSpiceValue(spiceValue);
    if (!parsed.isValid || !(parsed.value > 0)) return null;
    return formatSpiceValue(nearestESeries(parsed.value, series), parsed.unit);
}

/** One component whose value was snapped to a preferred value. `deltaPct` is the signed shift from the
 *  original ((to−from)/from·100) — small for a near-miss (3.27k→3.3k ≈ +0.9%), so a caller can warn if a
 *  snap moves a value enough to matter to the design. */
export interface ESeriesSnapChange {
    id: string;
    designator: string;
    type: string;
    from: string;
    to: string;
    deltaPct: number;
}

export interface ESeriesSnapResult {
    /** A NEW circuit (the input is not mutated) with snapped passive values. */
    circuit: CircuitJson;
    /** Every value that actually moved — empty when the design was already fully sourceable. */
    changes: ESeriesSnapChange[];
}

/** Passive types whose value is a single E-series magnitude (Ω/F/H). Sources (`DC 5`, `SIN(...)`), models,
 *  and multi-token values are intentionally left alone. */
const SNAPPABLE_TYPES = new Set(['resistor', 'capacitor', 'inductor']);

/**
 * Snap every passive (R/C/L) value in a circuit to the nearest E-series preferred value, returning a NEW
 * circuit + a per-change report — the "make this design sourceable" transform. A value that is already a
 * preferred value (isESeriesValue) or not a parseable single magnitude is left untouched. PURE: the input
 * circuit is not mutated. Deliberately a STANDALONE transform (not auto-applied in the design loop): snapping
 * shifts values slightly, so the caller decides when to apply it (e.g. after a verified design, then re-verify
 * at the preferred values) rather than silently changing what was simulated.
 */
export function snapCircuitToESeries(circuit: CircuitJson, series: ESeries = 'E24'): ESeriesSnapResult {
    const changes: ESeriesSnapChange[] = [];
    const components = circuit.components.map((c) => {
        if (!SNAPPABLE_TYPES.has(c.type) || typeof c.value !== 'string') return c;
        const parsed = parseSpiceValue(c.value);
        if (!parsed.isValid || !(parsed.value > 0) || isESeriesValue(parsed.value, series)) return c;
        const to = snapValueString(c.value, series);
        if (!to || to === c.value) return c;
        const toVal = parseSpiceValue(to).value;
        changes.push({
            id: c.id,
            designator: c.designator,
            type: c.type,
            from: c.value,
            to,
            deltaPct: ((toVal - parsed.value) / parsed.value) * 100,
        });
        return { ...c, value: to };
    });
    return { circuit: { ...circuit, components }, changes };
}
