/**
 * BOM (Bill of Materials) builder: aggregates a version's CircuitJson components into a purchasable
 * parts list. Components are grouped by their REAL part identity (mpn+manufacturer when sourced from the
 * catalog; otherwise type+value as an "unsourced" line), quantities summed, designators collected, and
 * line cost computed from the stored quantity-1 unit cost (price-break-aware costing would need a live
 * catalog round-trip — deliberately out of scope; the stored unitCost gives an honest upper-bound figure).
 * Non-physical schematic artifacts (ground symbols) are excluded.
 */
import type { CircuitJson } from '@circuit-forge/eda-core';
import { Injectable } from '@nestjs/common';

export interface BomLine {
    /** Real manufacturer part number when the component was sourced from the catalog; null for unsourced. */
    mpn: string | null;
    manufacturer: string | null;
    /** Component type + value, e.g. "resistor 330" — the design-side identity. */
    type: string;
    value: string | null;
    footprint: string | null;
    quantity: number;
    designators: string[];
    /** From the stored sourcing snapshot (quantity-1 price); null when never sourced/priced. */
    unitCost: number | null;
    currency: string | null;
    lineCost: number | null; // quantity * unitCost
    stock: number | null;
    supplier: string | null;
    supplierId: string | null;
    datasheetUrl: string | null;
    /** True when the part carries no catalog sourcing — it needs manual sourcing before purchase. */
    unsourced: boolean;
}

export interface Bom {
    lines: BomLine[];
    totals: {
        components: number; // physical components counted (ground excluded)
        uniqueParts: number;
        /** Sum of priced lines only, per currency (multi-currency BOMs are summed separately, never mixed). */
        costByCurrency: Record<string, number>;
        unsourcedLines: number;
    };
}

@Injectable()
export class BomService {
    /** Build the aggregated BOM from a circuit. Pure — no I/O. */
    build(circuit: CircuitJson): Bom {
        const lines = new Map<string, BomLine>();
        let componentCount = 0;

        for (const c of circuit.components) {
            if (c.type === 'ground') continue; // schematic symbol, not a part
            componentCount++;
            // Group key: real part identity first (mpn|manufacturer), else design identity (type|value).
            const key = c.mpn
                ? `mpn:${c.mpn}|${c.manufacturer ?? ''}`
                : `gen:${c.type}|${c.value ?? ''}|${c.model ?? ''}`;
            let line = lines.get(key);
            if (!line) {
                line = {
                    mpn: c.mpn ?? null,
                    manufacturer: c.manufacturer ?? null,
                    type: c.type,
                    value: c.value ?? null,
                    footprint: c.footprint ?? null,
                    quantity: 0,
                    designators: [],
                    unitCost: c.sourcing?.unitCost ?? null,
                    currency: c.sourcing?.currency ?? null,
                    lineCost: null,
                    stock: c.sourcing?.stock ?? null,
                    supplier: c.sourcing?.supplier ?? null,
                    supplierId: c.sourcing?.supplierId ?? null,
                    datasheetUrl: c.sourcing?.datasheetUrl ?? null,
                    unsourced: !c.mpn,
                };
                lines.set(key, line);
            }
            line.quantity += 1;
            line.designators.push(c.designator);
        }

        const out = [...lines.values()].map((l) => ({
            ...l,
            lineCost: l.unitCost !== null ? Number((l.unitCost * l.quantity).toPrecision(6)) : null,
        }));
        // Stable, purchase-friendly order: sourced lines first, then by type/designator.
        out.sort((a, b) => Number(a.unsourced) - Number(b.unsourced) || a.type.localeCompare(b.type) || (a.designators[0] ?? '').localeCompare(b.designators[0] ?? ''));

        const costByCurrency: Record<string, number> = {};
        for (const l of out) {
            if (l.lineCost !== null && l.currency) {
                costByCurrency[l.currency] = Number(((costByCurrency[l.currency] ?? 0) + l.lineCost).toPrecision(6));
            }
        }

        return {
            lines: out,
            totals: {
                components: componentCount,
                uniqueParts: out.length,
                costByCurrency,
                unsourcedLines: out.filter((l) => l.unsourced).length,
            },
        };
    }

    /** RFC4180-ish CSV rendering of a BOM (quotes fields containing separators/quotes). */
    toCsv(bom: Bom): string {
        const esc = (v: string | number | null): string => {
            if (v === null || v === undefined) return '';
            const s = String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const header = 'designators,quantity,type,value,mpn,manufacturer,footprint,unit_cost,currency,line_cost,stock,supplier,supplier_id,datasheet,unsourced';
        const rows = bom.lines.map((l) =>
            [
                esc(l.designators.join(' ')),
                l.quantity,
                esc(l.type),
                esc(l.value),
                esc(l.mpn),
                esc(l.manufacturer),
                esc(l.footprint),
                esc(l.unitCost),
                esc(l.currency),
                esc(l.lineCost),
                esc(l.stock),
                esc(l.supplier),
                esc(l.supplierId),
                esc(l.datasheetUrl),
                l.unsourced ? 'yes' : 'no',
            ].join(','),
        );
        return [header, ...rows].join('\n') + '\n';
    }
}
