/**
 * Pure assertion evaluation — the ONE place a measurable spec is checked against a simulation result.
 *
 * Shared by verify-design (user-supplied assertions) AND the AI design loop (model-emitted acceptance
 * criteria), so "verified" means the same thing in both: ngspice ran AND the measured behavior meets the
 * stated numeric intent. No ngspice here — it operates on the already-summarized per-node measurements.
 */
import { sanitizeNodeName } from '@circuit-forge/eda-core';
import type { AssertionDto } from './dto';
import type { SimMeasurement } from './circuit-simulator.service';

export interface AssertionResult {
    label: string;
    probe: string;
    metric: AssertionDto['metric'];
    op: AssertionDto['op'];
    target: number;
    tol?: number;
    /** Measured value, or null when the probe wasn't found / the sim produced no results. */
    actual: number | null;
    pass: boolean;
    /** Signed gap from the target (`actual - target`), or null when unmeasured. Lets a caller tell a
     *  marginal miss (−0.001) from a catastrophic one (−7) and tells the AI fix loop how far off it is. */
    distance: number | null;
    detail: string;
}

/**
 * Map a user-facing probe to the SPICE node the simulator actually reports. The user thinks in NET names
 * ("out"); the netlist generator runs each net id through sanitizeNodeName. We apply the SAME transform to
 * both the probe and the measured node (after stripping a v() wrapper) so "out" / "v(out)" / "V(OUT)" all
 * resolve to the one node the measurement carries. Lowercased (ngspice emits lower-case node names).
 */
export function nodeKey(probe: string): string {
    const m = probe.trim().match(/^v\(([^)]+)\)$/i);
    const bare = m ? m[1]! : probe.trim();
    return sanitizeNodeName(bare).toLowerCase();
}

/** A current/power probe (i(R1), @r1[i]) — NOT a node voltage. */
export function isCurrentProbe(probe: string): boolean {
    return /^\s*i\s*\(/i.test(probe) || /\[\s*i\s*\]\s*$/i.test(probe);
}

/**
 * Canonical device designator for a CURRENT probe, so the CRITERION form the model writes (`i(R1)`,
 * `I( V1 )`) and the MEASURED-series form the simulator reports (`@r1[i]` — how `wrdata` + `savecurrents`
 * names a saved R/C branch current; verified on ngspice-41) resolve to the SAME key. Lowercased. Returns
 * null when no device name can be extracted. Without this, a current criterion would never match its own
 * measurement (`nodeKey("i(R1)") !== nodeKey("@r1[i]")`) and would always read as "probe not found".
 */
export function currentKey(probe: string): string | null {
    const p = probe.trim();
    const paren = p.match(/^i\s*\(\s*([^)]+?)\s*\)$/i); // i(R1), I( V1 )
    if (paren) return paren[1]!.toLowerCase();
    const at = p.match(/^@\s*([^[\s]+?)\s*\[\s*i\s*\]$/i); // @r1[i]
    if (at) return at[1]!.toLowerCase();
    return null;
}

/** Device prefixes whose branch current ngspice can actually report (R/C via @<dev>[i] + savecurrents;
 *  V/L/E/H via native i()). A diode (D), transistor (Q/M/J), subckt (X), behavioral (B), switch (S) etc.
 *  have NO branch-current vector — the generator silently drops such a probe, so it would read as
 *  "probe not found" rather than measure anything. Lets callers reject it up front with a clear message
 *  (probe a series resistor's current instead). */
const OBSERVABLE_CURRENT_DEVICE = /^[rcvleh]/i;
export function isObservableCurrentProbe(probe: string): boolean {
    const dev = currentKey(probe);
    return dev !== null && OBSERVABLE_CURRENT_DEVICE.test(dev);
}

/** Namespaced match key: a current probe keys by its device (`i:r1`), a voltage probe by its node
 *  (`v:<nodeKey>`). Keeps the two kinds from colliding AND bridges `i(R1)` ↔ the measured `@r1[i]`. */
function matchKey(probeOrNode: string): string {
    if (isCurrentProbe(probeOrNode)) {
        return `i:${currentKey(probeOrNode) ?? probeOrNode.trim().toLowerCase()}`;
    }
    return `v:${nodeKey(probeOrNode)}`;
}

export function compareAssertion(actual: number, op: AssertionDto['op'], target: number, tol?: number): boolean {
    switch (op) {
        case 'lt':
            return actual < target;
        case 'lte':
            return actual <= target;
        case 'gt':
            return actual > target;
        case 'gte':
            return actual >= target;
        case 'approx': {
            // Default tolerance: 5% of |target|, or an absolute 1e-9 floor so target=0 still works.
            const t = tol ?? Math.max(Math.abs(target) * 0.05, 1e-9);
            return Math.abs(actual - target) <= t;
        }
    }
}

/**
 * Evaluate each assertion against the measurements. When the sim didn't run (simOk=false) every assertion
 * is unmet (actual=null) — you can't certify a spec you couldn't measure.
 */
export function evaluateAssertions(
    measurements: SimMeasurement[],
    assertions: AssertionDto[],
    simOk = true,
): AssertionResult[] {
    const byKey = new Map(measurements.map((m) => [matchKey(m.node), m]));
    return assertions.map((a) => {
        const label = a.label ?? `${a.probe} ${a.metric} ${a.op} ${a.value}`;
        const base = { label, probe: a.probe, metric: a.metric, op: a.op, target: a.value, tol: a.tol };
        const m = simOk ? byKey.get(matchKey(a.probe)) : undefined;
        if (!m) {
            return {
                ...base,
                actual: null,
                distance: null,
                pass: false,
                detail: simOk ? `probe "${a.probe}" not found in simulation output` : 'simulation did not produce results',
            };
        }
        // Current is SIGNED by device pin order in ngspice (a correctly-wired resistor's @r1[i] can read
        // negative); a current spec is a magnitude ("~10mA through R1"), so compare |current|. Node
        // voltages are unaffected; pp is already ≥ 0. Without this, a sound design fails its own current
        // criterion forever (the fix loop can never satisfy a positive target against a negative reading).
        const actual = isCurrentProbe(a.probe) ? Math.abs(m[a.metric]) : m[a.metric];
        const pass = compareAssertion(actual, a.op, a.value, a.tol);
        return {
            ...base,
            actual,
            distance: actual - a.value,
            pass,
            detail: `${a.metric}(${a.probe}) = ${actual} ${pass ? '✓' : '✗'} ${a.op} ${a.value}`,
        };
    });
}

/** A one-line, human/AI-readable description of a failed criterion incl. how far off it is — fed to the
 *  AI fix loop so it knows "gain 3 vs 10" (catastrophic) differs from "4.99 vs 5.00" (marginal). */
export function describeFailure(r: AssertionResult): string {
    if (r.actual === null) {
        return `${r.label}: ${r.detail}`;
    }
    const off = r.distance ?? 0;
    const rel = r.target !== 0 ? ` (${((off / Math.abs(r.target)) * 100).toFixed(0)}% off)` : '';
    return `${r.label}: measured ${r.metric}(${r.probe}) = ${r.actual}, required ${r.op} ${r.target} — off by ${off.toPrecision(3)}${rel}`;
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * Spec-coverage: does the design's criteria set actually measure the QUANTITY the user named?
 *
 * The adversarial-jury finding behind this: when the user's load-bearing quantity is a single DC node
 * voltage, criteria are faithful and "verified" is sound. But when it is a CURRENT (or a FREQUENCY), the
 * model tends to substitute a loosely-coupled node-voltage PROXY and still claim verified=true (e.g. an LED
 * "≈10mA" spec "verified" by checking the anode sits at ≈2V — a 3×-wrong resistor would pass). The fix is
 * a CODE-side gate (the model rationalizes past prompt suggestions): if the user named a current target,
 * a criterion MUST probe a branch current, or the design is not "verified".
 * ──────────────────────────────────────────────────────────────────────────────────────────────────── */

export type SpecDimension = 'voltage' | 'current' | 'frequency';

/** Physical quantity a single criterion actually measures. A node probe is a voltage; an i()/@…[i] probe
 *  is a current. There is no 'frequency' criterion — the metric vocabulary (min|max|final|pp) cannot
 *  express one, which is exactly why a frequency spec can only be proxied today. */
export function criterionDimension(c: { probe: string }): SpecDimension {
    return isCurrentProbe(c.probe) ? 'current' : 'voltage';
}

// Conservative, magnitude-anchored detectors. The lookbehind keeps an embedded token (a part number like
// "BD139A", or a "10k" value) from tripping the unit — only a standalone number + unit counts.
const CURRENT_MAGNITUDE_RE = /(?<![a-z0-9.])\d+(?:\.\d+)?\s*(?:m|u|µ|n|k|p)?a\b/i; // 10mA, 5 A, 0.5A
const CURRENT_WORD_RE = /(?<![a-z0-9.])\d+(?:\.\d+)?\s*(?:milli|micro|nano|kilo)?amp(?:ere)?s?\b/i; // 10 milliamps
const FREQUENCY_MAGNITUDE_RE = /(?<![a-z0-9.])\d+(?:\.\d+)?\s*(?:k|m|g)?hz\b/i; // 1kHz, 60 Hz
const FREQUENCY_WORD_RE = /\b(?:cutoff|corner\s+frequenc(?:y|ies)|bandwidth|-?\s*3\s*db|passband|stopband|resonant\s+frequency)\b/i;

/** Quantities the user EXPLICITLY put a numeric target on, detected conservatively from the prompt —
 *  CODE-side, NOT model-trusted (the model is what under-specifies). Voltage is intentionally never
 *  inferred: it is the default everywhere and almost always already carries a criterion. A false negative
 *  is safe (status quo); a false positive only ever DOWNGRADES an over-claimed "verified", never the
 *  reverse — so erring toward not-detecting keeps the gate conservative. */
export function requiredDimensions(prompt: string): Set<SpecDimension> {
    const dims = new Set<SpecDimension>();
    const p = prompt ?? '';
    if (CURRENT_MAGNITUDE_RE.test(p) || CURRENT_WORD_RE.test(p)) dims.add('current');
    if (FREQUENCY_MAGNITUDE_RE.test(p) || FREQUENCY_WORD_RE.test(p)) dims.add('frequency');
    return dims;
}

/** Required dimensions that we can ACTUALLY verify (have a metric for) yet NO criterion measures — these
 *  must block a "verified" verdict. Only 'current' is enforceable today: 'frequency' is detected by
 *  requiredDimensions but has no AC-magnitude/freq metric yet, so it is disclosed as a caveat upstream
 *  rather than hard-gated (gating it would make every filter design unverifiable until that metric lands). */
export function uncoveredRequiredDimensions(prompt: string, criteria: { probe: string }[]): SpecDimension[] {
    const required = requiredDimensions(prompt);
    const covered = new Set(criteria.map(criterionDimension));
    const ENFORCEABLE: SpecDimension[] = ['current'];
    return ENFORCEABLE.filter((d) => required.has(d) && !covered.has(d));
}
