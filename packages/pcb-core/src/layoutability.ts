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
import { resolveFootprint, isLedDiode, soicForPinCount, type FootprintResolution } from './footprints';

export type LayoutRole = 'direct' | 'chip-fallback' | 'connectorized' | 'net-only' | 'excluded';

export interface LayoutDiagnostic {
    code: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    componentId?: string;
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

/** SOIC ladder pin counts for the NC computation. */
const SOIC_PINS: Record<string, number> = { soic8: 8, soic14: 14, soic16: 16, dip8: 8, dip14: 14, dip16: 16 };

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
        return {
            component,
            role: 'chip-fallback',
            element: 'chip',
            footprint: resolveFootprint(component) ?? undefined,
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
        const footprintPins = SOIC_PINS[footprint.footprint] ?? (type === 'jfet' ? 3 : component.pins.length);
        const nc = Math.max(0, footprintPins - component.pins.length);
        if (nc > 0) {
            // Approval condition 3: unmapped footprint pins are DECLARED, never silent (the ideal
            // op-amp case: 5 ports on a SOIC-8 -> 3 NC pins).
            diagnostics.push({
                code: 'PCB006',
                severity: 'info',
                componentId: id,
                message: `${designator}: ${nc} footprint pin(s) beyond the mapped ports are NC (not connected).`,
            });
        }
        return { component, role: 'chip-fallback', element: 'chip', footprint, ncPinCount: nc };
    }

    return { component, role: 'direct', element: directElement(component), footprint };
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
