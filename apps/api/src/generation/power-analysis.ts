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
 * Each resistor's dissipation is compared to its rating — the part's declared `properties.powerRating`, else
 * the standard rating for its package size, else a conservative default — and flagged when exceeded.
 *
 * Deliberately INFORMATIONAL: an exceeded DEFAULT rating is a warning surfaced in the evidence pack,
 * not an automatic verdict failure — the default is a guess, and false-failing a design on a guessed
 * rating would be worse than surfacing it. (Active-device power is a follow-up.)
 */
import { sanitizeNodeName, parseSpiceValue, type CircuitJson } from '@circuit-forge/eda-core';

import type { SimMeasurement } from './circuit-simulator.service';

/** Rating used when the part declares none and its footprint says nothing — a through-hole axial resistor,
 *  the most common part with no package code. */
const DEFAULT_RESISTOR_RATING_W = 0.25;

/**
 * Power rating by chip-resistor package, in watts at 70 °C.
 *
 * WHY THIS TABLE EXISTS. Package size IS the power rating for a chip resistor — that is what the size is
 * for. Charging every resistor the same 0.25 W regardless of package was wrong in the dangerous direction:
 * an 0603 is rated 0.1 W, so a design dissipating 0.2 W in one passed the check with 2.5× the power budget
 * it actually has. The board is built, that resistor runs hot, drifts, and eventually opens — and the
 * verification report said it was fine. A rating is only a check if it is the real one.
 *
 * Values are the LOWEST in common vendor use for each size (Yageo/Vishay/Panasonic thick-film all publish
 * these; some premium lines rate higher). Lowest is the right choice: over-stating a rating hides a real
 * over-power finding, while under-stating it surfaces one the designer can dismiss by declaring the actual
 * part. The error that costs nothing is the one to prefer.
 */
const CHIP_RESISTOR_RATING_W: Readonly<Record<string, number>> = {
    '01005': 0.031, // 1/32 W
    '0201': 0.05, //  1/20 W
    '0402': 0.0625, // 1/16 W
    '0603': 0.1, //   1/10 W
    '0805': 0.125, // 1/8 W
    '1206': 0.25, //  1/4 W
    '1210': 0.5, //   1/2 W
    '2010': 0.75, //  3/4 W
    '1218': 1,
    '2512': 1,
};

/**
 * The imperial package code in a footprint name, or null.
 *
 * Takes the FIRST code in the string on purpose. KiCad writes both spellings ("R_0201_0603Metric"), and
 * 0603 is simultaneously an imperial size (0.1 W) and the metric spelling of 0201 (0.05 W) — so a scan that
 * matched anywhere would read that footprint as twice the rating it has. Imperial comes first in every
 * KiCad name and is the only form bare tscircuit footprints use, so first-match is the unambiguous read.
 * Anything unrecognised (axial DIN bodies, MELF, a bare metric code) returns null and keeps the default,
 * rather than guessing from a name we do not actually understand.
 */
function packageRatingW(footprint: string | undefined): number | null {
    const code = footprint?.match(/[0-9]{4,5}/)?.[0];
    return code === undefined ? null : (CHIP_RESISTOR_RATING_W[code] ?? null);
}

export interface PowerFinding {
    designator: string;
    /** Dissipation in watts. See `basis` for how it was obtained. */
    dissipationW: number;
    /** How THIS resistor's dissipation was derived: 'operating-point' (op/dc steady value), 'rms' (true
     *  time-averaged heating Vrms²/R for a grounded resistor in a transient), or 'last-timestep' (a snapshot
     *  — a floating transient resistor or an AC sweep, where the true average isn't recoverable here). */
    basis: 'operating-point' | 'rms' | 'last-timestep';
    /** The rating it was checked against. */
    ratingW: number;
    /** Where ratingW came from. Only 'declared' is the part's own number; 'footprint' is the standard
     *  rating for that package size, and 'default' is a blanket assumption. A consumer treating "over
     *  rating" as a hard problem should require 'declared' — the other two are strong hints, not datasheet
     *  facts, and false-failing a design on an assumed rating is worse than reporting it. */
    ratingSource: 'declared' | 'footprint' | 'default';
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

/** Rating in preference order: what the part declares, then what its package implies, then the fallback. */
function ratingOf(
    properties: Record<string, unknown> | undefined,
    footprint: string | undefined,
): { ratingW: number; ratingSource: PowerFinding['ratingSource'] } {
    const raw = properties?.powerRating;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(n) && n > 0) return { ratingW: n, ratingSource: 'declared' };
    const pkg = packageRatingW(footprint);
    if (pkg !== null) return { ratingW: pkg, ratingSource: 'footprint' };
    return { ratingW: DEFAULT_RESISTOR_RATING_W, ratingSource: 'default' };
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

        const { ratingW, ratingSource } = ratingOf(r.properties, r.footprint);
        components.push({
            designator: r.designator,
            dissipationW: Number(dissipationW.toPrecision(4)),
            basis,
            ratingW,
            ratingSource,
            overRating: dissipationW > ratingW,
        });
    }

    if (components.length === 0) return undefined;
    // op/dc give a true operating point; tran/ac `final` is just the last captured timestep.
    const basis: PowerReport['basis'] =
        analysisType === 'tran' || analysisType === 'ac' ? 'last-timestep' : 'operating-point';
    return { basis, components, anyOverRating: components.some((c) => c.overRating) };
}
