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
    return showReferenceDesignators(converter.getOutputString());
}

/**
 * Print the reference designators. circuit-json-to-kicad emits every footprint property — Reference,
 * Value, Datasheet, Description — with `(hide yes)`, which is right for the three that live on the
 * fabrication layer and wrong for the one that lives on silkscreen: it means our boards ship with a blank
 * white-on-green silkscreen and no R1, C1 or U1 anywhere on them.
 *
 * That is not cosmetic. The designator is how a human finds the part: it is what assembly instructions,
 * rework notes, test procedures and every schematic cross-reference name. A board without them can be
 * populated by a pick-and-place machine reading the PnP file, and by essentially nobody else. It is also
 * the single most recognisable feature of a real PCB, which is why our renders read as toys.
 *
 * Only the Reference property is unhidden, and only its own `(hide yes)`: Value/Datasheet/Description sit
 * on F.Fab, are frequently empty, and printing them would clutter the silkscreen without adding
 * information. Our KiCad rules set `min_silk_clearance` to 0, so nothing here can turn a certified board
 * into a rejected one — and the DRC notary re-judges every board regardless.
 */
export function showReferenceDesignators(kicadPcb: string): string {
    const lines = kicadPcb.split('\n');
    const out: string[] = [];
    let inReference = false;
    for (const line of lines) {
        if (line.includes('(property "Reference"')) inReference = true;
        // A property block ends where the next one begins; `(hide yes)` precedes `(uuid …)` in the
        // generator's output, so a Reference block that somehow lacks the flag simply falls through.
        else if (inReference && /^\s*\(property "/.test(line)) inReference = false;

        if (inReference && /^\s*\(hide yes\)\s*$/.test(line)) {
            inReference = false; // the one flag this block owns — the rest of it is left alone
            continue;
        }
        out.push(line);
    }
    return out.join('\n');
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
