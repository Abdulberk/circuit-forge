/**
 * Temperature-corner analysis — the AMBIENT-temperature sibling of the tolerance corner (corner.ts) and
 * Monte-Carlo (montecarlo.ts). It re-evaluates the acceptance criteria AND captures per-node metric drift
 * across a small ambient-temperature set (cold / room / hot, taken from the robustness profile), each run
 * emitted as a `.temp <T>` card by the generator.
 *
 * AMBIENT ONLY (the honest ceiling): a `.temp` run recomputes device-model temperature physics (semiconductor
 * IS/BF/mobility drift) at ONE uniform temperature. It does NOT model self-heating — junction-temperature rise
 * Tj = Ta + P·Rth, electro-thermal feedback, and θ-JA derating are OUT OF SCOPE (they need a parts thermal DB
 * that does not exist here). The manifest discloses this via gradation:'presence'; see robustnessManifestEntry.
 *
 * Passive-only circuits (no diode/BJT/MOSFET/JFET) are temperature-FLAT here — the generator emits no TC1/TC2
 * tempco — so the run is a physical no-op: reported `applicable:false` (not-applicable), NEVER a spurious "passed".
 *
 * INFORMATIONAL: like the tolerance corner it never gates the verdict (an ambient-only corner cannot justify a
 * fail on certainty it doesn't model). Pure + deterministic given the injected per-temperature runner (worker
 * supplies real ngspice; tests supply a fake), mirroring corner.ts / montecarlo.ts.
 */
import type { CircuitJson } from './types/circuit';
import { evaluateAssertions, type AcceptanceCriterion } from './analysis/assertions';
import type { SimMeasurement } from './analysis/measurements';

/** Component types whose SPICE models carry temperature physics (so a `.temp` sweep is meaningful). Passives
 *  (R/C/L) are temperature-flat here — no TC1/TC2 emitted — so a circuit with none of these is temperature-flat. */
const TEMP_RESPONSIVE_TYPES = new Set<string>(['diode', 'zener', 'bjt', 'mosfet', 'jfet']);

/** True when the circuit has at least one device whose model responds to temperature — else a temperature
 *  corner is a physical no-op (not-applicable), NOT a pass. */
export function hasTemperatureResponsiveDevice(circuit: CircuitJson): boolean {
    return circuit.components.some((c) => TEMP_RESPONSIVE_TYPES.has(c.type));
}

/** Runs the design at one ambient temperature (°C); returns the per-node measurements, or null = errored. */
export type TempRunner = (temperatureC: number, index: number) => Promise<SimMeasurement[] | null>;

export interface TempCornerSpec {
    /** Ambient temperatures (°C) to evaluate — [cold, room, hot], supplied from the robustness profile. */
    temperaturesC: number[];
    /** Human label for the range (e.g. "commercial 0 / +25 / +70 °C"). */
    rangeLabel?: string;
}

/** Per-node drift across the temperature set — the quantified, non-dismissible result. */
export interface TempMetricDrift {
    /** node/probe name. */
    metric: string;
    /** the room/nominal temperature (°C) the drift is measured FROM. */
    baselineTempC: number;
    baselineValue: number;
    /** the temperature at which this metric deviated MOST from baseline. */
    worstTempC: number;
    worstValue: number;
    /** worst − baseline (signed). */
    deltaAbs: number;
    /** |delta| / |baseline| × 100 (0 when baseline ≈ 0, to stay finite). */
    deltaPct: number;
}

export interface TempCornerPoint {
    temperatureC: number;
    /** 'pass'/'fail' when the criteria carry limits; 'no-limit' when no criterion applied (drift-only run);
     *  'errored' when the temperature could not be evaluated (sim fault / non-convergence). */
    outcome: 'pass' | 'fail' | 'no-limit' | 'errored';
}

export interface TempCornerResult {
    /** False when the circuit is temperature-flat (no discrete semiconductor) — not-applicable, NEVER "passed". */
    applicable: boolean;
    /** When applicable=false, WHY — surfaced so a subckt-only board is visibly "not-applicable to behavioral
     *  models" rather than silently dropping from the corner check (a 0 %-drift on a temp-flat macromodel would
     *  be a model artifact read as real stability — the same model-artifact-as-truth we defer decoupling for). */
    notApplicableReason?: string;
    temperaturesC: number[];
    rangeLabel?: string;
    points: TempCornerPoint[];
    evaluated: number;
    passed: number;
    failed: number;
    errored: number;
    /** True iff acceptance criteria were supplied — otherwise this is a drift-only report (no pass/fail). */
    hasLimits: boolean;
    /** True iff hasLimits AND every evaluated temperature passed AND none errored. A drift-only run never
     *  claims passAllTemps (there was nothing to pass). */
    passAllTemps: boolean;
    /** Per-node drift across the temperature set, largest %-drift first. */
    drift: TempMetricDrift[];
}

/**
 * The AMBIENT-ONLY ceiling disclosure — the SINGLE source of this text. Referenced by the scope manifest, the
 * evidence, and the API response so all three assert the SAME ceiling (no copy-paste drift). What a `.temp` run
 * models vs. does not.
 */
export const TEMP_CORNER_CEILING =
    'ambient-only: recomputes device-model temperature physics at one uniform temperature; does NOT model ' +
    'self-heating (junction temperature Tj = Ta + P*Rth), electro-thermal feedback, or theta-JA derating — ' +
    'high-power devices need a separate thermal tier';

const NOT_APPLICABLE_SUBCKT =
    'not-applicable — the only active devices are behavioral subckt models (temperature-flat; a macromodel 0% ' +
    'drift is a model artifact, not real thermal stability)';
const NOT_APPLICABLE_PASSIVE =
    'not-applicable — no temperature-responsive device (passive-only; R/C/L are temperature-flat here)';

/** The DC/scalar value used for drift at a node — full-precision `final` (the .op solution / end-of-run value). */
function scalarOf(m: SimMeasurement): number | undefined {
    const v = m.raw?.final ?? m.final;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Distil ONE temperature's measurements into a corner point + the per-node scalars captured for drift. Pass/fail
 *  comes from evaluateAssertions on the CRITERION'S OWN metric (gain/thd/rms/voltage), NOT from the drift scalar —
 *  so a tran/ac criterion is judged on its real quantity, never mis-measured against a node voltage (the DC-5 trap). */
function evaluateTempPoint(
    T: number,
    measurements: SimMeasurement[] | null,
    criteria: AcceptanceCriterion[],
    nets: CircuitJson['nets'],
    hasLimits: boolean,
): { point: TempCornerPoint; scalars: Array<{ node: string; value: number }> } {
    if (!measurements) return { point: { temperatureC: T, outcome: 'errored' }, scalars: [] };
    const scalars: Array<{ node: string; value: number }> = [];
    for (const m of measurements) {
        const v = scalarOf(m);
        if (v !== undefined) scalars.push({ node: m.node, value: v });
    }
    if (!hasLimits) return { point: { temperatureC: T, outcome: 'no-limit' }, scalars };
    const results = evaluateAssertions(measurements, criteria, true, nets);
    const pass = results.length > 0 && results.every((r) => r.pass);
    return { point: { temperatureC: T, outcome: pass ? 'pass' : 'fail' }, scalars };
}

/** Per-node drift across the temperature set: baseline = the value at the temperature closest to 25 °C (room),
 *  worst = the largest absolute deviation from it. Largest %-drift first — the actionable "this node moves most". */
function computeDrift(perMetric: Map<string, Map<number, number>>, temps: number[]): TempMetricDrift[] {
    const baselineTempC = temps.reduce((best, t) => (Math.abs(t - 25) < Math.abs(best - 25) ? t : best), temps[0] ?? 25);
    const drift: TempMetricDrift[] = [];
    for (const [metric, byTemp] of perMetric) {
        const baselineValue = byTemp.get(baselineTempC);
        if (baselineValue === undefined) continue; // the baseline temperature didn't converge for this node
        let worstTempC = baselineTempC;
        let worstValue = baselineValue;
        let worstDev = 0;
        for (const [t, v] of byTemp) {
            const dev = Math.abs(v - baselineValue);
            if (dev > worstDev) {
                worstDev = dev;
                worstTempC = t;
                worstValue = v;
            }
        }
        const deltaAbs = worstValue - baselineValue;
        const deltaPct = Math.abs(baselineValue) > 1e-12 ? (Math.abs(deltaAbs) / Math.abs(baselineValue)) * 100 : 0;
        drift.push({ metric, baselineTempC, baselineValue, worstTempC, worstValue, deltaAbs, deltaPct });
    }
    // Largest %-drift first; break ties on absolute drift so a real move at a ~0 V baseline (deltaPct pinned to
    // 0 to stay finite) still ranks by its deltaAbs instead of landing in an arbitrary position.
    drift.sort((a, b) => b.deltaPct - a.deltaPct || Math.abs(b.deltaAbs) - Math.abs(a.deltaAbs));
    return drift;
}

/**
 * Orchestrate an ambient temperature-corner run: evaluate the acceptance criteria and capture per-node drift at
 * every temperature in the profile's set. Pure/deterministic given `runAtTemp`. Never throws — a temperature the
 * runner can't evaluate is counted `errored` (three-way, errored ≠ fail, as in corner.ts / montecarlo.ts).
 */
export async function runTempCorner(
    circuit: CircuitJson,
    criteria: AcceptanceCriterion[],
    spec: TempCornerSpec,
    runAtTemp: TempRunner,
): Promise<TempCornerResult> {
    const temps = spec.temperaturesC;
    // Temperature-flat circuit → not-applicable (a no-op), never a spurious "passed". Distinguish a subckt-only
    // board (behavioral macromodels are temp-flat) from a truly passive one so the reason is VISIBLE downstream.
    if (!hasTemperatureResponsiveDevice(circuit)) {
        const reason = circuit.components.some((c) => c.type === 'subckt') ? NOT_APPLICABLE_SUBCKT : NOT_APPLICABLE_PASSIVE;
        return { applicable: false, notApplicableReason: reason, temperaturesC: temps, rangeLabel: spec.rangeLabel, points: [], evaluated: 0, passed: 0, failed: 0, errored: 0, hasLimits: criteria.length > 0, passAllTemps: false, drift: [] };
    }

    const hasLimits = criteria.length > 0;
    const points: TempCornerPoint[] = [];
    const perMetric = new Map<string, Map<number, number>>(); // node -> (temperature -> scalar)

    for (const [i, T] of temps.entries()) {
        let measurements: SimMeasurement[] | null;
        try {
            measurements = await runAtTemp(T, i);
        } catch {
            measurements = null; // a thrown runner = this temperature could not be evaluated → errored
        }
        const { point, scalars } = evaluateTempPoint(T, measurements, criteria, circuit.nets, hasLimits);
        points.push(point);
        for (const s of scalars) {
            let byTemp = perMetric.get(s.node);
            if (!byTemp) {
                byTemp = new Map();
                perMetric.set(s.node, byTemp);
            }
            byTemp.set(T, s.value);
        }
    }

    const evaluated = points.filter((p) => p.outcome === 'pass' || p.outcome === 'fail').length;
    const passed = points.filter((p) => p.outcome === 'pass').length;
    const failed = points.filter((p) => p.outcome === 'fail').length;
    const errored = points.filter((p) => p.outcome === 'errored').length;
    const passAllTemps = hasLimits && evaluated > 0 && failed === 0 && errored === 0;
    const drift = computeDrift(perMetric, temps);

    return { applicable: true, temperaturesC: temps, rangeLabel: spec.rangeLabel, points, evaluated, passed, failed, errored, hasLimits, passAllTemps, drift };
}
