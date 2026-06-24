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
import { evaluateAssertions, type AcceptanceCriterion } from './analysis/assertions';
import type { SimMeasurement } from './analysis/measurements';

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

/** Per-variant outcome. `errored` = the variant's sim could not be RUN (spawn/infra fault) — it is NOT a
 *  spec failure and must be EXCLUDED from the yield denominator (counting an infra blip as a "fail" would
 *  understate yield). `pass`/`fail` = the variant ran and its acceptance criteria did/didn't all hold. */
export type VariantOutcome = 'pass' | 'fail' | 'errored';

export interface YieldSummary {
    /** Variants attempted (pass + fail + errored). */
    total: number;
    /** Variants that actually ran and were evaluated (pass + fail) — the yield denominator. */
    evaluated: number;
    passed: number;
    failed: number;
    /** Variants whose sim could not be run (infra/spawn) — excluded from yield. */
    errored: number;
    /** passed / evaluated in [0,1] (0 when nothing was evaluated). */
    yield: number;
    /** Wilson 95% confidence interval on the yield, over `evaluated` — honest about how few runs back it. */
    ci95: { low: number; high: number };
}

/**
 * Runs ONE Monte-Carlo variant: returns the per-node measurements when ngspice ran, or `null` when the
 * variant could NOT be run (spawn/infra fault) — `null` is counted `errored` and EXCLUDED from yield, never
 * a spec failure. Injected by the caller (the worker supplies the real ngspice runner; tests supply a fake),
 * so this orchestrator is pure and ngspice-free.
 */
export type VariantRunner = (variant: CircuitJson, index: number) => Promise<SimMeasurement[] | null>;

export interface MonteCarloOptions {
    /** Max variants to run (also the hard cap). Default 300. */
    n?: number;
    seed?: number;
    dist?: TolDistribution;
    /** Adaptive-N: once `minRuns` have run, stop early when the Wilson 95% half-width ≤ this (e.g. 0.03 = ±3%)
     *  — a clearly-robust or clearly-bad design converges in far fewer than `n` runs. Set 0 to disable. */
    ciStopHalfWidth?: number;
    /** Don't stop adaptively before this many evaluated runs (an early CI off 3 samples is meaningless). */
    minRuns?: number;
}

export interface MonteCarloYield extends YieldSummary {
    /** True when adaptive-N stopped before reaching `n` (the CI was already tight enough). */
    stoppedEarly: boolean;
    /** Variants actually attempted (≤ n). */
    ran: number;
}

/**
 * Orchestrate a Monte-Carlo yield run: draw perturbed variants one at a time (single seeded PRNG stream),
 * run each via the injected `runVariant`, evaluate the acceptance criteria locally, and aggregate a yield +
 * Wilson CI — with three-way accounting (errored variants excluded) and optional adaptive-N early stop. Pure
 * and deterministic given the seed; the only impurity (ngspice) is the injected runner.
 */
export async function runMonteCarlo(
    circuit: CircuitJson,
    criteria: AcceptanceCriterion[],
    runVariant: VariantRunner,
    opts: MonteCarloOptions = {},
): Promise<MonteCarloYield> {
    const n = Math.max(1, Math.min(opts.n ?? 300, 300));
    const minRuns = Math.max(1, opts.minRuns ?? 24);
    const ciStop = opts.ciStopHalfWidth ?? 0.03;
    const dist = opts.dist ?? 'gaussian';
    const rand = mulberry32(opts.seed ?? 1);

    const outcomes: VariantOutcome[] = [];
    let stoppedEarly = false;
    let ran = 0;
    for (let i = 0; i < n; i++) {
        const variant = perturbCircuit(circuit, rand, dist);
        ran++;
        let measurements: SimMeasurement[] | null;
        try {
            measurements = await runVariant(variant, i);
        } catch {
            measurements = null; // a thrown runner = the variant could not be run → errored
        }
        if (!measurements) {
            outcomes.push('errored');
            continue;
        }
        const results = evaluateAssertions(measurements, criteria);
        outcomes.push(results.length > 0 && results.every((r) => r.pass) ? 'pass' : 'fail');

        // Adaptive-N: stop once the interval is tight enough (but not before minRuns evaluated samples).
        if (ciStop > 0) {
            const evaluated = outcomes.filter((o) => o !== 'errored').length;
            if (evaluated >= minRuns) {
                const passed = outcomes.filter((o) => o === 'pass').length;
                const ci = wilson95(passed, evaluated);
                if ((ci.high - ci.low) / 2 <= ciStop) {
                    stoppedEarly = true;
                    break;
                }
            }
        }
    }
    return { ...computeYield(outcomes), stoppedEarly, ran };
}

/** Wilson score 95% interval for a binomial proportion (better than normal-approx at small n / extreme p). */
function wilson95(passed: number, n: number): { low: number; high: number } {
    if (n <= 0) return { low: 0, high: 1 };
    const z = 1.959963984540054; // 97.5th percentile of N(0,1)
    const z2 = z * z;
    const p = passed / n;
    const denom = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / denom;
    const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
    return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/**
 * Aggregate per-variant outcomes into a yield + Wilson 95% CI. The caller evaluates each variant's acceptance
 * criteria (pass/fail) and flags un-runnable variants `errored`; this excludes the errored ones from the
 * denominator so an infrastructure blip never masquerades as a low yield. Accepts a plain boolean[] too
 * (true=pass, false=fail) for callers with no error channel.
 */
export function computeYield(outcomes: Array<VariantOutcome | boolean>): YieldSummary {
    let passed = 0;
    let failed = 0;
    let errored = 0;
    for (const o of outcomes) {
        const v = o === true ? 'pass' : o === false ? 'fail' : o;
        if (v === 'pass') passed++;
        else if (v === 'fail') failed++;
        else errored++;
    }
    const evaluated = passed + failed;
    return {
        total: outcomes.length,
        evaluated,
        passed,
        failed,
        errored,
        yield: evaluated > 0 ? passed / evaluated : 0,
        ci95: wilson95(passed, evaluated),
    };
}
