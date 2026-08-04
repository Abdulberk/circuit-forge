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
import { buildProbeResolver } from './netlist/probe-map';
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
     *  — a clearly-robust or clearly-bad design converges in far fewer than `n` runs. Set 0 to disable.
     *
     *  ⚠️ A FIXED half-width cannot see the bar it will be graded against, so on its own it silently caps the
     *  achievable tier: ±3% is satisfied at 61 clean runs, where the Wilson LOWER bound is only 0.9408 — below
     *  every `robustMin` in ROBUSTNESS_PROFILES. Prefer `stopBars` (below), which stops when the TIER is
     *  decided rather than at an arbitrary precision. Kept for callers that genuinely want a fixed precision. */
    ciStopHalfWidth?: number;
    /** Bar-aware stopping — the correct default for anything that will be fed to `classifyRobustness`.
     *
     *  Pass the SAME bars the verdict will be graded with and the run stops as soon as the tier is no longer
     *  in doubt: lower ≥ robustMin (robust), upper < marginalMin (at-risk), or the interval sits wholly inside
     *  the marginal band. While the tier is still undecided it keeps sampling, because that is exactly when
     *  another sample buys something. Takes precedence over `ciStopHalfWidth`.
     *
     *  Also raises the run cap to `requiredRunsForBar(robustMin)` when the caller did not ask for more, so the
     *  top tier is actually reachable — a bar you cannot reach inside the cap is a promise the engine cannot
     *  keep (robustMin 0.999 needs 3838 clean runs; the old fixed cap of 2000 made it unreachable by
     *  construction, at any setting). Wall-clock is still bounded by `shouldStop`, which is the honest bound. */
    stopBars?: { robustMin: number; marginalMin: number };
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
    const bars = opts.stopBars;
    // With bars, the ceiling must at least allow the top tier to be earned (see requiredRunsForBar); an
    // explicit larger `n` still wins. ABSOLUTE_MAX_RUNS is a runaway guard only — the real cost bound is the
    // caller's wall-clock `shouldStop`.
    const cap = bars ? Math.max(2000, requiredRunsForBar(bars.robustMin)) : 2000;
    const defaultN = bars ? Math.min(requiredRunsForBar(bars.robustMin), cap) : 300;
    const n = Math.max(1, Math.min(opts.n ?? defaultN, cap, ABSOLUTE_MAX_RUNS));
    const minRuns = Math.max(1, opts.minRuns ?? 24);
    const ciStop = opts.ciStopHalfWidth ?? 0.03;
    const dist = opts.dist ?? 'gaussian';
    const rand = mulberry32(opts.seed ?? 1);

    const outcomes: VariantOutcome[] = [];
    let stoppedEarly = false;
    let ran = 0;
    // Running tallies. Recomputing these by filtering `outcomes` each iteration was O(n²) — invisible at 61
    // samples, ~29M operations at the 3838 a 0.999 bar needs.
    let passed = 0;
    let evaluated = 0;

    // With bars, `n` is a target of USABLE samples, not of attempts: an errored variant is infra noise, and
    // letting it consume the sample budget means a flaky box quietly costs the design its tier — the same
    // class of bug this fix exists to remove. Attempts stay bounded so a runner that errors on everything
    // still terminates. Without bars the ceiling keeps its original attempt semantics, untouched.
    const attemptCap = bars ? Math.min(ABSOLUTE_MAX_RUNS, n * ERRORED_ATTEMPT_HEADROOM) : n;

    // ONE resolver for the whole batch. `perturbCircuit` rewrites component VALUES; the nets, and the
    // component TYPES they are wired with, are identical in every variant — and those are what the mapping
    // is derived from. This is also where rebuilding would cost the most: at N = 100+ it would re-plan the
    // digital bridge a hundred times to produce an answer that cannot differ.
    const resolver = buildProbeResolver(circuit);

    for (let attempt = 0; attempt < attemptCap; attempt++) {
        // Collected enough usable samples for the bar — a complete run, not an early stop.
        if (bars && evaluated >= n) break;
        // Per-batch budget (wall-clock, supplied by the worker) — stop before drawing another variant.
        if (opts.shouldStop?.()) {
            stoppedEarly = true;
            break;
        }
        const variant = perturbCircuit(circuit, rand, dist);
        ran++;
        let measurements: SimMeasurement[] | null;
        try {
            measurements = await runVariant(variant, attempt);
        } catch {
            measurements = null; // a thrown runner = the variant could not be run → errored
        }
        if (!measurements) {
            outcomes.push('errored');
            // Nothing is running at all. Once we have spent `minRuns` attempts without a single usable
            // sample the runner is broken, not the design, and further attempts only burn spawns — stop and
            // let the caller read `errored === ran` for what it is.
            if (evaluated === 0 && outcomes.length >= minRuns) {
                stoppedEarly = true;
                break;
            }
            continue;
        }
        const results = evaluateAssertions(measurements, criteria, true, resolver);
        const ok = results.length > 0 && results.every((r) => r.pass);
        outcomes.push(ok ? 'pass' : 'fail');
        evaluated++;
        if (ok) passed++;
        opts.onProgress?.(outcomes.length); // checkpoint hook (worker persists partial progress)

        // Adaptive-N. Never before `minRuns` EVALUATED samples — an interval off three draws is noise.
        if (evaluated >= minRuns && (bars || ciStop > 0)) {
            const ci = wilson95(passed, evaluated);
            // Bar-aware wins when supplied: stop on a DECIDED tier, not an arbitrary precision.
            if (bars ? tierDecided(ci, bars) : (ci.high - ci.low) / 2 <= ciStop) {
                stoppedEarly = true;
                break;
            }
        }
    }
    return { ...computeYield(outcomes), stoppedEarly, ran };
}

/** 97.5th percentile of N(0,1) — the 95% two-sided z. Shared so the interval and the run-count math that
 *  INVERTS it can never drift apart (that drift is precisely how the top tier became unreachable). */
const Z95 = 1.959963984540054;
const Z95_SQ = Z95 * Z95;

/** Runaway guard for a pathological bar (robustMin → 1 diverges). The real cost bound is `shouldStop`. */
const ABSOLUTE_MAX_RUNS = 50_000;

/** How many ATTEMPTS a bar-aware run may spend to collect its target of usable samples. 3× tolerates a
 *  two-thirds error rate — far past any healthy box — while still terminating on a runner that errors on
 *  everything. Beyond this the report is honest: a large `errored` count and no tier awarded. */
const ERRORED_ATTEMPT_HEADROOM = 3;

/**
 * Clean runs needed before the Wilson-95% LOWER bound can even REACH `robustMin`.
 *
 * At a perfect sample (p̂ = 1) the Wilson lower bound collapses to n / (n + z²), so reaching R needs
 * n ≥ z²·R/(1−R). Concretely: R=0.99 → 381 runs, R=0.999 → 3838 runs.
 *
 * This is the number that makes a bar and a run cap NOT independent knobs. A cap below it does not make the
 * top tier expensive, it makes it unreachable at every setting — which is a promise the engine cannot keep.
 * Exported so a caller (or a test) can assert that relationship instead of rediscovering it.
 */
export function requiredRunsForBar(robustMin: number): number {
    // NaN/±Inf and any bar outside (0,1) fall back to the guard: a bar of 1.0 needs infinite samples.
    if (!Number.isFinite(robustMin) || robustMin <= 0 || robustMin >= 1) return ABSOLUTE_MAX_RUNS;
    return Math.ceil((Z95_SQ * robustMin) / (1 - robustMin));
}

/**
 * Is the tier already settled, whatever the remaining samples would say?
 *
 * The verdict grades the LOWER bound against two bars, so exactly three situations are decided:
 *   lower ≥ robustMin                          → robust; further samples cannot revoke it
 *   upper <  marginalMin                       → at-risk; the interval cannot climb into the marginal band
 *   lower ≥ marginalMin AND upper < robustMin   → the whole interval lies inside the marginal band
 * Anything else still straddles a bar — and straddling a bar is the one case where another sample buys
 * something. Note a flawless run (p̂ = 1) keeps `upper` pinned at 1, so it correctly never short-circuits to
 * "marginal": it must earn `lower ≥ robustMin` or run out of budget.
 */
function tierDecided(ci: { low: number; high: number }, bars: { robustMin: number; marginalMin: number }): boolean {
    if (ci.low >= bars.robustMin) return true;
    if (ci.high < bars.marginalMin) return true;
    return ci.low >= bars.marginalMin && ci.high < bars.robustMin;
}

/** Wilson score 95% interval for a binomial proportion (better than normal-approx at small n / extreme p). */
function wilson95(passed: number, n: number): { low: number; high: number } {
    if (n <= 0) return { low: 0, high: 1 };
    const z = Z95;
    const z2 = Z95_SQ;
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

/**
 * The profile applied when a caller names none. It is exported and used by BOTH halves on purpose: the
 * grader has always defaulted to 'consumer', so a RUN that resolves no bars while the GRADE silently
 * applies consumer bars reproduces the exact split this module exists to close — the sampler optimising
 * for one target while the verdict is scored against another. Resolve the default here, once.
 */
export const DEFAULT_ROBUSTNESS_PROFILE = 'consumer';

/** Yield bars per domain — DEFAULTS, configurable; customer/contract requirements override (Cpk 1.33 vs 1.67). */
export const ROBUSTNESS_PROFILES: Record<string, RobustnessBars> = {
    consumer: { robustMin: 0.99, marginalMin: 0.9, tempCornersC: [0, 25, 70] }, // general "capable" bar (≈ Cpk 1.33 / 4σ); commercial 0–70 °C
    automotive: { robustMin: 0.999, marginalMin: 0.99, tempCornersC: [-40, 25, 125] }, // safety/critical (≈ Cpk 1.67 / 5σ, IATF 16949); AEC-Q100 grade 1
    medical: { robustMin: 0.999, marginalMin: 0.99, tempCornersC: [-40, 25, 85] }, // industrial-equivalent -40–85 °C
};

/**
 * Resolve a profile name to bars, applying DEFAULT_ROBUSTNESS_PROFILE when it is absent or unknown.
 *
 * The single resolver both halves must go through. When the SAMPLER skipped this and the GRADER did not,
 * a caller who named no profile got a run tuned to no bar at all and a verdict scored against consumer
 * bars — the same sampler/verdict split as the original defect, only one layer up. Own-property lookup on
 * purpose: a name like "constructor" must fall back, not resolve to something off Object.prototype.
 */
export function barsForProfile(profileName?: string): RobustnessBars {
    const key =
        profileName && Object.hasOwn(ROBUSTNESS_PROFILES, profileName) ? profileName : DEFAULT_ROBUSTNESS_PROFILE;
    return ROBUSTNESS_PROFILES[key] ?? ROBUSTNESS_PROFILES[DEFAULT_ROBUSTNESS_PROFILE]!;
}

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
    profileName: string = DEFAULT_ROBUSTNESS_PROFILE,
): RobustnessVerdict {
    const bars = barsForProfile(profileName);
    const yld = typeof yieldReport?.yield === 'number' ? yieldReport.yield : null;
    const ci = yieldReport?.ci95 as { low?: number; high?: number } | undefined;
    const lo = typeof ci?.low === 'number' ? ci.low : null;
    const evaluated = typeof yieldReport?.evaluated === 'number' ? yieldReport.evaluated : null;
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

    // A zero-sample run is NOT a graded run. computeYield reports wilson95(0, 0) = {low: 0, high: 1} for an
    // empty denominator, and 0 is a perfectly valid number — so grading it produced "at-risk" for a batch in
    // which every variant failed to SPAWN. That inverts the engine's own rule that an infrastructure fault
    // must never read as a design fault, and it is the same mistake as the errored-variant exclusion, just at
    // the aggregate level. No samples ⇒ no verdict.
    const errored = typeof yieldReport?.errored === 'number' ? yieldReport.errored : null;
    if (lo === null || evaluated === null || evaluated <= 0) {
        const infraFailed = (errored ?? 0) > 0;
        return {
            tier: 'unknown',
            profile: profileName,
            yield: null,
            yieldLowerBound: null,
            evaluated,
            note: infraFailed
                ? `Robustness not assessed — all ${errored} Monte-Carlo variants failed to run (an infrastructure fault, NOT a design signal). Verified at NOMINAL component values only; re-run to obtain a tier.`
                : 'Robustness not assessed (no toleranced parts or no Monte-Carlo) — verified at NOMINAL component values only.',
        };
    }
    // `at-risk` must be EARNED, not inferred from a wide interval. It is the one tier that gates — it flips
    // /verify-design to `fail` — so awarding it on evidence that has not actually ruled out the marginal bar
    // FALSE-FAILS a correct design, the one thing this engine promises never to do. Ten flawless variants
    // give a lower bound of 0.72 (10/(10+z²)) which is under marginalMin 0.9: before this guard, a design
    // that failed nothing was called a design fault. Require the UPPER bound to be below the bar — the same
    // "is the tier decided?" test the sampler uses in tierDecided, so the two halves cannot disagree again.
    // An interval that still straddles the bar is `unknown`: not assessed, and `unknown` never gates.
    const hi = typeof ci?.high === 'number' ? ci.high : 1;
    const tier: RobustnessTier =
        lo >= bars.robustMin
            ? 'robust'
            : lo >= bars.marginalMin
              ? 'marginal'
              : hi < bars.marginalMin
                ? 'at-risk'
                : 'unknown';

    if (tier === 'unknown') {
        return {
            tier,
            profile: profileName,
            yield: yld,
            yieldLowerBound: lo,
            evaluated,
            note:
                `Not assessed — ${evaluated} variant(s) is too small a sample to place this design: the 95% interval ` +
                `[${pct(lo)}, ${pct(hi)}] still spans the ${pct(bars.marginalMin)} bar, so the data neither clears nor ` +
                `condemns it. Re-run with more variants (about ${requiredRunsForBar(bars.robustMin)} clean runs earn the ` +
                `top tier for this profile). NOT a design fault — no verdict is gated on this.`,
        };
    }
    const tail = `(component-tolerance Monte-Carlo, ${evaluated ?? '?'} runs; ~${pct(lo)} is the 95% lower bound; short-term, not long-term-drift-adjusted)`;

    // A short run and a genuinely marginal design produce the SAME tier but need OPPOSITE actions, and the
    // interval already separates them: while the UPPER bound still sits at/above the bar, the data has not
    // ruled out `robust` — the missing ingredient is samples, not part quality. Telling that user to buy ±1%
    // parts sends them to spend money on a statistics artefact. Only advise tightening once the upper bound
    // has fallen below the bar, i.e. the design itself cannot reach it.
    const sampleLimited = hi >= bars.robustMin;
    const needed = requiredRunsForBar(bars.robustMin);
    const marginalNote = sampleLimited
        ? `Undecided — ~${pct(lo)} is only the 95% LOWER bound and the run was too short to reach the ${pct(bars.robustMin)} bar; the data has not ruled out "robust". Re-run with more variants (about ${needed} clean runs are needed for this bar) before changing the design ${tail}.`
        : `Marginal — ~${pct(lo)} expected yield, below the ${pct(bars.robustMin)} production bar. Tighten component tolerances (e.g. ±1% parts) or re-center values ${tail}.`;

    const note =
        tier === 'robust'
            ? `Robust — at least ${pct(bars.robustMin)} of units expected to meet spec under component tolerances ${tail}.`
            : tier === 'marginal'
              ? marginalNote
              : `At risk — only ~${pct(lo)} expected yield; passes at nominal but is NOT production-robust ${tail}.`;
    return { tier, profile: profileName, yield: yld, yieldLowerBound: lo, evaluated, note };
}
