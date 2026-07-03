/**
 * Fab profile — the single source of truth for manufacturing constraints (brief §10.4 / §9.4).
 *
 * The same profile is applied on BOTH sides of the pipeline:
 *  - upstream, as tscircuit board props (`minTraceWidth`, empirically verified effective 2 Tem 2026;
 *    `autorouter={{ local: true }}` pins the LOCAL router — deterministic, network-free);
 *  - downstream, as KiCad design rules in the generated `.kicad_pro` (KiCad project files are plain
 *    JSON; kicad-cli picks the sibling project up for DRC) — so the notary checks exactly the rules
 *    the adapter enforced. One profile, two enforcement points, no drift.
 *
 * `perNetMinWidthMm` is the Faz-3 hook: IPC-2221 widths land here per net name; Phase 1 carries the
 * field through without computing it.
 */

export interface FabProfile {
    minTraceWidthMm: number;
    minClearanceMm: number;
    viaDrillMm: number;
    viaAnnularMm: number;
    /**
     * Clearance freerouting keeps around VIAS (track↔via, via↔via, via↔pad). freerouting applies the
     * general clearance to wire↔wire but a laxer default to via types, so an unset via clearance lets it
     * place a via ~0.12mm from a track — below the 0.2mm KiCad rule (proven live 3 Tem 2026). Defaults to
     * 1.25× minClearance so a routed via is DRC-clean without over-spacing signal tracks. */
    viaClearanceMm?: number;
    /** Faz-3 (IPC-2221) hook: per-net minimum trace width, keyed by EMITTED net name (e.g. "GND"). */
    perNetMinWidthMm?: Record<string, number>;
    /** Pour the ground plane (bottom layer) when a GND net exists. */
    gndPour?: boolean;
}

/** JLC-compatible conservative defaults (see PCB_VERIFICATION §3.3; annular 0.15 = our safe default,
 *  0.1 is the absolute fab floor). */
export const JLC_FAB_PROFILE: FabProfile = {
    minTraceWidthMm: 0.2,
    minClearanceMm: 0.2,
    viaDrillMm: 0.3,
    viaAnnularMm: 0.15,
    gndPour: true,
};

/** Board-tag props enforcing the profile upstream (verified knobs only). */
export function boardExtraProps(profile: FabProfile): string {
    return `autorouter={{ local: true }} minTraceWidth={${profile.minTraceWidthMm}}`;
}

/**
 * Minimal KiCad project (.kicad_pro) carrying the profile as board design rules. kicad-cli loads the
 * sibling project for `pcb drc`, so violations are judged against OUR profile, not KiCad defaults.
 */
export function kicadProjectJson(profile: FabProfile): string {
    const viaDiameter = round3(profile.viaDrillMm + 2 * profile.viaAnnularMm);
    return JSON.stringify(
        {
            board: {
                design_settings: {
                    rules: {
                        min_clearance: profile.minClearanceMm,
                        min_connection: profile.minTraceWidthMm,
                        min_copper_edge_clearance: 0.3,
                        min_hole_clearance: 0.25,
                        min_hole_to_hole: 0.25,
                        min_microvia_diameter: 0.2,
                        min_microvia_drill: 0.1,
                        min_resolved_spokes: 1,
                        min_silk_clearance: 0.0,
                        min_text_height: 0.8,
                        min_text_thickness: 0.08,
                        min_through_hole_diameter: profile.viaDrillMm,
                        min_track_width: profile.minTraceWidthMm,
                        min_via_annular_width: profile.viaAnnularMm,
                        min_via_diameter: viaDiameter,
                    },
                },
            },
            meta: { filename: 'board.kicad_pro', version: 3 },
        },
        null,
        1,
    );
}

/**
 * Report vias whose geometry is below the fab profile. DELIBERATELY NON-MUTATING: enlarging vias
 * AFTER routing manufactures shorts (proven live 3 Tem 2026 — a 0.3->0.6 via overlapped an adjacent
 * track the router had cleared for 0.3, and the notary flagged "shorting_items"). The local router's
 * via knobs are accepted-but-ignored upstream, so undersized vias are an honest ROUTER limitation:
 * we surface them loudly and the Phase-2 quality tier (freerouting routes WITH the profile's via
 * padstack from the start) owns the fix.
 */
export function reportViaCompliance(
    evaluated: Array<{ type: string; [k: string]: unknown }>,
    profile: FabProfile,
): { total: number; undersized: number } {
    let total = 0;
    let undersized = 0;
    const minOuter = round3(profile.viaDrillMm + 2 * profile.viaAnnularMm);
    for (const el of evaluated) {
        if (el.type !== 'pcb_via') continue;
        total++;
        const hole = Number(el.hole_diameter ?? 0);
        const outer = Number(el.outer_diameter ?? 0);
        if (hole < profile.viaDrillMm || outer < minOuter) undersized++;
    }
    return { total, undersized };
}

/**
 * Inject a copper-pour zone for `netName` into a generated .kicad_pcb (text level — the exact
 * mechanism proven in the Faz-0 spike: zone in, `kicad-cli pcb drc --refill-zones --save-board`
 * fills it headless, the fill lands in the copper gerber). Returns null when the net does not exist
 * in the board file (caller downgrades the pour with a diagnostic — never a silent no-op).
 *
 * The polygon uses the Edge.Cuts bounding box when derivable; KiCad clips the fill to the board
 * outline anyway, so a conservative over-cover is safe.
 *
 * SAFETY PRECONDITION (found live, 3 Tem 2026): circuit-json-to-kicad@0.0.156 writes copper
 * `(segment ...)` blocks WITHOUT a `(net N)` assignment. Filling a zone against un-netted copper
 * makes the filler/DRC see foreign copper with no net identity -> false "shorting_items". Until the
 * upstream converter nets its segments, injecting a pour would CREATE shorts on paper — so we refuse
 * unless the board's segments carry nets ('unsafe' result; the caller reports it honestly).
 */
export type ZoneInjectionResult = { kind: 'ok'; kicadPcb: string } | { kind: 'no-net' } | { kind: 'unsafe-unnetted-copper' };

export function injectZone(kicadPcb: string, netName: string, layer: 'F.Cu' | 'B.Cu' = 'B.Cu'): ZoneInjectionResult {
    const netMatch = kicadPcb.match(new RegExp(`\\(net (\\d+) "${escapeRegExp(netName)}"\\)`));
    if (!netMatch) return { kind: 'no-net' };
    const netNumber = netMatch[1]!;

    const segmentBlocks = kicadPcb.match(/\(segment[\s\S]*?\n\s*\)/g) ?? [];
    if (segmentBlocks.length > 0 && !segmentBlocks.every((s) => /\(net \d+\)/.test(s))) {
        return { kind: 'unsafe-unnetted-copper' };
    }

    const box = edgeCutsBbox(kicadPcb) ?? allCoordsBbox(kicadPcb);
    if (!box) return { kind: 'no-net' };
    const { minX, minY, maxX, maxY } = box;

    const zone = [
        '',
        `  (zone (net ${netNumber}) (net_name "${netName}") (layer "${layer}") (hatch edge 0.5)`,
        '    (connect_pads (clearance 0.3)) (min_thickness 0.25)',
        '    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))',
        `    (polygon (pts (xy ${minX} ${minY}) (xy ${maxX} ${minY}) (xy ${maxX} ${maxY}) (xy ${minX} ${maxY}))))`,
        '',
    ].join('\n');
    return { kind: 'ok', kicadPcb: kicadPcb.replace(/\)\s*$/, `${zone})\n`) };
}

interface Bbox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** Bounding box of Edge.Cuts graphics (each gr_* block that names the layer). */
function edgeCutsBbox(kicadPcb: string): Bbox | null {
    const blocks = kicadPcb.match(/\(gr_(line|rect|poly|arc|circle)[\s\S]*?Edge\.Cuts[\s\S]*?\n\s*\)/g);
    if (!blocks?.length) return null;
    const pts: Array<[number, number]> = [];
    for (const b of blocks) {
        for (const m of b.matchAll(/\((?:start|end|xy|center) ([-\d.]+) ([-\d.]+)\)/g)) {
            pts.push([Number(m[1]), Number(m[2])]);
        }
    }
    return bboxOf(pts);
}

/** Fallback: every coordinate in the file (safe over-cover — the filler clips to the outline). */
function allCoordsBbox(kicadPcb: string): Bbox | null {
    const pts: Array<[number, number]> = [];
    for (const m of kicadPcb.matchAll(/\(start ([-\d.]+) ([-\d.]+)\)/g)) {
        pts.push([Number(m[1]), Number(m[2])]);
    }
    return bboxOf(pts);
}

function bboxOf(pts: Array<[number, number]>): Bbox | null {
    if (!pts.length) return null;
    return {
        minX: Math.min(...pts.map((p) => p[0])),
        minY: Math.min(...pts.map((p) => p[1])),
        maxX: Math.max(...pts.map((p) => p[0])),
        maxY: Math.max(...pts.map((p) => p[1])),
    };
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function round3(n: number): number {
    return Math.round(n * 1000) / 1000;
}
