/**
 * DRC report parsing + airwire derivation (LAYOUTJOB_PLAN.md v2, M1b).
 *
 * The review caught that per-connection routedness is LOST on the quality/freerouting board, so
 * airwires (the "not-yet-routed" ratsnest lines Flux shows as "Airwires • N") must come from the
 * KiCad notary's `unconnected_items`, NOT from the soup. These are PURE helpers over a parsed
 * kicad-cli DRC report; the worker (M3) runs `kicad-cli pcb drc --format json` and feeds it here.
 *
 * Schema verified against a real kicad-cli 10 report (7 Tem 2026): every entry (violation OR
 * unconnected) is { type, severity, description, items:[{description, pos:{x,y}, uuid}] }, and an
 * unconnected item's net sits in its description as "Pad N [NET] of DESIG on LAYER".
 *
 * COORDINATE FRAME: DRC positions are in KiCad page space (board placed at a +offset), NOT the
 * board-centered soup frame the shaped geometry uses. So airwires are drawn between OUR pad
 * coordinates (matched by designator+net), never the raw DRC pos — frame-mismatch-proof.
 */
import type { LayoutGeometry, Pt } from './layout-result';

export interface DrcItem {
    description: string;
    pos?: { x: number; y: number };
    uuid?: string;
}
export interface DrcEntry {
    type: string;
    severity: string;
    description: string;
    items: DrcItem[];
}
export interface ParsedDrc {
    /** 0 violations AND 0 unconnected — the notary's manufacturable definition. */
    clean: boolean;
    violations: DrcEntry[];
    unconnected: DrcEntry[];
}
export interface DrcCheck {
    /** coarse group (Flux "Reviews" panel sections); KiCad's exact type kept in `type`. */
    category: string;
    type: string;
    severity: string;
    message: string;
    /** first item position (KiCad page frame) if any, for a "jump to" affordance. */
    location: { x: number; y: number } | null;
    /** component designators referenced by the entry (parsed from item descriptions). */
    refs: string[];
}
export interface Airwire {
    net: string;
    from: Pt;
    to: Pt;
}

/** Normalize a raw kicad-cli DRC JSON into violations + unconnected + a clean verdict. */
export function parseDrcReport(json: unknown): ParsedDrc {
    const j = (json ?? {}) as { violations?: DrcEntry[]; unconnected_items?: DrcEntry[] };
    const violations = Array.isArray(j.violations) ? j.violations : [];
    const unconnected = Array.isArray(j.unconnected_items) ? j.unconnected_items : [];
    return { clean: violations.length === 0 && unconnected.length === 0, violations, unconnected };
}

/**
 * Coarse category for a KiCad DRC type — grouped like the Flux "Reviews" panel. Small known map with
 * a verbatim pass-through default (same philosophy as the error pass-through: never a giant hand table,
 * unknown types flow through un-dropped).
 */
const CATEGORY: Record<string, string> = {
    unconnected_items: 'unconnected',
    clearance: 'clearance',
    hole_clearance: 'clearance',
    tracks_crossing: 'clearance',
    track_dangling: 'dangling',
    via_dangling: 'dangling',
    annular_width: 'via_drill',
    via_diameter: 'via_drill',
    drill_out_of_range: 'via_drill',
    hole_to_hole: 'via_drill',
    copper_overlap: 'copper',
    copper_sliver: 'copper',
    zone_has_empty_net: 'copper',
    courtyards_overlap: 'placement',
    silk_over_copper: 'silk',
    silk_overlap: 'silk',
    missing_footprint: 'footprint',
};
export function drcCategory(type: string): string {
    return CATEGORY[type] ?? 'other';
}

/** Parse "Pad 1 [A] of LED1 on F.Cu" → { net, designator }. net is '' when the pad has no net ([]). */
function parseItemDesc(description: string): { net: string; designator: string } | null {
    const m = /\[([^\]]*)\]\s+of\s+(\S+)/.exec(description);
    return m ? { net: m[1] ?? '', designator: m[2] ?? '' } : null;
}

/** Categorized checks for the contract's `checks.drc[]` (violations only; unconnected surfaces as airwires). */
export function drcToChecks(report: ParsedDrc): DrcCheck[] {
    return report.violations.map((v) => ({
        category: drcCategory(v.type),
        type: v.type,
        severity: v.severity,
        message: v.description,
        location: v.items[0]?.pos ?? null,
        refs: [...new Set(v.items.map((it) => parseItemDesc(it.description)?.designator).filter((d): d is string => !!d))],
    }));
}

/**
 * Airwires (ratsnest) from the notary's unconnected_items, drawn between OUR shaped pad coordinates.
 * Each unconnected entry names the two pads that should connect (by designator + net in their
 * descriptions); we look those pads up in the shaped geometry and emit a line between them — so the
 * endpoints live in the same frame the FE already renders (never the raw DRC page coords).
 * Unmatched entries (rare designator/net ambiguity) are skipped, not faked.
 */
export function airwiresFromDrc(report: ParsedDrc, geo: LayoutGeometry): { airwires: Airwire[]; unmatched: number } {
    const designatorByCompId = new Map(geo.components.map((c) => [c.id, c.designator]));
    const padByDesigNet = new Map<string, Pt>();
    for (const p of geo.pads) {
        const d = designatorByCompId.get(p.componentId);
        if (d && p.net) padByDesigNet.set(`${d}|${p.net}`, { x: p.x, y: p.y });
    }
    const airwires: Airwire[] = [];
    let unmatched = 0;
    for (const entry of report.unconnected) {
        const parsed = entry.items.map((it) => parseItemDesc(it.description));
        const net = parsed.find((p) => p?.net)?.net ?? '';
        if (!net || parsed.length < 2 || !parsed[0] || !parsed[1]) { unmatched++; continue; }
        const from = padByDesigNet.get(`${parsed[0].designator}|${net}`);
        const to = padByDesigNet.get(`${parsed[1].designator}|${net}`);
        if (from && to) airwires.push({ net, from, to });
        else unmatched++;
    }
    return { airwires, unmatched };
}
