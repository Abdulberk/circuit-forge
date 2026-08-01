/**
 * Curated footprint resolution — CircuitJson component -> tscircuit "footprinter string".
 *
 * Order of truth: an explicit `component.footprint` (catalog-sourced, e.g. "SOIC-8") ALWAYS wins and
 * is only normalized to footprinter's spelling ("soic8"); otherwise a curated per-type default. The
 * defaults deliberately cover ONLY the v1 palette (passives, diodes/LEDs, discrete transistors,
 * subckt ICs); everything else is a `layoutability` concern, not a silent guess here.
 */
import type { Component } from '@circuit-forge/eda-core';

/** Passive imperial sizes we accept via `properties.size` (defaults to 0603). */
const PASSIVE_SIZES = new Set(['0402', '0603', '0805', '1206']);
const DEFAULT_PASSIVE_SIZE = '0603';

export interface FootprintResolution {
    /** footprinter-spelling footprint string (e.g. "0603", "soic8", "sot23"). */
    footprint: string;
    /** Where it came from — 'override' = component.footprint; 'default' = curated map. */
    source: 'override' | 'default';
}

/**
 * LED detection (approval condition 4): our schema has NO `led` component type — an LED is a `diode`
 * whose model reference names an led_* / LED* model (library: led_red, LEDRED, ...).
 */
export function isLedDiode(component: Pick<Component, 'type' | 'model'>): boolean {
    return component.type === 'diode' && /^led/i.test(component.model ?? '');
}

/**
 * Normalize a human/catalog footprint spelling to footprinter's ("SOIC-8" -> "soic8", "TO-92" ->
 * "to92", "0603" -> "0603"). Footprinter's vocabulary is wide and parameterized — unknown names pass
 * through normalized rather than being rejected here (a wrong name surfaces loudly at eval time).
 */
export function normalizeFootprint(raw: string): string {
    return raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '');
}

/** Passive size from properties.size when it is one of the known imperial codes. */
function passiveSize(component: Component): string {
    const size = String(component.properties?.size ?? '');
    return PASSIVE_SIZES.has(size) ? size : DEFAULT_PASSIVE_SIZE;
}

/** SOIC ladder for subckt/chip-fallback parts by pin count (8 -> soic8, <=14 -> soic14, <=16 -> soic16). */
export function soicForPinCount(pinCount: number): string | null {
    if (pinCount <= 0) return null;
    if (pinCount <= 8) return 'soic8';
    if (pinCount <= 14) return 'soic14';
    if (pinCount <= 16) return 'soic16';
    return null; // beyond the v1 curated ladder — requires an explicit footprint override
}

/**
 * How many pads a footprint really has, and whether it can be built at all.
 *
 * `null` means the renderer REFUSES the string — a distinct answer from any number, and the one that
 * predicts a job dying downstream with a tool-internal message.
 */
export type PadCountOracle = (footprint: string) => number | null;

/**
 * Load the real oracle: footprinter, the same library the evaluator builds packages with.
 *
 * INJECTED, not imported, for the reason freerouting and the DRC notary are injected — pcb-core stays a
 * pure, synchronous, dependency-light core and the heavy tool is handed in. Here there is a second,
 * harder reason: footprinter is ESM-only and pcb-core is CommonJS, so a static import does not compile.
 * `layoutCircuit` awaits this once and threads the result through.
 *
 * WHY IT REPLACED A PATTERN. Pad count used to come from a nine-family regex plus a seven-entry table,
 * and it was wrong in the direction that hurts: `null` for most of the real vocabulary (sot23, sot363,
 * sma, melf…), which callers read as "unknowable" and skipped accounting for entirely — and a confident
 * number for strings footprinter refuses (sop14, msop20), so a board could be pad-accounted against a
 * package that will never exist. A count inferred from a name is a guess about someone else's library.
 */
export async function loadPadCountOracle(): Promise<PadCountOracle> {
    const { fp } = (await import('@tscircuit/footprinter')) as {
        fp: { string: (s: string) => { circuitJson: () => Array<{ type?: string }> } };
    };
    // Memoised: footprinter builds real geometry per call, and a board reuses a handful of strings.
    const cache = new Map<string, number | null>();
    return (footprint: string): number | null => {
        const hit = cache.get(footprint);
        if (hit !== undefined) return hit;
        let n: number | null = null;
        try {
            const pads = fp
                .string(footprint)
                .circuitJson()
                .filter((e) => e.type === 'pcb_smtpad' || e.type === 'pcb_plated_hole').length;
            n = pads > 0 ? pads : null; // a "footprint" with no copper is not one a pin can land on
        } catch {
            n = null; // footprinter refuses this string
        }
        cache.set(footprint, n);
        return n;
    };
}

/**
 * Resolve the footprint for a LAYOUTABLE component. Returns null when the curated map has no default
 * and no override exists — the caller (layoutability) turns that into an honest diagnostic, never a
 * silent guess.
 */
export function resolveFootprint(component: Component): FootprintResolution | null {
    if (component.footprint) {
        return { footprint: normalizeFootprint(component.footprint), source: 'override' };
    }
    const def = defaultFootprint(component);
    return def ? { footprint: def, source: 'default' } : null;
}

function defaultFootprint(component: Component): string | null {
    switch (component.type) {
        case 'resistor':
        case 'capacitor':
        case 'inductor':
            return passiveSize(component);
        case 'diode':
        case 'zener':
            return isLedDiode(component) ? DEFAULT_PASSIVE_SIZE : 'sod123';
        case 'bjt':
            // TO-92 for through-hole preference via properties.package; SMD SOT-23 default.
            return String(component.properties?.package ?? '').toLowerCase() === 'to92' ? 'to92' : 'sot23';
        case 'mosfet':
        case 'jfet': // jfet has no tscircuit element (chip-fallback) but the SOT-23 pads are right
            return 'sot23';
        case 'switch':
            return 'sot23'; // small-signal SPST default; catalog parts override
        case 'subckt':
            return soicForPinCount(component.pins.length);
        case 'voltage_source':
        case 'current_source':
            // Connectorized (physical policy): a 2-pin header the user wires the real source into.
            return 'pinrow2';
        default:
            return null; // ground/net-only, sim-only and generic types carry no curated default
    }
}
