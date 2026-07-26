/**
 * Production outputs: Gerber/drill + .kicad_pcb (+ .kicad_pro rules) via the tscircuit converters
 * (ESM seams), BOM + pick-and-place CSVs from our own data (pure).
 */
import type { LayoutabilityResult } from './layoutability';
import type { TscElement } from './parity';

export interface GerberOutputs {
    /** layer name -> gerber content (F_Cu, B_Cu, F_SilkScreen, ..., Edge_Cuts). */
    layers: Record<string, string>;
    drill: string;
}

export async function generateGerbers(circuitJson: TscElement[]): Promise<GerberOutputs> {
    const mod = await import('circuit-json-to-gerber');
    const layers = mod.stringifyGerberCommandLayers(mod.convertSoupToGerberCommands(circuitJson as never));
    const drill = mod.stringifyExcellonDrill(
        mod.convertSoupToExcellonDrillCommands({ circuitJson: circuitJson as never, is_plated: true }),
    );
    return { layers: layers, drill };
}

export async function generateKicadPcb(circuitJson: TscElement[]): Promise<string> {
    const mod = await import('circuit-json-to-kicad');
    const converter = new mod.CircuitJsonToKicadPcbConverter(circuitJson as never);
    converter.runUntilFinished();
    return converter.getOutputString();
}

// ---------------------------------------------------------------- BOM / PnP (pure)

/** BOM from OUR component data (designator/value/footprint + catalog fields when present). */
export function buildBomCsv(layout: LayoutabilityResult): string {
    const rows: string[][] = [['Designator', 'Type', 'Value', 'Footprint', 'MPN', 'Manufacturer']];
    for (const plan of layout.plans) {
        if (plan.role !== 'direct' && plan.role !== 'chip-fallback' && plan.role !== 'connectorized') continue;
        const c = plan.component;
        rows.push([
            c.designator,
            c.type,
            c.value ?? '',
            plan.footprint?.footprint ?? '',
            c.mpn ?? '',
            c.manufacturer ?? '',
        ]);
    }
    return toCsv(rows);
}

/** Pick-and-place from the EVALUATED board (real placements), joined back to designators. */
export function buildPnpCsv(evaluated: TscElement[]): string {
    const nameById = new Map<string, string>();
    for (const el of evaluated) {
        if (el.type === 'source_component') nameById.set(String(el.source_component_id), String(el.name));
    }
    const rows: string[][] = [['Designator', 'MidX(mm)', 'MidY(mm)', 'Rotation', 'Layer']];
    for (const el of evaluated) {
        if (el.type !== 'pcb_component') continue;
        rows.push([
            nameById.get(String(el.source_component_id)) ?? String(el.source_component_id),
            String(el.center && typeof el.center === 'object' ? (el.center as { x: number }).x : ''),
            String(el.center && typeof el.center === 'object' ? (el.center as { y: number }).y : ''),
            String(el.rotation ?? 0),
            String(el.layer ?? 'top'),
        ]);
    }
    return toCsv(rows);
}

function toCsv(rows: string[][]): string {
    return rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';
}

function csvEscape(v: string): string {
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
