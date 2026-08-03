/**
 * Worst-case (corner) analysis — the third robustness lens, alongside Monte-Carlo (montecarlo.ts, RANDOM
 * tolerance draws) and the parametric sweep (sweep.ts, one parameter over a RANGE). Worst-case asks the
 * strongest question: does the design still meet spec at the DETERMINISTIC tolerance EXTREMES — every
 * toleranced component simultaneously at its ±tol corner? Random Monte-Carlo can MISS the true worst corner
 * (it samples the interior far more than the 2^k corners); worst-case hits them exactly, which is why NI
 * Multisim ships it as a distinct analysis next to Monte-Carlo.
 *
 * Assumes the output is MONOTONIC in each toleranced parameter over its ±tol band (so the extreme lives at a
 * corner) — the standard worst-case "what-if" assumption. Exponential in the number of cornered components
 * (2^k), so the set is capped (default 8 → ≤256 corners); a caller with more toleranced parts should pre-select
 * the most influential ones (e.g. by `.sens` sensitivity) and pass them in `spec.components`.
 *
 * Pure + deterministic: no ngspice. The 2^k simulations + criteria evaluation happen in the injected
 * `runVariant` (worker supplies real ngspice; tests supply a fake), mirroring montecarlo.ts / sweep.ts.
 */
import { evaluateAssertions, type AcceptanceCriterion } from './analysis/assertions';
import type { SimMeasurement } from './analysis/measurements';
import type { VariantRunner } from './montecarlo';
import { buildProbeResolver } from './netlist/probe-map';
import type { CircuitJson, Component } from './types/circuit';
import { parseComponentMagnitude } from './utils/unit-parser';

/** Which extreme of a component's ±tolerance band a given corner puts it at. */
export type CornerSide = 'lo' | 'hi';

export interface CornerSpec {
    /** Designators to corner at their ±tolerance extremes. When omitted, ALL components that declare a positive
     *  tolerance and a numeric value are cornered (capped by maxComponents). Names are matched case-insensitively;
     *  a listed component with no tolerance / non-numeric value is skipped. */
    components?: string[];
    /** Hard cap on how many components are cornered (⇒ ≤ 2^cap corners). Default 8 (≤256). If more toleranced
     *  components qualify than this, the first `cap` (in circuit order) are cornered and the rest are reported
     *  in `omitted` — a caller that wants the MOST INFLUENTIAL ones should pre-rank (e.g. via `.sens`). */
    maxComponents?: number;
}

/** One evaluated corner: the ±side each cornered component sat at + how the acceptance criteria fared there. */
export interface CornerPoint {
    /** designator → which extreme it was set to for this corner. */
    corner: Record<string, CornerSide>;
    /** 'pass' = all criteria held; 'fail' = at least one didn't; 'errored' = the corner could not be run. */
    outcome: 'pass' | 'fail' | 'errored';
}

export interface WorstCaseResult {
    /** Designators actually cornered (after tolerance/numeric filtering + the maxComponents cap). */
    componentsCornered: string[];
    /** Toleranced components NOT cornered because the cap was hit — surfaced so "passes all corners" is honest. */
    omitted: string[];
    /** Every corner run, in enumeration order. */
    points: CornerPoint[];
    evaluated: number;
    passed: number;
    failed: number;
    errored: number;
    /** True iff at least one corner was evaluated AND every evaluated corner passed AND none errored AND no
     *  toleranced component was omitted by the cap — i.e. a real "meets spec at every worst-case corner". */
    passAllCorners: boolean;
    /** The corners that FAILED — the actionable "it breaks when R1 is high and C1 is low". */
    worstCorners: Array<Record<string, CornerSide>>;
}

interface Toleranced {
    component: Component;
    nominal: number;
    /** Re-emit a cornered magnitude in the component value's original form (keyword prefix + unit preserved). */
    rebuild: (v: number) => string;
    tol: number;
}

/** Components that declare a positive tolerance AND a parseable non-zero magnitude (R/C/L value or a
 *  `DC`/`AC` source magnitude, incl. negative rails); optionally filtered to a caller-supplied designator
 *  list. Order follows the circuit (deterministic). */
function tolerancedComponents(circuit: CircuitJson, only?: string[]): Toleranced[] {
    const wanted = only?.map((d) => d.toUpperCase());
    const out: Toleranced[] = [];
    for (const c of circuit.components) {
        if (!c.tolerance || c.tolerance <= 0 || !c.value) continue;
        if (wanted && !(c.designator && wanted.includes(c.designator.toUpperCase()))) continue;
        const mag = parseComponentMagnitude(c.value);
        if (!mag) continue;
        out.push({ component: c, nominal: mag.value, rebuild: mag.rebuild, tol: c.tolerance });
    }
    return out;
}

/**
 * Build the 2^k corner variants: each cornered component set to nominal·(1−tol) ['lo'] or nominal·(1+tol) ['hi'],
 * all combinations enumerated. Returns `{ corner, circuit }[]`; empty when no component qualifies. The `omitted`
 * designators (dropped by the cap) are returned alongside so the caller can report an honest verdict.
 */
export function cornerVariants(
    circuit: CircuitJson,
    spec: CornerSpec = {},
): {
    variants: Array<{ corner: Record<string, CornerSide>; circuit: CircuitJson }>;
    componentsCornered: string[];
    omitted: string[];
} {
    const cap = Math.max(1, spec.maxComponents ?? 8);
    const all = tolerancedComponents(circuit, spec.components);
    const cornered = all.slice(0, cap);
    const omitted = all
        .slice(cap)
        .map((t) => t.component.designator)
        .filter(Boolean);
    const componentsCornered = cornered.map((t) => t.component.designator).filter(Boolean);
    if (cornered.length === 0) return { variants: [], componentsCornered, omitted };

    const k = cornered.length;
    const variants: Array<{ corner: Record<string, CornerSide>; circuit: CircuitJson }> = [];
    for (let mask = 0; mask < 1 << k; mask++) {
        const corner: Record<string, CornerSide> = {};
        const overrides = new Map<Component, string>();
        for (let i = 0; i < k; i++) {
            const t = cornered[i]!;
            const hi = (mask & (1 << i)) !== 0;
            corner[t.component.designator] = hi ? 'hi' : 'lo';
            overrides.set(t.component, t.rebuild(t.nominal * (hi ? 1 + t.tol : 1 - t.tol)));
        }
        variants.push({
            corner,
            circuit: {
                ...circuit,
                components: circuit.components.map((c) => (overrides.has(c) ? { ...c, value: overrides.get(c)! } : c)),
            },
        });
    }
    return { variants, componentsCornered, omitted };
}

/**
 * Orchestrate a worst-case corner run: evaluate the acceptance criteria at every ±tolerance corner, aggregate
 * pass/fail/errored (three-way, errored ≠ fail, as in Monte-Carlo/sweep), and report `passAllCorners` plus the
 * failing corners. Pure/deterministic given `runVariant`.
 */
export async function runWorstCase(
    circuit: CircuitJson,
    criteria: AcceptanceCriterion[],
    spec: CornerSpec,
    runVariant: VariantRunner,
): Promise<WorstCaseResult> {
    const { variants, componentsCornered, omitted } = cornerVariants(circuit, spec);
    // ONE resolver for the whole batch. Variants rewrite component VALUES; the nets and the component
    // TYPES they are wired with are identical across every one of them, and those are what the mapping
    // is derived from. Rebuilding it per variant would re-plan the digital bridge N times for an answer
    // that cannot differ — at N=100 that is the expensive part of a loop whose real work is elsewhere.
    const resolver = buildProbeResolver(circuit);
    const points: CornerPoint[] = [];
    for (let i = 0; i < variants.length; i++) {
        const { corner, circuit: variant } = variants[i]!;
        let measurements: SimMeasurement[] | null;
        try {
            measurements = await runVariant(variant, i);
        } catch {
            measurements = null; // a thrown runner = this corner could not be run → errored
        }
        if (!measurements) {
            points.push({ corner, outcome: 'errored' });
            continue;
        }
        const results = evaluateAssertions(measurements, criteria, true, resolver);
        const pass = results.length > 0 && results.every((r) => r.pass);
        points.push({ corner, outcome: pass ? 'pass' : 'fail' });
    }

    const evaluated = points.filter((p) => p.outcome !== 'errored').length;
    const passed = points.filter((p) => p.outcome === 'pass').length;
    const failed = points.filter((p) => p.outcome === 'fail').length;
    const errored = points.length - evaluated;
    // A real worst-case guarantee needs EVERY corner evaluated + passing AND nothing omitted by the cap.
    const passAllCorners = evaluated > 0 && failed === 0 && errored === 0 && omitted.length === 0;

    return {
        componentsCornered,
        omitted,
        points,
        evaluated,
        passed,
        failed,
        errored,
        passAllCorners,
        worstCorners: points.filter((p) => p.outcome === 'fail').map((p) => p.corner),
    };
}
