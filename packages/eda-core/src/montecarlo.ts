/**
 * Monte-Carlo / tolerance support — the foundation for "verified at X% YIELD" instead of "verified at the
 * nominal value only". Real parts vary within a tolerance; a design that passes at nominal can FAIL once R is
 * +5% and C is -5%. This module produces perturbed circuit VARIANTS (each component's value sampled within its
 * tolerance); the caller simulates each and aggregates how many meet the acceptance criteria.
 *
 * Pure + deterministic (a seeded PRNG is injected) — no ngspice, no I/O. The actual N simulations + criteria
 * evaluation happen in the caller (API/worker), which feeds the pass/fail flags back to computeYield.
 */
import { evaluateAssertions, type AcceptanceCriterion } from './analysis/assertions';
import type { SimMeasurement } from './analysis/measurements';
import type { CircuitJson } from './types/circuit';
import { mulberry32 } from './utils/prng';
import { parseComponentMagnitude } from './utils/unit-parser';

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
export function perturbValue(
    nominal: number,
    tolerance: number,
    rand: () => number,
    dist: TolDistribution = 'gaussian',
): number {
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
export function perturbCircuit(
    circuit: CircuitJson,
    rand: () => number,
    dist: TolDistribution = 'gaussian',
): CircuitJson {
    const components = circuit.components.map((c) => {
        if (!c.tolerance || c.tolerance <= 0 || !c.value) return c;
        const mag = parseComponentMagnitude(c.value);
        if (!mag) return c; // no scalar magnitude to vary (SIN/PULSE/model) — leave it
        return { ...c, value: mag.rebuild(perturbValue(mag.value, c.tolerance, rand, dist)) };
    });
    return { ...circuit, components };
}

/**
 * N deterministic Monte-Carlo variants from a seed. EVERY variant is perturbed (the nominal design is verified
 * separately by the caller); a single RNG stream is shared across all variants so the same seed reproduces the
 * exact same set. A circuit with no toleranced components yields N identical copies (yield is then 0% or 100%).
 */
export function monteCarloVariants(
    circuit: CircuitJson,
    n: number,
    seed = 1,
    dist: TolDistribution = 'gaussian',
): CircuitJson[] {
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
    /** Checked at the top of EACH iteration; returning true stops the batch (stoppedEarly=true). The worker
     *  uses this for a per-batch wall-clock BUDGET (`() => Date.now() > deadline`) — kept as a callback so
     *  eda-core stays wall-clock-free and the orchestrator stays deterministic in tests. */
    shouldStop?: () => boolean;
    /** Called after each variant with the count run so far — the worker uses it to CHECKPOINT progress
     *  (job.updateProgress) so a mid-batch death doesn't lose everything. */
    onProgress?: (ran: number) => void;
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
    const n = Math.max(1, Math.min(opts.n ?? 300, 2000)); // cap raised for a tight "robust" bound / manual deep runs
    const minRuns = Math.max(1, opts.minRuns ?? 24);
    const ciStop = opts.ciStopHalfWidth ?? 0.03;
    const dist = opts.dist ?? 'gaussian';
    const rand = mulberry32(opts.seed ?? 1);

    const outcomes: VariantOutcome[] = [];
    let stoppedEarly = false;
    let ran = 0;
    for (let i = 0; i < n; i++) {
        // Per-batch budget (wall-clock, supplied by the worker) — stop before drawing another variant.
        if (opts.shouldStop?.()) {
            stoppedEarly = true;
            break;
        }
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
        const results = evaluateAssertions(measurements, criteria, true, circuit.nets);
        outcomes.push(results.length > 0 && results.every((r) => r.pass) ? 'pass' : 'fail');
        opts.onProgress?.(outcomes.length); // checkpoint hook (worker persists partial progress)

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
    const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
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

// ---------------------------------------------------------------- robustness tier (yield → verdict)
//
// The single home for grading a Monte-Carlo yield into a robustness TIER, shared by the AI design loop
// (llm-core re-exports this) AND the /verify-design path (apps/api imports eda-core). Lives here — the
// lowest shared layer, beside the yield engine it grades — so no consumer needs the LLM package for pure
// verdict math. Thresholds are DEFAULTS per domain profile; a customer/contract requirement overrides.
// The tier is graded on the Wilson-95% LOWER bound (honest about sample count), never the point estimate.

export type RobustnessTier = 'robust' | 'marginal' | 'at-risk' | 'unknown';

export interface RobustnessBars {
    /** Wilson-lower-bound yield at/above which the design is "robust" (production-ready). */
    robustMin: number;
    /** Wilson-lower-bound yield at/above which it is "marginal" (works but below the production bar). */
    marginalMin: number;
    /** Ambient temperature-corner points (°C) [cold, room, hot] for this grade — the SAME profile drives BOTH
     *  the tolerance-yield bars and the temperature range, so there is ONE grade concept, not two (a separate
     *  "temperature grade" would confuse which knob does what). Consumed by the temperature-corner axis. */
    tempCornersC: readonly number[];
}

/** Yield bars per domain — DEFAULTS, configurable; customer/contract requirements override (Cpk 1.33 vs 1.67). */
export const ROBUSTNESS_PROFILES: Record<string, RobustnessBars> = {
    consumer: { robustMin: 0.99, marginalMin: 0.9, tempCornersC: [0, 25, 70] }, // general "capable" bar (≈ Cpk 1.33 / 4σ); commercial 0–70 °C
    automotive: { robustMin: 0.999, marginalMin: 0.99, tempCornersC: [-40, 25, 125] }, // safety/critical (≈ Cpk 1.67 / 5σ, IATF 16949); AEC-Q100 grade 1
    medical: { robustMin: 0.999, marginalMin: 0.99, tempCornersC: [-40, 25, 85] }, // industrial-equivalent -40–85 °C
};

export interface RobustnessVerdict {
    tier: RobustnessTier;
    /** Which domain profile's bars were applied. */
    profile: string;
    /** Point-estimate yield in [0,1], or null when no Monte-Carlo ran. */
    yield: number | null;
    /** Wilson-95% LOWER bound — the value the tier is graded on (honest re: sample count). */
    yieldLowerBound: number | null;
    /** Monte-Carlo variants actually evaluated. */
    evaluated: number | null;
    /** Plain-language, honest one-liner for the user / AI loop. */
    note: string;
}

/** Classify a yield report (from runMonteCarlo/computeYield) into a robustness tier. Pure; no I/O. `unknown`
 *  when no MC ran (no toleranced parts / capacity) — which honestly means "verified at NOMINAL values only". */
export function classifyRobustness(
    yieldReport: Record<string, unknown> | undefined,
    profileName = 'consumer',
): RobustnessVerdict {
    const bars = ROBUSTNESS_PROFILES[profileName] ?? ROBUSTNESS_PROFILES.consumer!;
    const yld = typeof yieldReport?.yield === 'number' ? yieldReport.yield : null;
    const ci = yieldReport?.ci95 as { low?: number; high?: number } | undefined;
    const lo = typeof ci?.low === 'number' ? ci.low : null;
    const evaluated = typeof yieldReport?.evaluated === 'number' ? yieldReport.evaluated : null;
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

    if (lo === null) {
        return {
            tier: 'unknown',
            profile: profileName,
            yield: yld,
            yieldLowerBound: null,
            evaluated,
            note: 'Robustness not assessed (no toleranced parts or no Monte-Carlo) — verified at NOMINAL component values only.',
        };
    }
    const tier: RobustnessTier = lo >= bars.robustMin ? 'robust' : lo >= bars.marginalMin ? 'marginal' : 'at-risk';
    const tail = `(component-tolerance Monte-Carlo, ${evaluated ?? '?'} runs; ~${pct(lo)} is the 95% lower bound; short-term, not long-term-drift-adjusted)`;
    const note =
        tier === 'robust'
            ? `Robust — at least ${pct(bars.robustMin)} of units expected to meet spec under component tolerances ${tail}.`
            : tier === 'marginal'
              ? `Marginal — ~${pct(lo)} expected yield, below the ${pct(bars.robustMin)} production bar. Tighten component tolerances (e.g. ±1% parts) or re-center values ${tail}.`
              : `At risk — only ~${pct(lo)} expected yield; passes at nominal but is NOT production-robust ${tail}.`;
    return { tier, profile: profileName, yield: yld, yieldLowerBound: lo, evaluated, note };
}
