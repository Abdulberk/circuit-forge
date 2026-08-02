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
     * Explicit clearance freerouting must keep around VIAS (track↔via, via↔via, via↔pad). Normally leave
     * unset — it defaults to `minClearance + viaClearanceGuardMm`. Set only to force a specific value.
     */
    viaClearanceMm?: number;
    /**
     * FIXED guard added to minClearance for via clearance. freerouting's via-clearance model runs tighter
     * than KiCad measures it, and the gap GROWS with layout density (measured live 3 Tem 2026: sparse
     * boards need ~0.03mm, but dense multi-via boards — 555, 74HC00, 4017 — leave a via ~0.08–0.10mm tight
     * of the rule). It is an additive geometric offset, NOT proportional (a scale factor under-guards tight
     * HDI profiles). Default 0.10mm clears every gauntlet circuit; raise it if a dense board still trips a
     * via↔track clearance. */
    viaClearanceGuardMm?: number;
    /** Copper weight (oz) for IPC-2221 width sizing — 1 oz = 35 µm = 1.378 mil (default 1). */
    copperOz?: number;
    /** Allowed trace temperature rise (°C) for IPC-2221 width sizing (default 10 — conservative). */
    deltaTC?: number;
    /** Per-net minimum trace width, keyed by EMITTED net name (e.g. "GND"). Computed from IPC-2221 when
     *  net currents are supplied; can also be set explicitly to force a width. */
    perNetMinWidthMm?: Record<string, number>;
    /** Pour the ground plane (bottom layer) when a GND net exists. */
    gndPour?: boolean;
    /** Lever 2 placement grid (mm) — the SAME value must drive FE snapping and BE legalization
     *  (single-source geometry contract, PLACEMENT_PLAN.md §7.3). Default 0.5. */
    placementGridMm?: number;
    /** Lever 2 keep-back from the board edge for part courtyards (mm). Default 4. */
    placementMarginMm?: number;
    /**
     * Narrowest silkscreen stroke the fab will PRINT. Below it the art is not rejected, it is deleted —
     * so a board can arrive with its reference designators silently missing. Default 0.15 mm (JLCPCB and
     * PCBWay's published floor; Eurocircuits 0.10, OSH Park 0.127 — 0.15 satisfies all of them).
     */
    minSilkWidthMm?: number;
    /**
     * Shortest silkscreen character worth printing. The converter scales a designator to the part it
     * labels, which puts `R1` at 0.267 mm on an 0603 — geometry a fab can print and nobody can read.
     * Default 0.8 mm, the smallest height commonly cited as legible on a populated board.
     */
    minSilkTextHeightMm?: number;
}

/**
 * Fab capability tiers (JLCPCB 2-layer, real published limits). Pick by cost/density:
 *  - economy  — cheapest, most robust; 0.2mm track/space, 0.3mm drill (the conservative default).
 *  - standard — JLCPCB standard process; 0.127mm (5 mil) track/space, 0.25mm drill.
 *  - advanced — JLCPCB advanced/HDI; 0.0889mm (3.5 mil) track/space, 0.2mm drill.
 * All verified to route DRC-clean through the quality pipeline (the via guard holds at each tier).
 */
export const FAB_TIERS: Record<'economy' | 'standard' | 'advanced', FabProfile> = {
    economy: {
        minTraceWidthMm: 0.2,
        minClearanceMm: 0.2,
        viaDrillMm: 0.3,
        viaAnnularMm: 0.15,
        copperOz: 1,
        deltaTC: 10,
        gndPour: true,
        minSilkWidthMm: 0.15,
        minSilkTextHeightMm: 0.8,
    },
    standard: {
        minTraceWidthMm: 0.127,
        minClearanceMm: 0.127,
        viaDrillMm: 0.25,
        viaAnnularMm: 0.13,
        copperOz: 1,
        deltaTC: 10,
        gndPour: true,
        minSilkWidthMm: 0.15,
        minSilkTextHeightMm: 0.8,
    },
    advanced: {
        minTraceWidthMm: 0.0889,
        minClearanceMm: 0.0889,
        viaDrillMm: 0.2,
        viaAnnularMm: 0.1,
        copperOz: 1,
        deltaTC: 10,
        gndPour: true,
        minSilkWidthMm: 0.15,
        minSilkTextHeightMm: 0.8,
    },
};

/** JLC-compatible conservative default = the economy tier (backward-compatible). */
export const JLC_FAB_PROFILE: FabProfile = FAB_TIERS.economy;

export type FabTierName = keyof typeof FAB_TIERS;

/**
 * What a CALLER may send. Every field is optional and independently overridable, and `tier` picks which
 * fab's published limits the overrides are judged against.
 *
 * Deliberately NOT `Partial<FabProfile>` at the boundary: this arrives as untyped JSON off an HTTP request
 * and out of a database column, so the resolver below re-checks each value at runtime rather than trusting
 * the declared type.
 */
export interface FabProfileInput {
    tier?: FabTierName;
    minTraceWidthMm?: unknown;
    minClearanceMm?: unknown;
    viaDrillMm?: unknown;
    viaAnnularMm?: unknown;
    viaClearanceMm?: unknown;
    viaClearanceGuardMm?: unknown;
    copperOz?: unknown;
    deltaTC?: unknown;
    perNetMinWidthMm?: unknown;
    gndPour?: unknown;
    placementGridMm?: unknown;
    placementMarginMm?: unknown;
    minSilkWidthMm?: unknown;
    minSilkTextHeightMm?: unknown;
}

export interface ResolvedFabProfile {
    profile: FabProfile;
    tier: FabTierName;
    /** Human-readable record of every value the resolver refused or clamped, for honest disclosure. */
    adjustments: string[];
}

/** The four fields a fab physically cannot go below. A caller may raise them (more conservative, always
 *  manufacturable); lowering them past the tier's published limit produces a board the fab will reject. */
const FLOOR_FIELDS = ['minTraceWidthMm', 'minClearanceMm', 'viaDrillMm', 'viaAnnularMm'] as const;

/** Fields with their own semantics that carry through unclamped — but still have to be real numbers. */
const PASSTHROUGH_FIELDS = [
    'viaClearanceMm',
    'viaClearanceGuardMm',
    'copperOz',
    'deltaTC',
    'placementGridMm',
    'placementMarginMm',
    // Silkscreen limits are passthrough rather than FLOOR fields because they are not a fab's capability
    // limit in the same sense: a caller who knows their fab prints 0.10 mm legend is making a legitimate
    // choice, and the harm from going too LOW is deletion of the art, not a rejected panel. The default is
    // applied below so an unset value can never mean "no limit".
    'minSilkWidthMm',
    'minSilkTextHeightMm',
] as const;

const isPositiveFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Turn whatever a caller sent into a COMPLETE, manufacturable profile.
 *
 * Three failures this exists to prevent, all of which were live:
 *
 *  1. A partial override replaced the ENTIRE default. Sending `{minTraceWidthMm: 0.15}` left the via
 *     geometry undefined, and the KiCad design rules are computed arithmetically from it — so the board's
 *     own rulebook shipped with `NaN` in it, and the DRC that is supposed to be the final authority was
 *     judging against nonsense.
 *  2. The same gap silently switched the ground pour OFF, because an absent `gndPour` is indistinguishable
 *     from a deliberate `false`. A board loses its ground plane without anyone asking for that.
 *  3. Nothing checked the numbers. A negative clearance, a string, or a value below the fab's published
 *     limit went straight into the routing rules and the manufacturing outputs.
 *
 * The rule is one-directional on purpose: overrides may only make a board EASIER to manufacture than the
 * chosen tier. Picking a finer process is done by naming a finer `tier`, which is a decision with a price
 * attached, rather than by quietly typing a smaller number.
 */
export function resolveFabProfile(input?: FabProfileInput | null): ResolvedFabProfile {
    const adjustments: string[] = [];
    const raw = (input ?? {}) as Record<string, unknown>;

    const requestedTier = raw.tier;
    let tier: FabTierName = 'economy';
    if (requestedTier !== undefined) {
        if (typeof requestedTier === 'string' && Object.hasOwn(FAB_TIERS, requestedTier)) {
            tier = requestedTier as FabTierName;
        } else {
            adjustments.push(`unknown fab tier ${JSON.stringify(requestedTier)} — using "economy"`);
        }
    }
    const base = FAB_TIERS[tier];
    const profile: FabProfile = { ...base };

    for (const field of FLOOR_FIELDS) {
        const supplied = raw[field];
        if (supplied === undefined) continue;
        if (!isPositiveFinite(supplied)) {
            adjustments.push(`${field}: ignored ${JSON.stringify(supplied)} (not a positive number)`);
            continue;
        }
        const floor = base[field];
        if (supplied < floor) {
            adjustments.push(`${field}: raised ${supplied} to the ${tier} fab limit ${floor} mm`);
            continue; // keep the tier floor
        }
        profile[field] = supplied;
    }

    for (const field of PASSTHROUGH_FIELDS) {
        const supplied = raw[field];
        if (supplied === undefined) continue;
        if (!isPositiveFinite(supplied)) {
            adjustments.push(`${field}: ignored ${JSON.stringify(supplied)} (not a positive number)`);
            continue;
        }
        profile[field] = supplied;
    }

    // Only an EXPLICIT boolean moves the pour — the whole point of the resolver is that "absent" and
    // "deliberately off" stop meaning the same thing.
    if (raw.gndPour !== undefined) {
        if (typeof raw.gndPour === 'boolean') profile.gndPour = raw.gndPour;
        else adjustments.push(`gndPour: ignored ${JSON.stringify(raw.gndPour)} (not a boolean)`);
    }

    if (raw.perNetMinWidthMm !== undefined) {
        const widths = raw.perNetMinWidthMm;
        if (typeof widths !== 'object' || widths === null || Array.isArray(widths)) {
            adjustments.push(`perNetMinWidthMm: ignored (expected an object of net name → width)`);
        } else {
            const kept: Record<string, number> = {};
            for (const [net, w] of Object.entries(widths as Record<string, unknown>)) {
                if (!isPositiveFinite(w)) {
                    adjustments.push(`perNetMinWidthMm.${net}: ignored ${JSON.stringify(w)} (not a positive number)`);
                } else if (w < profile.minTraceWidthMm) {
                    // A per-net width UNDER the board minimum is not a width, it is an unroutable rule.
                    adjustments.push(
                        `perNetMinWidthMm.${net}: raised ${w} to the board minimum ${profile.minTraceWidthMm} mm`,
                    );
                    kept[net] = profile.minTraceWidthMm;
                } else {
                    kept[net] = w;
                }
            }
            if (Object.keys(kept).length > 0) profile.perNetMinWidthMm = kept;
        }
    }

    return { profile, tier, adjustments };
}

/** Board-tag props enforcing the profile upstream (verified knobs only). */
export function boardExtraProps(profile: FabProfile): string {
    return `autorouter={{ local: true }} minTraceWidth={${profile.minTraceWidthMm}}`;
}

/**
 * Copper-to-board-edge keep-out, in mm. It is a DRC rule below (`min_copper_edge_clearance`) AND the
 * floor any outline-shrink must respect, so it is one exported constant rather than two literals that
 * drift apart — a shrink that used a smaller number would produce boards KiCad then rejects.
 */
export const EDGE_CLEARANCE_MM = 0.3;

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
                        min_copper_edge_clearance: EDGE_CLEARANCE_MM,
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
            // The Default net class clearance/width is what KiCad DRC actually checks track↔pad/track against
            // (design_settings.min_clearance is only a floor). Without this, DRC judges every board at KiCad's
            // 0.2mm default netclass — so a tighter tier (0.127/0.0889) would false-fail (found live 3 Tem
            // 2026). Setting the Default class to the profile makes the notary judge by OUR clearance.
            net_settings: {
                classes: [
                    {
                        name: 'Default',
                        clearance: profile.minClearanceMm,
                        track_width: profile.minTraceWidthMm,
                        via_diameter: viaDiameter,
                        via_drill: profile.viaDrillMm,
                        microvia_diameter: round3(Math.max(0.2, viaDiameter)),
                        microvia_drill: round3(Math.max(0.1, profile.viaDrillMm)),
                    },
                ],
                meta: { version: 4 },
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
 * Mark the board's own lower-left corner as the drill/place origin.
 *
 * WHY THIS EXISTS — the defect it removes, measured 2 Aug 2026. The delivered bundle carried gerbers
 * plotted by kicad-cli from the .kicad_pcb, and a pick-and-place CSV built separately from the design
 * soup. Nothing tied the two frames together, and they were apart by exactly (+100, −100) mm on every
 * board (3 boards, 19 components, zero exceptions). An assembly house feeding that bundle to a machine
 * places every part 100 mm from where the copper is, which on a board whose pads sit 0.5 mm apart is
 * not "slightly off" — it is off the board. The parts are 100 mm out and the board is scrap.
 *
 * The cheap repair would be to add the offset back in the CSV writer. That is a constant standing in
 * for an agreement between two producers, and the day either one moves, the constant is silently wrong
 * again with nothing to say so — which is precisely how this survived. So instead: name ONE origin, in
 * the board file, and have every exporter measure from it. `pcb export gerbers --use-drill-file-origin`,
 * `pcb export drill --drill-origin plot` and `pcb export pos --use-drill-file-origin` then read the same
 * marker out of the same file, and the frames agree BY CONSTRUCTION. There is no constant left to drift.
 *
 * Lower-left is chosen because that is the corner an assembly house expects, and because KiCad's Y grows
 * DOWNWARD while the gerber/position frame grows upward: the visual bottom-left is `(minX, maxY)` in
 * board coordinates. Getting that sign wrong flips the board about its own centre — a mirrored placement
 * that still looks plausible — so it is asserted in the tests rather than reasoned about here.
 *
 * Idempotent: an existing origin is replaced, never duplicated (a second `aux_axis_origin` is a file
 * whose meaning depends on which one the reader takes).
 */
export type PlacementOriginResult =
    | { kind: 'ok'; kicadPcb: string; originMm: { x: number; y: number } }
    | { kind: 'no-outline' };

export function injectPlacementOrigin(kicadPcb: string): PlacementOriginResult {
    // The OUTLINE only — never the all-coordinates fallback `injectZone` accepts. A pour may safely
    // over-cover, but an origin derived from stray copper would silently move every delivered
    // coordinate, which is the very failure this function exists to end.
    const box = edgeCutsBbox(kicadPcb);
    if (!box) return { kind: 'no-outline' };

    const originMm = { x: round3(box.minX), y: round3(box.maxY) };
    const entry = `(aux_axis_origin ${originMm.x} ${originMm.y})`;

    if (/\(aux_axis_origin\s+[-\d.]+\s+[-\d.]+\)/.test(kicadPcb)) {
        return { kind: 'ok', kicadPcb: kicadPcb.replace(/\(aux_axis_origin\s+[-\d.]+\s+[-\d.]+\)/, entry), originMm };
    }
    if (/\(setup\b/.test(kicadPcb)) {
        return { kind: 'ok', kicadPcb: kicadPcb.replace(/\(setup\b/, `(setup\n    ${entry}`), originMm };
    }
    // No setup block at all: open one before the net table, which every board file has. Horizontal
    // whitespace only — `\s*` would swallow blank lines and reindent the net table it is anchoring to.
    if (!/^[^\S\n]*\(net \d+ /m.test(kicadPcb)) return { kind: 'no-outline' };
    return {
        kind: 'ok',
        kicadPcb: kicadPcb.replace(/^([^\S\n]*)(\(net \d+ )/m, `$1(setup\n$1  ${entry}\n$1)\n$1$2`),
        originMm,
    };
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
export type ZoneInjectionResult =
    | { kind: 'ok'; kicadPcb: string }
    | { kind: 'no-net' }
    | { kind: 'unsafe-unnetted-copper' };

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
