/**
 * Monte-Carlo / tolerance support — the foundation for "verified at X% YIELD" instead of "verified at the
 * nominal value only". Real parts vary within a tolerance; a design that passes at nominal can FAIL once R is
 * +5% and C is -5%. This module produces perturbed circuit VARIANTS (each component's value sampled within its
 * tolerance); the caller simulates each and aggregates how many meet the acceptance criteria.
 *
 * Pure + deterministic (a seeded PRNG is injected) — no ngspice, no I/O. The actual N simulations + criteria
 * evaluation happen in the caller (API/worker), which feeds the pass/fail flags back to computeYield.
 */
import type { CircuitJson } from './types/circuit';
import { parseSpiceValue, formatSpiceValue } from './utils/unit-parser';
import { mulberry32 } from './utils/prng';

export type TolDistribution = 'gaussian' | 'uniform';

/** Standard-normal sample from two uniforms (Box-Muller). */
function gaussian(u1: number, u2: number): number {
    const r = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-12)));
    return r * Math.cos(2 * Math.PI * u2);
}

/**
 * Perturb a nominal numeric value within a fractional tolerance using the supplied uniform RNG.
 *   - 'gaussian' (default): tolerance is treated as 3σ (≈99.7% of parts within ±tol), then HARD-CLAMPED to
 *      ±tol so a rare large |z| can never produce a non-physical (e.g. negative) value.
 *   - 'uniform': flat ±tol — more conservative (samples the corners as often as the centre).
 * A non-positive tolerance returns the nominal unchanged.
 */
export function perturbValue(nominal: number, tolerance: number, rand: () => number, dist: TolDistribution = 'gaussian'): number {
    if (!(tolerance > 0)) return nominal;
    if (dist === 'uniform') return nominal * (1 + tolerance * (2 * rand() - 1));
    const z = gaussian(rand(), rand());
    const factor = Math.max(1 - tolerance, Math.min(1 + tolerance, 1 + (tolerance / 3) * z));
    return nominal * factor;
}

/**
 * One Monte-Carlo variant: clone the circuit and perturb each component that declares a tolerance and has a
 * parseable positive numeric value (R/C/L/source magnitudes). The SPICE unit (Ω/F/H) is preserved. Components
 * with no tolerance — or a non-numeric value (a SIN()/PULSE() source, a model name) — pass through unchanged.
 */
export function perturbCircuit(circuit: CircuitJson, rand: () => number, dist: TolDistribution = 'gaussian'): CircuitJson {
    const components = circuit.components.map((c) => {
        if (!c.tolerance || c.tolerance <= 0 || !c.value) return c;
        const parsed = parseSpiceValue(c.value);
        if (!parsed.isValid || !(parsed.value > 0)) return c; // non-numeric value (SIN/PULSE/model) — leave it
        return { ...c, value: formatSpiceValue(perturbValue(parsed.value, c.tolerance, rand, dist), parsed.unit) };
    });
    return { ...circuit, components };
}

/**
 * N deterministic Monte-Carlo variants from a seed. EVERY variant is perturbed (the nominal design is verified
 * separately by the caller); a single RNG stream is shared across all variants so the same seed reproduces the
 * exact same set. A circuit with no toleranced components yields N identical copies (yield is then 0% or 100%).
 */
export function monteCarloVariants(circuit: CircuitJson, n: number, seed = 1, dist: TolDistribution = 'gaussian'): CircuitJson[] {
    const rand = mulberry32(seed);
    const variants: CircuitJson[] = [];
    for (let i = 0; i < n; i++) variants.push(perturbCircuit(circuit, rand, dist));
    return variants;
}

export interface YieldSummary {
    /** Number of variants simulated. */
    n: number;
    /** Variants whose acceptance criteria ALL passed. */
    passed: number;
    /** passed / n in [0,1]. */
    yield: number;
}

/** Aggregate per-variant pass/fail flags (the caller evaluates the acceptance criteria per variant). */
export function computeYield(passFlags: boolean[]): YieldSummary {
    const n = passFlags.length;
    const passed = passFlags.reduce((acc, ok) => acc + (ok ? 1 : 0), 0);
    return { n, passed, yield: n > 0 ? passed / n : 0 };
}
