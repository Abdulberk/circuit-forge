/**
 * Production outputs: Gerber/drill + .kicad_pcb (+ .kicad_pro rules) via the tscircuit converters
 * (ESM seams), BOM + pick-and-place CSVs from our own data (pure).
 */
import type { LayoutabilityResult } from '@circuit-forge/pcb-preflight';

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

/**
 * Does this board carry visible reference designators on a silkscreen layer?
 *
 * WHY THIS IS A FUNCTION AND NOT AN ASSUMPTION. circuit-json-to-kicad writes each designator TWICE: as a
 * modern `(property "Reference" …)` carrying `(hide yes)`, and as a legacy `(fp_text reference …)` that is
 * visible. Reading the source, the hidden property looks like a blank silkscreen — it is not; kicad-cli
 * plots the fp_text, and re-hiding the property leaves the F.Silkscreen gerber byte-identical (measured).
 * The board has always been labelled.
 *
 * What is NOT guaranteed is that it stays that way. `fp_text` is the deprecated half of that pair, and the
 * day a converter or KiCad release drops it, the property is all that is left and every board silently
 * ships blank — assemblable by a pick-and-place machine reading the PnP file, and by essentially nobody
 * else. Nothing downstream would notice: silkscreen carries no design rule, so DRC stays clean and the
 * manufacturability verdict does not move. So the property is left exactly as the converter emits it, and
 * the OUTPUT is checked instead of the input.
 */
export function hasVisibleDesignators(kicadPcb: string): boolean {
    // Either representation counts as long as it is not hidden — the question is what gets plotted, not
    // which of the two spellings the converter happens to use this year.
    for (const m of kicadPcb.matchAll(/\((?:fp_text\s+reference|property "Reference")[\s\S]{0,400}?\n {4}\)/g)) {
        if (/\(layer "?[FB]\.SilkS/.test(m[0]) && !m[0].includes('(hide yes)')) return true;
    }
    return false;
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

/**
 * Component placements in the DESIGN frame — a preview, and NOT a fab artifact.
 *
 * The name carries the warning because the old one did not. This was exported as `pnpCsv` and shipped
 * inside the same bundle as gerbers plotted by kicad-cli from the .kicad_pcb, and the two frames were
 * apart by exactly (+100, −100) mm on every board: the converter places the board at an offset when it
 * writes the board file, and these coordinates never went through it. A machine fed that pair puts every
 * part 100 mm off the copper.
 *
 * A real pick-and-place file can only be plotted from the board that ships, which means kicad-cli, which
 * means the worker — see `exportPos` there. Nothing in this package can produce one, so nothing in this
 * package should offer something that looks like one.
 */
export function buildPlacementPreviewCsv(evaluated: TscElement[]): string {
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
