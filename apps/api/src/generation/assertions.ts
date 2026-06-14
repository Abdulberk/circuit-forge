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

/** A current/power probe the voltage-only default simulation can't measure (i(R1), @r1[i]). */
export function isCurrentProbe(probe: string): boolean {
    return /^\s*i\s*\(/i.test(probe) || /\[\s*i\s*\]\s*$/i.test(probe);
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
    const byKey = new Map(measurements.map((m) => [nodeKey(m.node), m]));
    return assertions.map((a) => {
        const label = a.label ?? `${a.probe} ${a.metric} ${a.op} ${a.value}`;
        const base = { label, probe: a.probe, metric: a.metric, op: a.op, target: a.value, tol: a.tol };
        const m = simOk ? byKey.get(nodeKey(a.probe)) : undefined;
        if (!m) {
            return {
                ...base,
                actual: null,
                distance: null,
                pass: false,
                detail: simOk ? `probe "${a.probe}" not found in simulation output` : 'simulation did not produce results',
            };
        }
        const actual = m[a.metric];
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
