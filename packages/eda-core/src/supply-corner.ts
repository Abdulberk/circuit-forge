/**
 * Supply-voltage corner analysis — does the spec still hold when the SUPPLY varies (e.g. ±5%)? Unlike the
 * tolerance corner (component ±tol) and temperature corner (ambient), this perturbs the DRIVING SOURCE of each
 * power rail and re-simulates, so the circuit responds NATURALLY (a regulator/LDO does its real regulation) —
 * we never force a rail node to a value, which would ignore the regulator (the "don't dictate the wrong value"
 * discipline). Rail voltages are MEASURED from the run, never read off a source's face value.
 *
 * TWO honest primitives sit under it, both grounded in how KiCad/Altium actually work (designer-declares →
 * tool-validates):
 *   1. `validatePowerRails` — a mini-ERC over the AI/user's `isPower` DECLARATION, with a strict
 *      REFUTATION-ASYMMETRY: structural evidence that CONFIRMS trusts it; evidence that is merely ABSENT still
 *      trusts it (a single-consumer LDO rail is legitimate — absence of corroboration is not contradiction);
 *      only evidence that CONTRADICTS (also-ground / no DC driver / ambiguous multi-driver) DEFERS. Collapsing
 *      "no evidence" into "reject" would drown common single-IC rails and the check would never run.
 *   2. `runSupplyCorner` — perturbs each trusted rail's driving source ±tolerance and reports pass/fail +
 *      per-node drift vs. the NOMINAL run (the reference — the rail's "should-be" value comes from the
 *      unperturbed .op, not a perturbed one). INFORMATIONAL: the caller never gates the verdict on it.
 *
 * Pure + deterministic given the injected `runVariant` (worker supplies real ngspice; tests a fake), mirroring
 * corner.ts / montecarlo.ts / tempcorner.ts. Reuses the SAME variant runner as those (a supply corner is a
 * component-VALUE perturbation on the source, exactly what the variant runner already does).
 */
import { evaluateAssertions, type AcceptanceCriterion } from './analysis/assertions';
import type { SimMeasurement } from './analysis/measurements';
import type { VariantRunner } from './montecarlo';
import type { CircuitJson, Component } from './types/circuit';
import { parseComponentMagnitude } from './utils/unit-parser';

/** The DC (steady-supply) magnitude of a source value, else null. Handles every source form our circuits use:
 *  "DC 12" → 12; a BARE number "5" → 5 (SPICE treats a bare source value as DC); "DC 0 AC 1" → 0; "AC 1" → null
 *  and "PULSE(…)"/"SIN(…)" → null (a stimulus/signal source has no steady DC supply, so it is NOT a power driver).
 *  (/i already matches an 'E' exponent.) */
function dcMagnitude(value: string | undefined): number | null {
    const v = (value ?? '').trim();
    const dc = /(?:^|\s)DC\s+([+-]?\d*\.?\d+(?:e[+-]?\d+)?)/i.exec(v);
    if (dc) return Math.abs(Number.parseFloat(dc[1] ?? ''));
    // No explicit DC keyword: a LEADING bare number is a DC source value; anything led by AC/PULSE/SIN/… is not.
    const bare = /^[+-]?\d*\.?\d+(?:e[+-]?\d+)?/i.exec(v);
    return bare ? Math.abs(Number.parseFloat(bare[0])) : null;
}

interface RailWalk {
    visited: Set<string>;
    queue: string[];
    drivers: Component[];
    seen: Set<string>;
}

/** Process every component touching `net`: collect a DC-driving voltage source, else enqueue its other nets. */
function walkNetForDrivers(circuit: CircuitJson, net: string, w: RailWalk): void {
    for (const c of circuit.components) {
        if (!c.pins.some((p) => p.netId === net)) continue;
        if (c.type === 'voltage_source') {
            const mag = dcMagnitude(c.value);
            if (mag !== null && mag > 0 && c.designator && !w.seen.has(c.designator)) {
                w.seen.add(c.designator);
                w.drivers.push(c);
            }
            continue; // never traverse THROUGH a source
        }
        for (const p of c.pins) {
            if (!w.visited.has(p.netId)) {
                w.visited.add(p.netId);
                w.queue.push(p.netId);
            }
        }
    }
}

/**
 * The DC power source(s) that drive `netId`, by walking the topology FROM the net through non-source components
 * (NEVER through ground) to reachable voltage sources with a NON-ZERO DC magnitude. This is the same walk the
 * smoke-test validated: it isolates the rail's own power domain, so a signal source or a different rail's source
 * on a separate branch is never reached. Deterministic (circuit order).
 */
export function driversOf(circuit: CircuitJson, netId: string): Component[] {
    const gnd = new Set(circuit.nets.filter((n) => n.isGround).map((n) => n.id));
    const w: RailWalk = {
        visited: new Set<string>([netId, ...gnd]),
        queue: [netId],
        drivers: [],
        seen: new Set<string>(),
    };
    for (let net = w.queue.shift(); net !== undefined; net = w.queue.shift()) walkNetForDrivers(circuit, net, w);
    return w.drivers;
}

export type RailStatus = 'trusted' | 'deferred';
export interface RailValidation {
    netId: string;
    status: RailStatus;
    /** the single DC source that drives this rail (present when trusted) — what the supply corner perturbs. */
    driverDesignator?: string;
    /** why it was deferred (contradiction / ambiguity) — surfaced in the manifest so a deferral is never silent. */
    reason?: string;
}

/**
 * Validate each `isPower` net against the topology with the REFUTATION-ASYMMETRY (see file header). Trusted iff a
 * single DC source unambiguously drives it. Deferred (with a reason) iff it is ALSO ground, NO DC source drives it
 * (a reference/bias/floating net wrongly marked), or MORE THAN ONE candidate source drives it (ambiguous — don't
 * guess THE supply). A single consumer is NOT a rejection.
 */
export function validatePowerRails(circuit: CircuitJson): RailValidation[] {
    return circuit.nets
        .filter((n) => n.isPower)
        .map((n): RailValidation => {
            if (n.isGround)
                return { netId: n.id, status: 'deferred', reason: 'marked isPower but ALSO isGround — contradictory' };
            const drivers = driversOf(circuit, n.id);
            if (drivers.length === 0) {
                return {
                    netId: n.id,
                    status: 'deferred',
                    reason: 'no DC power source drives this net — marked isPower but structurally not power-driven (a reference/bias net, or floating)',
                };
            }
            if (drivers.length > 1) {
                return {
                    netId: n.id,
                    status: 'deferred',
                    reason: `ambiguous — ${drivers.length} candidate driving sources (${drivers.map((d) => d.designator).join(', ')}); cannot pick THE supply without guessing`,
                };
            }
            // Evidence CONFIRMS or is merely ABSENT (single consumer, indirect drive) → TRUST the declaration,
            // exactly as a tool trusts a designer-placed power symbol. Only contradiction (above) defers.
            return { netId: n.id, status: 'trusted', driverDesignator: drivers[0]!.designator };
        });
}

export interface SupplyCornerSpec {
    /** Fractional supply tolerance to sweep, e.g. 0.05 = ±5%. */
    tolerance: number;
    /** Human label (e.g. "±5%"). */
    rangeLabel?: string;
    /** Cap on cornered drivers (⇒ ≤ 2^cap corners). Default 6 (≤64). */
    maxDrivers?: number;
}

export interface SupplyCornerPoint {
    /** driver designator → which supply extreme it sat at for this corner. */
    corner: Record<string, 'lo' | 'hi'>;
    outcome: 'pass' | 'fail' | 'no-limit' | 'errored';
}

/** Per-node voltage drift across the supply corners, measured against the NOMINAL run. */
export interface SupplyDrift {
    node: string;
    nominalValue: number;
    worstValue: number;
    worstCorner: Record<string, 'lo' | 'hi'>;
    deltaAbs: number;
    deltaPct: number;
}

export interface SupplyCornerResult {
    /** False when NO rail is trusted (no perturbable supply) — the run is not-applicable, never "passed". */
    applicable: boolean;
    /** EVERY isPower net + its validation status — a deferred rail's reason is visible here, never silently dropped. */
    rails: RailValidation[];
    /** trusted drivers dropped by the maxDrivers cap (honest "not every supply was cornered"). */
    omitted: string[];
    tolerance: number;
    rangeLabel?: string;
    points: SupplyCornerPoint[];
    evaluated: number;
    passed: number;
    failed: number;
    errored: number;
    hasLimits: boolean;
    passAllCorners: boolean;
    drift: SupplyDrift[];
}

interface SupplyDriver {
    component: Component;
    nominal: number;
    rebuild: (v: number) => string;
}

/** The trusted rails' driving sources (deduped — two rails can share one source), capped. */
function supplyDrivers(
    circuit: CircuitJson,
    rails: RailValidation[],
    cap: number,
): { drivers: SupplyDriver[]; omitted: string[] } {
    const byDesignator = new Map<string, Component>();
    for (const c of circuit.components) if (c.designator) byDesignator.set(c.designator, c);
    const seen = new Set<string>();
    const all: SupplyDriver[] = [];
    for (const r of rails) {
        if (r.status !== 'trusted' || !r.driverDesignator || seen.has(r.driverDesignator)) continue;
        const c = byDesignator.get(r.driverDesignator);
        if (!c?.value) continue;
        const mag = parseComponentMagnitude(c.value);
        if (!mag) continue;
        seen.add(r.driverDesignator);
        all.push({ component: c, nominal: mag.value, rebuild: mag.rebuild });
    }
    return {
        drivers: all.slice(0, cap),
        omitted: all
            .slice(cap)
            .map((d) => d.component.designator)
            .filter(Boolean),
    };
}

/** The reference (all-nominal) circuit + the 2^k ±tolerance supply corners. corner:null marks the nominal run. */
function supplyVariants(
    circuit: CircuitJson,
    drivers: SupplyDriver[],
    tol: number,
): Array<{ corner: Record<string, 'lo' | 'hi'> | null; circuit: CircuitJson }> {
    const variants: Array<{ corner: Record<string, 'lo' | 'hi'> | null; circuit: CircuitJson }> = [
        { corner: null, circuit },
    ];
    const k = drivers.length;
    for (let mask = 0; mask < 1 << k; mask++) {
        const corner: Record<string, 'lo' | 'hi'> = {};
        const overrides = new Map<Component, string>();
        for (let i = 0; i < k; i++) {
            const d = drivers[i]!;
            const hi = (mask & (1 << i)) !== 0;
            corner[d.component.designator] = hi ? 'hi' : 'lo';
            overrides.set(d.component, d.rebuild(d.nominal * (hi ? 1 + tol : 1 - tol)));
        }
        variants.push({
            corner,
            circuit: {
                ...circuit,
                components: circuit.components.map((c) => (overrides.has(c) ? { ...c, value: overrides.get(c)! } : c)),
            },
        });
    }
    return variants;
}

const scalarOf = (m: SimMeasurement): number | undefined => {
    const v = m.raw?.final ?? m.final;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

type WorstMap = Map<string, { value: number; corner: Record<string, 'lo' | 'hi'> }>;

/** Record the largest per-node deviation from the NOMINAL reference seen at any corner. */
function trackWorst(
    measurements: SimMeasurement[],
    corner: Record<string, 'lo' | 'hi'>,
    nominal: Map<string, number>,
    worst: WorstMap,
): void {
    for (const m of measurements) {
        const v = scalarOf(m);
        if (v === undefined) continue;
        const ref = nominal.get(m.node);
        if (ref === undefined) continue;
        const prev = worst.get(m.node);
        if (!prev || Math.abs(v - ref) > Math.abs(prev.value - ref)) worst.set(m.node, { value: v, corner });
    }
}

/** One corner's outcome from the CRITERIA's OWN metrics (evaluateAssertions) — never from the drift scalar. */
function cornerOutcome(
    measurements: SimMeasurement[] | null,
    corner: Record<string, 'lo' | 'hi'>,
    criteria: AcceptanceCriterion[],
    nets: CircuitJson['nets'],
    hasLimits: boolean,
): SupplyCornerPoint {
    if (!measurements) return { corner, outcome: 'errored' };
    if (!hasLimits) return { corner, outcome: 'no-limit' };
    const results = evaluateAssertions(measurements, criteria, true, nets);
    const pass = results.length > 0 && results.every((r) => r.pass);
    return { corner, outcome: pass ? 'pass' : 'fail' };
}

/** Per-node drift across corners vs the nominal reference, largest %-drift first (abs tiebreak for ~0 baselines). */
function computeSupplyDrift(nominal: Map<string, number>, worst: WorstMap): SupplyDrift[] {
    const drift: SupplyDrift[] = [];
    for (const [node, nominalValue] of nominal) {
        const w = worst.get(node);
        if (!w) continue;
        const deltaAbs = w.value - nominalValue;
        const deltaPct = Math.abs(nominalValue) > 1e-12 ? (Math.abs(deltaAbs) / Math.abs(nominalValue)) * 100 : 0;
        drift.push({ node, nominalValue, worstValue: w.value, worstCorner: w.corner, deltaAbs, deltaPct });
    }
    drift.sort((a, b) => b.deltaPct - a.deltaPct || Math.abs(b.deltaAbs) - Math.abs(a.deltaAbs));
    return drift;
}

/** Capture the nominal (unperturbed) run's per-node values — the drift reference. */
function captureNominal(measurements: SimMeasurement[] | null, nominal: Map<string, number>): void {
    if (!measurements) return;
    for (const m of measurements) {
        const v = scalarOf(m);
        if (v !== undefined) nominal.set(m.node, v);
    }
}

/** Three-way tally (errored ≠ fail); evaluated = pass + fail. */
function tallyOutcomes(points: SupplyCornerPoint[]): {
    evaluated: number;
    passed: number;
    failed: number;
    errored: number;
} {
    const passed = points.filter((p) => p.outcome === 'pass').length;
    const failed = points.filter((p) => p.outcome === 'fail').length;
    const errored = points.filter((p) => p.outcome === 'errored').length;
    return { evaluated: passed + failed, passed, failed, errored };
}

/**
 * Orchestrate a supply-voltage corner run: perturb every trusted rail's driving source ±tolerance, evaluate the
 * criteria, and report per-node drift vs. the NOMINAL (unperturbed) run — the reference. Pure/deterministic given
 * `runVariant`. Never throws — a corner the runner can't evaluate is `errored` (three-way, errored ≠ fail).
 */
export async function runSupplyCorner(
    circuit: CircuitJson,
    criteria: AcceptanceCriterion[],
    spec: SupplyCornerSpec,
    runVariant: VariantRunner,
): Promise<SupplyCornerResult> {
    const rails = validatePowerRails(circuit);
    const hasLimits = criteria.length > 0;
    const cap = Math.max(1, spec.maxDrivers ?? 6);
    const { drivers, omitted } = supplyDrivers(circuit, rails, cap);

    const base = { rails, omitted, tolerance: spec.tolerance, rangeLabel: spec.rangeLabel, hasLimits };
    if (drivers.length === 0) {
        // No trusted, perturbable supply → not-applicable. rails[] still carries each deferral's reason (visible).
        return {
            applicable: false,
            ...base,
            points: [],
            evaluated: 0,
            passed: 0,
            failed: 0,
            errored: 0,
            passAllCorners: false,
            drift: [],
        };
    }

    const variants = supplyVariants(circuit, drivers, spec.tolerance);
    const points: SupplyCornerPoint[] = [];
    const nominal = new Map<string, number>(); // node → nominal-run value (the drift reference)
    const worst = new Map<string, { value: number; corner: Record<string, 'lo' | 'hi'> }>();

    for (let i = 0; i < variants.length; i++) {
        const { corner, circuit: variant } = variants[i]!;
        let measurements: SimMeasurement[] | null;
        try {
            measurements = await runVariant(variant, i);
        } catch {
            measurements = null;
        }
        if (corner === null) {
            // NOMINAL reference run (index 0): runs FIRST so trackWorst below has its reference. A failed
            // reference leaves drift empty (honest) but corners still evaluate pass/fail.
            captureNominal(measurements, nominal);
            continue;
        }
        if (measurements) trackWorst(measurements, corner, nominal, worst);
        points.push(cornerOutcome(measurements, corner, criteria, circuit.nets, hasLimits));
    }

    const { evaluated, passed, failed, errored } = tallyOutcomes(points);
    const passAllCorners = hasLimits && evaluated > 0 && failed === 0 && errored === 0 && omitted.length === 0;

    return {
        applicable: true,
        ...base,
        points,
        evaluated,
        passed,
        failed,
        errored,
        passAllCorners,
        drift: computeSupplyDrift(nominal, worst),
    };
}
