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

import { resolveFootprint, isLedDiode, soicForPinCount, footprintPadCount, type FootprintResolution } from './footprints';

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

    for (const component of circuit.components) {
        plans.push(classifyComponent(component, diagnostics, excludedSeverity));
    }

    const excluded = plans.filter((p) => p.role === 'excluded');
    const physical = plans.filter((p) => p.role === 'direct' || p.role === 'chip-fallback' || p.role === 'connectorized');

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
            ncPinCount: declareNc(component, footprint.footprint, diagnostics),
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
            ncPinCount: declareNc(component, footprint.footprint, diagnostics),
        };
    }

    return { component, role: 'direct', element: directElement(component), footprint };
}

/**
 * NC declaration (approval condition 3): footprint pads beyond the mapped pins are DECLARED, never
 * silent — including "unknowable": an override footprint outside the pad-count vocabulary gets an
 * explicit "NC count unknowable" note instead of a silently-assumed zero. Applies to EVERY
 * chip-fallback (subckt, jfet AND generic catalog parts).
 */
function declareNc(component: Component, footprint: string, diagnostics: LayoutDiagnostic[]): number | undefined {
    const pads = footprintPadCount(footprint);
    if (pads === null) {
        diagnostics.push({
            code: 'PCB006',
            severity: 'info',
            componentId: component.id,
            message: `${component.designator}: pad count of footprint "${footprint}" is outside the curated vocabulary — NC pin count unknowable (pins mapped positionally; verify the package).`,
        });
        return undefined;
    }
    const nc = Math.max(0, pads - component.pins.length);
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
