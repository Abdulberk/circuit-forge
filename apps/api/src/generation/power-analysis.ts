/**
 * Power-dissipation analysis — "which component is over its power rating?", the design-review check
 * that catches a real fire/reliability risk before a board is built.
 *
 * RESISTORS only (caps/inductors are lossless on average; active-device power needs a current probe).
 * For a resistor between nodes A and B, P = (V_A − V_B)² / R from the node voltages we already measure
 * + the resistor value — no current probe needed. Per analysis:
 *   - op/dc            → P from the steady-state node voltages (`final`); exact. (basis 'operating-point')
 *   - TRAN, grounded   → the resistor's TRUE AVERAGE heating P = Vrms² / R, using the time-weighted RMS of
 *                        the non-ground node (the other end is 0 V) — NOT the last-timestep snapshot, which
 *                        understates an AC/ripple/switching resistor (a sample caught near a zero crossing
 *                        reads ~0 W). (basis 'rms') This is what a real tool reports for a time-varying load.
 *   - TRAN, floating   → differential Vrms(A−B) can't be recovered from per-node RMS, so fall back to the
 *                        last-timestep ΔV²/R. (basis 'last-timestep')
 *   - AC               → a frequency-domain |H| sweep has no time-domain power; last-timestep snapshot only.
 * Each resistor's dissipation is compared to its rating (explicit `properties.powerRating` W, else a
 * conservative default) and flagged when exceeded.
 *
 * Deliberately INFORMATIONAL: an exceeded DEFAULT rating is a warning surfaced in the evidence pack,
 * not an automatic verdict failure — the default is a guess, and false-failing a design on a guessed
 * rating would be worse than surfacing it. (Active-device power is a follow-up.)
 */
import { sanitizeNodeName, parseSpiceValue, type CircuitJson } from '@circuit-forge/eda-core';
import type { SimMeasurement } from './circuit-simulator.service';

/** Standard through-hole/SMD resistor rating when the component doesn't declare one. */
const DEFAULT_RESISTOR_RATING_W = 0.25;

export interface PowerFinding {
    designator: string;
    /** Dissipation in watts. See `basis` for how it was obtained. */
    dissipationW: number;
    /** How THIS resistor's dissipation was derived: 'operating-point' (op/dc steady value), 'rms' (true
     *  time-averaged heating Vrms²/R for a grounded resistor in a transient), or 'last-timestep' (a snapshot
     *  — a floating transient resistor or an AC sweep, where the true average isn't recoverable here). */
    basis: 'operating-point' | 'rms' | 'last-timestep';
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
    const rmsByNode = new Map<string, number>();
    for (const m of measurements) {
        finalByNode.set(nodeKey(m.node), m.final);
        rmsByNode.set(nodeKey(m.node), m.rms ?? Math.abs(m.final)); // older measurements: rms ≈ |final|
    }

    const groundNetIds = new Set((circuit.nets ?? []).filter((n) => n.isGround).map((n) => n.id));
    const isGround = (netId: string) => groundNetIds.has(netId);

    // Net id → its node-voltage at the operating point (ground = 0; otherwise the measured `final`).
    const voltageOf = (netId: string): number | null => {
        if (isGround(netId)) return 0;
        const v = finalByNode.get(sanitizeNodeName(netId).toLowerCase());
        return typeof v === 'number' ? v : null;
    };
    // Net id → its time-weighted RMS voltage (ground = 0).
    const rmsOf = (netId: string): number | null => {
        if (isGround(netId)) return 0;
        const v = rmsByNode.get(sanitizeNodeName(netId).toLowerCase());
        return typeof v === 'number' ? v : null;
    };

    const isTransient = analysisType === 'tran';

    const components: PowerFinding[] = [];
    for (const r of resistors) {
        if (!r.pins || r.pins.length < 2) continue;
        const n1 = r.pins[0]!.netId;
        const n2 = r.pins[1]!.netId;
        const v1 = voltageOf(n1);
        const v2 = voltageOf(n2);
        if (v1 === null || v2 === null) continue; // a node wasn't measured — don't guess
        const parsed = parseSpiceValue(r.value ?? '');
        if (!parsed.isValid || parsed.value <= 0) continue;
        const R = parsed.value;
        const groundedCount = (isGround(n1) ? 1 : 0) + (isGround(n2) ? 1 : 0);

        let dissipationW: number;
        let basis: PowerFinding['basis'];
        if (isTransient && groundedCount === 1) {
            // True average heating: Vrms across the resistor = RMS of the non-ground node (other end = 0 V).
            const vr = rmsOf(isGround(n1) ? n2 : n1);
            if (vr !== null) {
                dissipationW = (vr * vr) / R;
                basis = 'rms';
            } else {
                dissipationW = (v1 - v2) ** 2 / R;
                basis = 'last-timestep';
            }
        } else if (isTransient || analysisType === 'ac') {
            // Floating transient (no differential RMS) or an AC sweep — a snapshot, honestly labelled.
            dissipationW = (v1 - v2) ** 2 / R;
            basis = 'last-timestep';
        } else {
            // op/dc — the `final` IS the steady-state value.
            dissipationW = (v1 - v2) ** 2 / R;
            basis = 'operating-point';
        }

        const { ratingW, isDefault } = ratingOf(r.properties);
        components.push({
            designator: r.designator,
            dissipationW: Number(dissipationW.toPrecision(4)),
            basis,
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
