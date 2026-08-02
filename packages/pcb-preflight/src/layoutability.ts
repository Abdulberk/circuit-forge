/**
 * Pre-flight layoutability classification (ERC-style diagnostics).
 *
 * Every component is classified into a physical-board ROLE before any tscircuit code is generated.
 * The honesty rules (brief §10, approval conditions 2+3):
 *  - a LOAD-BEARING exclusion (a sim-primitive the circuit depends on: transformer, controlled
 *    sources, XSPICE digital, ...) FAILS the layout by default — a transformer circuit must never
 *    yield a transformer-less "manufacturable" board. `allowPartial: true` downgrades to warnings
 *    and marks the result `completeness: 'partial'`.
 *  - sources are NOT exclusions: a physical board exposes them as connectors (pinrow2) the user
 *    wires the real supply into (info diagnostic).
 *  - footprint pins beyond the mapped ports are declared NC explicitly (info), never silently.
 */
import type { CircuitJson, Component } from '@circuit-forge/eda-core';

import {
    resolveFootprint,
    isLedDiode,
    soicForPinCount,
    type FootprintResolution,
    type PadCountOracle,
} from './footprints';

export type LayoutRole = 'direct' | 'chip-fallback' | 'connectorized' | 'net-only' | 'excluded';

export interface LayoutDiagnostic {
    code: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    componentId?: string;
    /** For diagnostics PASSED THROUGH from a tool (tscircuit/KiCad/freerouting): the tool's own error
     *  type verbatim (e.g. 'pcb_courtyard_overlap_error'). Structured pass-through — no hand-mapping. */
    errorType?: string;
    /** Element/component/net ids the tool attached to the error (extracted generically, as-is). */
    refs?: string[];
}

export interface ComponentPlan {
    component: Component;
    role: LayoutRole;
    /** tscircuit element name for layoutable roles (resistor/capacitor/.../chip/pinheader). */
    element?: string;
    footprint?: FootprintResolution;
    /** For chip-fallback: number of footprint pins left unconnected (NC) beyond the mapped ports. */
    ncPinCount?: number;
}

export interface LayoutabilityResult {
    plans: ComponentPlan[];
    diagnostics: LayoutDiagnostic[];
    /** 'full' = every electrical component is on the board; 'partial' = something was excluded. */
    completeness: 'full' | 'partial';
    /** False when a blocking condition exists (load-bearing exclusion without allowPartial, no
     *  layoutable components, unresolvable footprint). */
    layoutable: boolean;
}

export interface LayoutabilityOptions {
    /** Opt-in: turn load-bearing exclusions into warnings and produce a PARTIAL board. */
    allowPartial?: boolean;
    /**
     * The pad-count / renderability oracle (`loadPadCountOracle()`), injected the same way the routing
     * and DRC tools are. Without it the pad-accounting checks cannot run, and they say so out loud
     * (PCB006) rather than passing — a board is never declared accounted-for by a check that did not run.
     */
    padCount?: PadCountOracle;
}

/** Sim-primitives with no defensible v1 physical mapping. NOTE: our `switch` is the 4-pin
 *  voltage-CONTROLLED SPICE S-device (+,-,c+,c-), not a 2-pin mechanical switch — mapping it to a
 *  pushbutton would silently change the circuit's meaning, so it is excluded too. */
const SIM_PRIMITIVE_TYPES = new Set([
    'transformer',
    'tline',
    'vcvs',
    'vccs',
    'bsource',
    'switch',
    'logic_and',
    'logic_or',
    'logic_nand',
    'logic_nor',
    'logic_xor',
    'logic_xnor',
    'logic_not',
    'logic_buffer',
    'dff',
    'jkff',
    'tff',
    'dlatch',
    'tristate',
]);

export function classifyCircuit(circuit: CircuitJson, opts: LayoutabilityOptions = {}): LayoutabilityResult {
    const plans: ComponentPlan[] = [];
    const diagnostics: LayoutDiagnostic[] = [];
    const excludedSeverity = opts.allowPartial ? 'warning' : 'error';

    // ---- I-IDENTITY: two parts sharing a designator produce a BOM and a pick-and-place file that
    // disagree about what to place (the BOM writes the raw designator, the adapter writes a uniquified
    // one), so the delivered assembly bundle is unassemblable. Nothing else in the pipeline checks this:
    // ERC is client-side only and the API stores the circuit unvalidated.
    const byDesignator = new Map<string, number>();
    for (const c of circuit.components) byDesignator.set(c.designator, (byDesignator.get(c.designator) ?? 0) + 1);
    for (const [designator, n] of byDesignator) {
        if (n > 1) {
            diagnostics.push({
                code: 'PCB014',
                severity: 'error',
                message:
                    `${n} components share the designator "${designator}" — the BOM and the pick-and-place ` +
                    `file would disagree about what to place. Give each part its own designator.`,
            });
        }
    }

    for (const component of circuit.components) {
        plans.push(classifyComponent(component, diagnostics, excludedSeverity, opts.padCount));
    }

    const excluded = plans.filter((p) => p.role === 'excluded');
    const physical = plans.filter(
        (p) => p.role === 'direct' || p.role === 'chip-fallback' || p.role === 'connectorized',
    );

    if (physical.length === 0) {
        diagnostics.push({
            code: 'PCB001',
            severity: 'error',
            message: 'No layoutable components — nothing to place on a board.',
        });
    }

    const completeness: 'full' | 'partial' = excluded.length > 0 ? 'partial' : 'full';
    const layoutable = physical.length > 0 && !diagnostics.some((d) => d.severity === 'error');
    return { plans, diagnostics, completeness, layoutable };
}

function classifyComponent(
    component: Component,
    diagnostics: LayoutDiagnostic[],
    excludedSeverity: 'error' | 'warning',
    padCount?: PadCountOracle,
): ComponentPlan {
    const { type, id, designator } = component;

    if (type === 'ground') {
        return { component, role: 'net-only' };
    }

    // A physical component with ZERO pins would count as layoutable, route vacuously and ship a board
    // nothing ever verified — corrupt input, always an error (never downgraded by allowPartial).
    if (component.pins.length === 0 && !SIM_PRIMITIVE_TYPES.has(type)) {
        diagnostics.push({
            code: 'PCB011',
            severity: 'error',
            componentId: id,
            message: `${designator} (${type}) has no pins — nothing to connect or verify; refusing to place it.`,
        });
        return { component, role: 'excluded' };
    }

    // MOSFET bulk on a DIFFERENT net than source cannot be expressed on a SOT-23 — that omission
    // CHANGES connectivity vs the simulated circuit, so it fails by default like any load-bearing
    // exclusion (allowPartial downgrades to a warning; the adapter then skips the pin silently).
    if (type === 'mosfet') {
        const bulkNet = component.pins.find((p) => p.pinId === 'b')?.netId;
        const sourceNet = component.pins.find((p) => p.pinId === 's')?.netId;
        if (bulkNet !== undefined && bulkNet !== sourceNet) {
            diagnostics.push({
                code: 'PCB010',
                severity: excludedSeverity,
                componentId: id,
                message:
                    `${designator}: MOSFET bulk is on a different net than source — the SOT-23 mapping cannot ` +
                    `express it, so the board would differ from the simulated circuit. Pass allowPartial:true ` +
                    `to accept the omission.`,
            });
        }
    }

    if (SIM_PRIMITIVE_TYPES.has(type)) {
        diagnostics.push({
            code: 'PCB002',
            severity: excludedSeverity,
            componentId: id,
            message:
                `${designator} (${type}) is a simulation primitive with no defensible physical mapping — ` +
                `excluded from the board. A board without it changes the circuit; pass allowPartial:true ` +
                `to accept a PARTIAL board.`,
        });
        return { component, role: 'excluded' };
    }

    if (type === 'voltage_source' || type === 'current_source') {
        const footprint = resolveFootprint(component);
        diagnostics.push({
            code: 'PCB003',
            severity: 'info',
            componentId: id,
            message: `${designator} (${type}) is exposed as a 2-pin connector — wire the real supply/load there.`,
        });
        return { component, role: 'connectorized', element: 'pinheader', footprint: footprint ?? undefined };
    }

    if (type === 'generic') {
        if (!component.footprint) {
            diagnostics.push({
                code: 'PCB004',
                severity: excludedSeverity,
                componentId: id,
                message: `${designator} (generic catalog part) has no footprint — set component.footprint to place it.`,
            });
            return { component, role: 'excluded' };
        }
        const footprint = resolveFootprint(component)!;
        return {
            component,
            role: 'chip-fallback',
            element: 'chip',
            footprint,
            ncPinCount: declareNc(component, footprint.footprint, diagnostics, padCount),
        };
    }

    const footprint = resolveFootprint(component);
    if (!footprint) {
        diagnostics.push({
            code: 'PCB005',
            severity: excludedSeverity,
            componentId: id,
            message:
                `${designator} (${type}, ${component.pins.length} pins) has no curated footprint default — ` +
                `set component.footprint (e.g. "soic20").`,
        });
        return { component, role: 'excluded' };
    }

    // subckt + jfet -> chip fallback; everything else has a direct tscircuit element.
    if (type === 'subckt' || type === 'jfet') {
        return {
            component,
            role: 'chip-fallback',
            element: 'chip',
            footprint,
            ncPinCount: declareNc(component, footprint.footprint, diagnostics, padCount),
        };
    }

    return {
        component,
        role: 'direct',
        element: directElement(component),
        footprint,
        // This call was missing. Every resistor, capacitor, inductor, diode, BJT and MOSFET skipped pad
        // accounting, contradicting declareNc's own docstring — which is why a resistor on a SOIC-8
        // shipped six pads of undeclared copper with no diagnostic of any severity.
        ncPinCount: declareNc(component, footprint.footprint, diagnostics, padCount),
    };
}

/**
 * NC declaration (approval condition 3): footprint pads beyond the mapped pins are DECLARED, never
 * silent — including "unknowable": an override footprint outside the pad-count vocabulary gets an
 * explicit "NC count unknowable" note instead of a silently-assumed zero. Applies to EVERY
 * chip-fallback (subckt, jfet AND generic catalog parts).
 */
function declareNc(
    component: Component,
    footprint: string,
    diagnostics: LayoutDiagnostic[],
    padCount?: PadCountOracle,
): number | undefined {
    if (!padCount) {
        diagnostics.push({
            code: 'PCB006',
            severity: 'info',
            componentId: component.id,
            message: `${component.designator}: no pad-count oracle was supplied — pad accounting did not run.`,
        });
        return undefined;
    }
    const pads = padCount(footprint);
    if (pads === null) {
        // ---- I-FP-VOCAB: the renderer refuses this string. Refuse it HERE, with our own words, instead
        // of letting the job die downstream carrying a tool-internal message the customer cannot act on.
        // These are ordinary catalog values: DO-41, DO-214AC, SOT-23-3, DPAK, TO-252, THT, "2.54mm".
        // Note SMA is accepted while DO-214AC is not — the same physical package, decided by spelling —
        // so the fix for a rejection is an explicit reviewed alias, never a fuzzy match (which would turn
        // a loud failure into a silently wrong package).
        diagnostics.push({
            code: 'PCB012',
            severity: 'error',
            componentId: component.id,
            message:
                `${component.designator} (${component.type}): footprint "${component.footprint ?? footprint}" ` +
                `is not one the board renderer can build. Use a supported package spelling.`,
        });
        return undefined;
    }
    // Pins the adapter DELIBERATELY does not map, so counting them against the package would refuse a
    // part that fits. A MOSFET's bulk is the whole list today: DIRECT_PIN_MAPS.mosfet carries d/g/s only,
    // so bulk never reaches a pad in EITHER case — silently when it sits on the source, and via PCB010
    // (which allowPartial downgrades) when it does not. Re-reporting that here as a package-fit error
    // would state the same physical fact twice, at a severity the caller cannot opt out of.
    const intentionallyUnmapped = component.type === 'mosfet' && component.pins.some((x) => x.pinId === 'b') ? 1 : 0;
    const mappablePins = component.pins.length - intentionallyUnmapped;
    if (mappablePins > pads) {
        // ---- I-PIN-TOTALITY: more legs than the package has. The excess pins simply never become pads,
        // and nothing downstream can see it — a 3-pin BJT on an 0603 shipped with its base absent while
        // parity reported 5/5 isomorphic and KiCad reported unconnected=0, because a pin that never
        // became a port cannot appear as an unconnected item.
        diagnostics.push({
            code: 'PCB013',
            severity: 'error',
            componentId: component.id,
            message:
                `${component.designator} (${component.type}) has ${mappablePins} connectable pin(s) but ` +
                `"${footprint}" has only ${pads} pad(s) — ${mappablePins - pads} leg(s) would be ` +
                `dropped and the board would ship an incomplete part.`,
        });
        return undefined;
    }
    const nc = Math.max(0, pads - mappablePins);
    if (nc > 0) {
        diagnostics.push({
            code: 'PCB006',
            severity: 'info',
            componentId: component.id,
            message: `${component.designator}: ${nc} footprint pin(s) beyond the mapped ports are NC (not connected).`,
        });
    }
    return nc;
}

/** tscircuit element for the directly-supported types (empirically probed catalogue, 2 Tem 2026). */
function directElement(component: Component): string {
    switch (component.type) {
        case 'resistor':
            return 'resistor';
        case 'capacitor':
            return 'capacitor';
        case 'inductor':
            return 'inductor';
        case 'diode':
        case 'zener':
            return isLedDiode(component) ? 'led' : 'diode';
        case 'bjt':
            return 'transistor';
        case 'mosfet':
            return 'mosfet';
        default:
            // Unreachable by construction (classifyComponent routes everything else first); loud guard
            // so a future COMPONENT_TYPES addition cannot silently fall through to a wrong element.
            throw new Error(`directElement: unmapped component type "${component.type}"`);
    }
}

export { soicForPinCount };
