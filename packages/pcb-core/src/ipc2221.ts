/**
 * IPC-2221 current → minimum trace width (the current-aware moat: a power/ground net carries more
 * current and must be wider than a signal net, deterministically, no LLM).
 *
 * Closed form (PCB_BRIEF §V5): `I = k · ΔT^0.44 · A^0.725`  ⇒  `A = (I / (k·ΔT^0.44))^(1/0.725)` [mil²],
 * then `width_mil = A / (1.378 · copperOz)` and `width_mm = width_mil · 0.0254`.
 *   k = 0.048 external (outer) layer, 0.024 internal (a buried trace dissipates heat worse → wider).
 *
 * Validity envelope (the IPC-2221 chart bounds): I ≤ 35 A, ΔT 10–100 °C, copper 0.5–3 oz, width ≤ 400 mil.
 * OUTSIDE the chart we CLAMP and flag — never silently extrapolate a chart past where it was measured
 * (a 60 A "trace" is a busbar/plane, not a track; saying so honestly beats emitting a fantasy width).
 *
 * IPC-2221 is the conservative industry default; IPC-2152 (thermally-aware) is the later upgrade.
 */

const MIL_TO_MM = 0.0254;
const ENVELOPE = { maxCurrentA: 35, minDeltaTC: 10, maxDeltaTC: 100, minOz: 0.5, maxOz: 3, maxWidthMil: 400 };

export interface IpcWidthInput {
    /** RMS current through the net, amps. */
    currentA: number;
    /** Allowed temperature rise, °C (default 10 — conservative). */
    deltaTC?: number;
    /** Copper weight, oz (default 1 = 35 µm = 1.378 mil). */
    copperOz?: number;
    /** Layer class: 'external' (top/bottom, default) or 'internal' (buried, runs wider). */
    layer?: 'external' | 'internal';
}

export interface IpcWidthResult {
    widthMm: number;
    /** True when an input hit the chart envelope and was clamped (width is a floor/ceiling, not exact). */
    clamped: boolean;
    /** Human-readable clamp/context notes (surface these as diagnostics — no silent clamp). */
    notes: string[];
}

/** IPC-2221 minimum trace width for a net carrying `currentA`, clamped to the chart's validity envelope. */
export function ipc2221WidthMm(input: IpcWidthInput): IpcWidthResult {
    const notes: string[] = [];
    let clamped = false;
    const clamp = (v: number, lo: number, hi: number, name: string): number => {
        if (v < lo) {
            notes.push(`${name}=${v} below IPC-2221 envelope [${lo},${hi}] — clamped to ${lo}`);
            clamped = true;
            return lo;
        }
        if (v > hi) {
            notes.push(
                `${name}=${v} above IPC-2221 envelope [${lo},${hi}] — clamped to ${hi} (use a plane/bus, not a track)`,
            );
            clamped = true;
            return hi;
        }
        return v;
    };

    const I = clamp(Math.abs(input.currentA), 0, ENVELOPE.maxCurrentA, 'current(A)');
    const dT = clamp(input.deltaTC ?? 10, ENVELOPE.minDeltaTC, ENVELOPE.maxDeltaTC, 'ΔT(°C)');
    const oz = clamp(input.copperOz ?? 1, ENVELOPE.minOz, ENVELOPE.maxOz, 'copper(oz)');
    const k = (input.layer ?? 'external') === 'internal' ? 0.024 : 0.048;

    const areaMil2 = Math.pow(I / (k * Math.pow(dT, 0.44)), 1 / 0.725);
    let widthMil = areaMil2 / (1.378 * oz);
    if (widthMil > ENVELOPE.maxWidthMil) {
        notes.push(
            `width ${widthMil.toFixed(0)} mil exceeds the IPC-2221 chart max ${ENVELOPE.maxWidthMil} mil — clamped (route as a copper pour/bus)`,
        );
        widthMil = ENVELOPE.maxWidthMil;
        clamped = true;
    }
    return { widthMm: Math.round(widthMil * MIL_TO_MM * 1000) / 1000, clamped, notes };
}
