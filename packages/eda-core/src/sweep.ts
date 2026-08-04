/**
 * Parametric sweep (`.step`-style) — the DETERMINISTIC sibling of the Monte-Carlo yield engine (montecarlo.ts).
 *
 * Monte-Carlo answers "what fraction of RANDOM real-world builds pass?"; a parametric sweep answers the
 * complementary, deterministic question "over what RANGE of a chosen parameter does the design still meet the
 * spec?" — e.g. sweep R1 from 1k to 100k and report the sub-range where the −3 dB cutoff / gain / THD criterion
 * still holds. ngspice has NO native `.step` (it is emulated by looping in the control language), so — exactly
 * like our MC engine — we generate the variants here and the caller (worker) runs each one, reusing the same
 * one-job-dir batch machinery.
 *
 * Pure + deterministic: no ngspice, no I/O. The N simulations + criteria evaluation happen in the injected
 * `runVariant` (the worker supplies real ngspice; tests supply a fake), so this orchestrator stays testable.
 */
import { evaluateAssertions, type AcceptanceCriterion } from './analysis/assertions';
import type { SimMeasurement } from './analysis/measurements';
import type { VariantRunner } from './montecarlo';
import { buildProbeResolver } from './netlist/probe-map';
import type { CircuitJson } from './types/circuit';
import { parseSpiceValue, formatSpiceValue } from './utils/unit-parser';

/** How the swept values are chosen. Either an explicit `values` list OR a generated `start`/`stop` range. */
export interface SweepSpec {
    /** Designator of the component whose VALUE is swept, e.g. "R1" (case-insensitive). */
    designator: string;
    /** Explicit sweep values — numbers are formatted in the component's existing SPICE unit (Ω/F/H); strings are
     *  used verbatim as SPICE values. Takes precedence over the range fields. */
    values?: Array<number | string>;
    /** OR a generated range (inclusive). Requires `points` ≥ 2 and a positive span. */
    start?: number;
    stop?: number;
    /** Number of points across [start, stop] (≥ 2). */
    points?: number;
    /** Range spacing: 'lin' (default) evenly in value, 'dec' evenly in log10 (needs start,stop > 0). */
    scale?: 'lin' | 'dec';
}

/** One swept point: the value applied to the component + how the acceptance criteria fared there. */
export interface SweepPoint {
    /** The swept value as a SPICE string (what was written into the netlist), e.g. "10k". */
    value: string;
    /** Numeric magnitude in SI base units (for plotting / range math); null when the value is non-numeric. */
    numeric: number | null;
    /** 'pass' = all criteria held; 'fail' = at least one didn't; 'errored' = the variant could not be run. */
    outcome: 'pass' | 'fail' | 'errored';
}

export interface SweepResult {
    /** The component designator that was swept. */
    parameter: string;
    /** Points actually run, in sweep order. */
    points: SweepPoint[];
    /** Points that ran and were evaluated (pass + fail) — the denominator for passAll. */
    evaluated: number;
    passed: number;
    failed: number;
    /** Points whose sim could not be run (infra/spawn) — excluded from passAll, surfaced honestly. */
    errored: number;
    /** True when at least one point was evaluated AND every evaluated point passed (no fails). Errored points
     *  do NOT count as pass — but they also don't force a false fail; `errored > 0` is surfaced separately. */
    passAll: boolean;
    /** The contiguous numeric sub-range [lo, hi] over which every point passed, when the swept values are
     *  numeric and monotonic — the actionable "spec holds for <param> ∈ [lo, hi]". Undefined when there is no
     *  passing run, the values are non-numeric, or passing points are not contiguous (reported via `points`). */
    passRange?: { lo: number; hi: number };
}

/** Resolve the concrete list of swept values (SPICE strings) from a spec, given the target's current unit. */
function resolveSweepValues(spec: SweepSpec, unit: string): string[] {
    if (spec.values && spec.values.length > 0) {
        return spec.values.map((v) => (typeof v === 'number' ? formatSpiceValue(v, unit) : v));
    }
    const { start, stop, points, scale = 'lin' } = spec;
    if (start === undefined || stop === undefined || !points || points < 2) return [];
    const out: number[] = [];
    if (scale === 'dec') {
        if (!(start > 0) || !(stop > 0)) return []; // log spacing needs positive endpoints
        const a = Math.log10(start);
        const b = Math.log10(stop);
        for (let i = 0; i < points; i++) out.push(10 ** (a + ((b - a) * i) / (points - 1)));
    } else {
        for (let i = 0; i < points; i++) out.push(start + ((stop - start) * i) / (points - 1));
    }
    return out.map((v) => formatSpiceValue(v, unit));
}

/**
 * Build the swept circuit variants: clone the circuit once per swept value, overriding the target component's
 * `value` (unit preserved). Returns `[]` when the designator matches no component (the caller reports it as a
 * non-runnable sweep rather than silently sweeping nothing).
 */
export function sweepVariants(circuit: CircuitJson, spec: SweepSpec): Array<{ value: string; circuit: CircuitJson }> {
    const target = circuit.components.find(
        (c) => c.designator && c.designator.toUpperCase() === spec.designator.toUpperCase(),
    );
    if (!target) return [];
    const unit = target.value ? parseSpiceValue(target.value).unit || '' : '';
    const values = resolveSweepValues(spec, unit);
    return values.map((value) => ({
        value,
        circuit: {
            ...circuit,
            components: circuit.components.map((c) => (c === target ? { ...c, value } : c)),
        },
    }));
}

/**
 * Orchestrate a parametric sweep: for each swept value, run the variant (injected), evaluate the acceptance
 * criteria, and record pass/fail/errored — then aggregate `passAll` + the contiguous passing `passRange`.
 * Mirrors runMonteCarlo's three-way accounting (errored ≠ fail). Pure/deterministic given `runVariant`.
 */
export async function runParametricSweep(
    circuit: CircuitJson,
    criteria: AcceptanceCriterion[],
    spec: SweepSpec,
    runVariant: VariantRunner,
): Promise<SweepResult> {
    const variants = sweepVariants(circuit, spec);
    // ONE resolver for the whole batch. Variants rewrite component VALUES; the nets and the component
    // TYPES they are wired with are identical across every one of them, and those are what the mapping
    // is derived from. Rebuilding it per variant would re-plan the digital bridge N times for an answer
    // that cannot differ — at N=100 that is the expensive part of a loop whose real work is elsewhere.
    const resolver = buildProbeResolver(circuit);
    const points: SweepPoint[] = [];
    for (let i = 0; i < variants.length; i++) {
        const { value, circuit: variant } = variants[i]!;
        const parsed = parseSpiceValue(value);
        const numeric = parsed.isValid ? parsed.value : null;
        let measurements: SimMeasurement[] | null;
        try {
            measurements = await runVariant(variant, i);
        } catch {
            measurements = null; // a thrown runner = the point could not be run → errored
        }
        if (!measurements) {
            points.push({ value, numeric, outcome: 'errored' });
            continue;
        }
        const results = evaluateAssertions(measurements, criteria, true, resolver);
        const pass = results.length > 0 && results.every((r) => r.pass);
        points.push({ value, numeric, outcome: pass ? 'pass' : 'fail' });
    }

    const evaluated = points.filter((p) => p.outcome !== 'errored').length;
    const passed = points.filter((p) => p.outcome === 'pass').length;
    const failed = points.filter((p) => p.outcome === 'fail').length;
    const errored = points.length - evaluated;
    const passAll = evaluated > 0 && failed === 0 && errored === 0;

    return {
        parameter: spec.designator,
        points,
        evaluated,
        passed,
        failed,
        errored,
        passAll,
        ...(computePassRange(points) ? { passRange: computePassRange(points)! } : {}),
    };
}

/** The contiguous numeric [lo, hi] over which every point passed — the actionable "spec holds for x ∈ [lo,hi]".
 *  Undefined unless there is at least one passing point, all points are numeric, and the passing points form a
 *  single contiguous block (a broken/interior-fail pattern is left to the per-point `points` list). */
function computePassRange(points: SweepPoint[]): { lo: number; hi: number } | undefined {
    if (points.length === 0 || points.some((p) => p.numeric === null)) return undefined;
    const firstPass = points.findIndex((p) => p.outcome === 'pass');
    if (firstPass === -1) return undefined;
    let lastPass = firstPass;
    for (let i = firstPass; i < points.length; i++) {
        if (points[i]!.outcome === 'pass') lastPass = i;
        else break; // contiguity ends at the first non-pass after the passing block
    }
    // If any pass exists AFTER the contiguous block, the passing region is non-contiguous → don't summarize.
    for (let i = lastPass + 1; i < points.length; i++) {
        if (points[i]!.outcome === 'pass') return undefined;
    }
    const lo = points[firstPass]!.numeric!;
    const hi = points[lastPass]!.numeric!;
    return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
}
