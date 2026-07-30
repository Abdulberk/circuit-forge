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
 * coordinates (matched by designator+pad, with designator+net as fallback), never the raw DRC pos —
 * frame-mismatch-proof.
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
    /** 0 BLOCKING violations AND 0 unconnected — the notary's manufacturable definition. */
    clean: boolean;
    /** Blocking violations only — what `clean` is decided on and what withholds the fab bundle. */
    violations: DrcEntry[];
    /** Non-blocking findings KiCad rates below error. Real defects, reported and never gated on — see
     *  `parseDrcReport`. Empty until a report is produced at a severity that includes them. */
    warnings: DrcEntry[];
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

/**
 * Severities KiCad rates below "error". A finding at one of these is real but does not withhold the fab
 * bundle — a silkscreen label a fraction under the declared minimum text height is worth reporting and is
 * not worth refusing to build a board over.
 *
 * Anything NOT in this list blocks, including a severity we do not recognise. That direction is deliberate:
 * if KiCad renames a level or a report arrives without one, the board must fail the gate and be looked at,
 * never sail through it. An unknown severity is an unknown risk.
 */
const NON_BLOCKING_SEVERITIES = new Set(['warning', 'ignore', 'exclusion', 'info']);

/**
 * Normalize a raw kicad-cli DRC JSON into blocking violations + warnings + unconnected + a clean verdict.
 *
 * WHY SEVERITY IS SPLIT HERE (30 Tem 2026). Both runners used to ask kicad-cli for `--severity-error`, so
 * the report physically could not contain anything else and every entry in it was blocking by
 * construction. That made the reports agree with the gate — and made the gate the only thing anyone could
 * see. Measured across all eight gallery boards, asking for every severity surfaced 349 findings on boards
 * that all reported "0 violations": the reference designators on every board are printed under the minimum
 * text height WE declared, three boards have silkscreen running off the edge or overlapping, and one has a
 * copper island not connected to its net. None of that was wrong of the gate to allow through. All of it
 * was wrong to be invisible — "DRC-clean" read as "nothing to say about this board".
 *
 * So the report now carries everything and this function decides what blocks. The gate is UNCHANGED: only
 * error-severity entries land in `violations`, so a board that passed before passes now.
 */
export function parseDrcReport(json: unknown): ParsedDrc {
    const j = (json ?? {}) as { violations?: DrcEntry[]; unconnected_items?: DrcEntry[] };
    const all = Array.isArray(j.violations) ? j.violations : [];
    const unconnected = Array.isArray(j.unconnected_items) ? j.unconnected_items : [];
    const violations = all.filter((v) => !NON_BLOCKING_SEVERITIES.has(String(v?.severity).toLowerCase()));
    const warnings = all.filter((v) => NON_BLOCKING_SEVERITIES.has(String(v?.severity).toLowerCase()));
    return { clean: violations.length === 0 && unconnected.length === 0, violations, warnings, unconnected };
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

/** Parse "Pad 1 [A] of LED1 on F.Cu" → { pad, net, designator }. `pad` is the KiCad pad name/number, present
 *  only for pad items (absent for e.g. "Track [B] of R2"); net is '' when the pad has no net ([]). */
function parseItemDesc(description: string): { pad?: string; net: string; designator: string } | null {
    const m = /\[([^\]]*)\]\s+of\s+(\S+)/.exec(description);
    if (!m) return null;
    const padM = /\bPad\s+(\S+)\s+\[/.exec(description);
    return { pad: padM?.[1], net: m[1] ?? '', designator: m[2] ?? '' };
}

/**
 * Categorized checks for the contract's `checks.drc[]` — every finding KiCad reported, blocking or not
 * (unconnected nets surface separately as airwires).
 *
 * Warnings are included rather than filtered out. They do not move the manufacturability verdict and are
 * not meant to: each entry carries its own `severity`, so a consumer can present "blocks the build" and
 * "worth looking at" differently. Dropping them here would put the list back in exactly the state the
 * severity split was made to end — a board reporting nothing to say about itself while its labels are
 * printed under the minimum height we declared.
 */
export function drcToChecks(report: ParsedDrc): DrcCheck[] {
    return [...report.violations, ...report.warnings].map((v) => ({
        category: drcCategory(v.type),
        type: v.type,
        severity: v.severity,
        message: v.description,
        // `items` is present on every real kicad-cli 10 entry, but an entry without it must still be
        // REPORTED as a violation with no location — losing the whole verdict to a missing detail field
        // would turn an honest "not manufacturable" into an opaque crash.
        location: v.items?.[0]?.pos ?? null,
        refs: [
            ...new Set(
                (v.items ?? []).map((it) => parseItemDesc(it.description)?.designator).filter((d): d is string => !!d),
            ),
        ],
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
    // Two indexes: designator|pad uniquely identifies a pad (so a part with 2+ pads on ONE net resolves to the
    // exact pad the DRC named); designator|net is the fallback (correct when the part has a single pad on that
    // net, and it also covers pad-name↔pin mismatches — e.g. KiCad "Pad 1" vs a semantic pin "anode").
    const padByDesigPin = new Map<string, Pt>();
    const padByDesigNet = new Map<string, Pt>();
    for (const p of geo.pads) {
        const d = designatorByCompId.get(p.componentId);
        if (!d) continue;
        if (p.pin) padByDesigPin.set(`${d}|${p.pin}`, { x: p.x, y: p.y });
        if (p.net) padByDesigNet.set(`${d}|${p.net}`, { x: p.x, y: p.y }); // last-wins — fallback only
    }
    // Prefer the exact pad the DRC names ("Pad N"); fall back to designator|net when the pad name doesn't match
    // a pin (or is absent). `net` is the entry's shared unconnected net (both endpoints are on it).
    const locate = (item: { pad?: string; designator: string }, net: string): Pt | undefined =>
        (item.pad !== undefined ? padByDesigPin.get(`${item.designator}|${item.pad}`) : undefined) ??
        padByDesigNet.get(`${item.designator}|${net}`);
    const airwires: Airwire[] = [];
    let unmatched = 0;
    for (const entry of report.unconnected) {
        // Same reasoning: an entry we cannot read becomes an UNMATCHED airwire (counted, disclosed),
        // never an exception that discards every other finding in the report.
        const parsed = (entry.items ?? []).map((it) => parseItemDesc(it.description));
        const net = parsed.find((p) => p?.net)?.net ?? '';
        if (!net || parsed.length < 2 || !parsed[0] || !parsed[1]) {
            unmatched++;
            continue;
        }
        const from = locate(parsed[0], net);
        const to = locate(parsed[1], net);
        if (from && to) airwires.push({ net, from, to });
        else unmatched++;
    }
    return { airwires, unmatched };
}
