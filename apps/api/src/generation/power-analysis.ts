/**
 * Power-dissipation analysis — "which component is over its power rating?", the design-review check
 * that catches a real fire/reliability risk before a board is built.
 *
 * v1 scope: RESISTORS at the steady-state operating point. For a resistor between nodes A and B,
 * dissipation P = (V_A − V_B)² / R is exact from the node voltages we already measure (the `final`
 * value = the operating point / settled transient) + the resistor value — no current probe or
 * time-series math needed. Each resistor's dissipation is compared to its rating (an explicit
 * `properties.powerRating` in watts, else a conservative default) and flagged when exceeded.
 *
 * Deliberately INFORMATIONAL: an exceeded DEFAULT rating is a warning surfaced in the evidence pack,
 * not an automatic verdict failure — the default is a guess, and false-failing a design on a guessed
 * rating would be worse than surfacing it. (Active-device power and transient-peak power are follow-ups.)
 */
import { sanitizeNodeName, parseSpiceValue, type CircuitJson } from '@circuit-forge/eda-core';
import type { SimMeasurement } from './circuit-simulator.service';

/** Standard through-hole/SMD resistor rating when the component doesn't declare one. */
const DEFAULT_RESISTOR_RATING_W = 0.25;

export interface PowerFinding {
    designator: string;
    /** Steady-state dissipation in watts at the reported operating point. */
    dissipationW: number;
    /** The rating it was checked against (explicit or default). */
    ratingW: number;
    /** True when ratingW is the fallback default (so the UI/AI can treat "over" as a softer warning). */
    ratingIsDefault: boolean;
    /** dissipationW > ratingW. */
    overRating: boolean;
}

export interface PowerReport {
    /** How dissipationW was obtained: a true steady-state operating point (op/dc), or the LAST timestep
     *  of a transient/AC run (a snapshot — not RMS/peak; the UI should not call it "steady-state"). */
    basis: 'operating-point' | 'last-timestep';
    components: PowerFinding[];
    /** True if any resistor exceeds its rating (default or explicit). */
    anyOverRating: boolean;
}

/** Map a probe/net name to the lower-cased SPICE node key the measurements are keyed on. */
function nodeKey(probeOrNet: string): string {
    const m = probeOrNet.trim().match(/^v\(([^)]+)\)$/i);
    return sanitizeNodeName(m ? m[1]! : probeOrNet.trim()).toLowerCase();
}

function ratingOf(properties: Record<string, unknown> | undefined): { ratingW: number; isDefault: boolean } {
    const raw = properties?.powerRating;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(n) && n > 0) return { ratingW: n, isDefault: false };
    return { ratingW: DEFAULT_RESISTOR_RATING_W, isDefault: true };
}

/**
 * Compute steady-state resistor dissipation from the node-voltage measurements. Returns undefined when
 * there are no resistors to report. Resistors whose node voltages or value can't be resolved are
 * skipped (not guessed). Ground nodes are 0 V.
 */
export function computeResistorPower(
    circuit: CircuitJson,
    measurements: SimMeasurement[],
    analysisType?: string,
): PowerReport | undefined {
    const resistors = (circuit.components ?? []).filter((c) => c.type === 'resistor');
    if (resistors.length === 0) return undefined;

    const finalByNode = new Map<string, number>();
    for (const m of measurements) finalByNode.set(nodeKey(m.node), m.final);

    const groundNetIds = new Set((circuit.nets ?? []).filter((n) => n.isGround).map((n) => n.id));

    // Net id → its node-voltage at the operating point (ground = 0; otherwise the measured `final`).
    const voltageOf = (netId: string): number | null => {
        if (groundNetIds.has(netId)) return 0;
        const v = finalByNode.get(sanitizeNodeName(netId).toLowerCase());
        return typeof v === 'number' ? v : null;
    };

    const components: PowerFinding[] = [];
    for (const r of resistors) {
        if (!r.pins || r.pins.length < 2) continue;
        const v1 = voltageOf(r.pins[0]!.netId);
        const v2 = voltageOf(r.pins[1]!.netId);
        if (v1 === null || v2 === null) continue; // a node wasn't measured — don't guess
        const parsed = parseSpiceValue(r.value ?? '');
        if (!parsed.isValid || parsed.value <= 0) continue;
        const dissipationW = (v1 - v2) ** 2 / parsed.value;
        const { ratingW, isDefault } = ratingOf(r.properties);
        components.push({
            designator: r.designator,
            dissipationW: Number(dissipationW.toPrecision(4)),
            ratingW,
            ratingIsDefault: isDefault,
            overRating: dissipationW > ratingW,
        });
    }

    if (components.length === 0) return undefined;
    // op/dc give a true operating point; tran/ac `final` is just the last captured timestep.
    const basis: PowerReport['basis'] = analysisType === 'tran' || analysisType === 'ac' ? 'last-timestep' : 'operating-point';
    return { basis, components, anyOverRating: components.some((c) => c.overRating) };
}
