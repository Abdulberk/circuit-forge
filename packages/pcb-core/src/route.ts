/**
 * freerouting bridge seam (quality tier, consumed by the Faz-2 worker + the layout harness).
 * Pure conversions only — the actual freerouting EXECUTION (Docker: ghcr.io/freerouting/freerouting
 * pinned 2.2.4, `--entrypoint java -jar /app/freerouting-executable.jar --gui.enabled=false -de/-do`)
 * is INJECTED as `LayoutOptions.freeroute` so this library never touches child_process/Docker.
 * Golden-fixture + live-DRC coverage runs in the `pnpm test:layout` harness (the ESM deps keep these
 * out of jest).
 */
import { JLC_FAB_PROFILE, type FabProfile } from './fab-profile';
import type { TscElement } from './parity';

/**
 * tscircuit circuit-json (traces stripped by the caller for a fresh route) -> Specctra DSN, with the
 * fab profile's minimum trace width + clearance enforced on the DSN's net class.
 *
 * WHY the post-process (proven live 3 Tem 2026): dsn-converter emits the `kicad_default` net class at
 * `(width 150) (clearance 150)` = 0.15mm — BELOW our 0.2mm KiCad rules. freerouting honours the class
 * rule verbatim, so the routed board then fails DRC with 37 `track_width` + 12 `clearance` violations.
 * Lifting the class floor to the profile (0.2/0.2) makes the identical flow come back DRC-CLEAN. We
 * only ever RAISE a value to the floor (`max`), never shrink a deliberately-wider class, and we leave
 * TYPED clearances (`(clearance 50 (type smd_smd))`) untouched — those govern pad spacing, not tracks.
 */
export async function exportDsn(
    circuitJson: TscElement[],
    profile: FabProfile = JLC_FAB_PROFILE,
    perNetWidthMm?: Record<string, number>,
): Promise<string> {
    const { convertCircuitJsonToDsnString } = await import('dsn-converter');
    const raw = convertCircuitJsonToDsnString(circuitJson as never);
    const rotated = fixPlaceRotations(raw, circuitJson);
    const ruled = applyFabRulesToDsn(rotated, profile);
    return perNetWidthMm && Object.keys(perNetWidthMm).length > 0
        ? applyPerNetWidths(ruled, perNetWidthMm, profile)
        : ruled;
}

/**
 * Repair the `(place …)` rotations dsn-converter destroys. dsn-converter@0.0.91 emits every place with
 * `rotation % 90` — 90/180/270 all collapse to 0, so the DSN silently loses component rotation (verified
 * live 17 Tem 2026 on bridge-rectifier: every place said `front 0` while the board had 7 rotated parts;
 * upstream main still has the bug).
 *
 * Why that shorts boards: dsn-converter groups components into a shared `(image …)` keyed by the WORLD
 * bounding box (`WxH_mm`), and the image pins are the FIRST group member's world-frame pad offsets — so
 * members of one image can only differ by a 180° flip (a 90° turn lands in a different `HxW` image; only
 * square footprints can share across 90°). With the place rotation forced to 0, a member that is really
 * 180° from its image donor keeps the donor's pad orientation: freerouting then wires each net to the
 * EXACT position of the OPPOSITE pad. KiCad DRC sees symmetric `shorting_items` pairs + the same pads
 * `unconnected` — precisely the forensic signature that made half the boards burn 13 route+DRC attempts
 * (only the widest, rotation-free retry passed).
 *
 * The repair: for each `(component …)` block, the correct place rotation is the rotation of the member
 * RELATIVE to the image donor (the block's first place). dsn-converter emits coordinates VERBATIM (pure
 * scale(1e3), no y mirror — verified in the 0.0.91 dist), and tscircuit's pcb_component rotation and
 * freerouting's place rotation both apply the SAME math-CCW operator on those raw coordinates (probed
 * live on both, 17 Tem 2026): member pads = R(θ_member)·local and image pins = R(θ_donor)·local, so
 * freerouting's `place + R(dsnRot)·pins` hits the member's real pads exactly when
 * dsnRot = (θ_member − θ_donor) mod 360. (For the dominant 180° case the sign is irrelevant; it matters
 * only for square-footprint 90° image sharing.) Back-side places are left untouched — the pipeline never
 * emits them today, and the mirror algebra differs.
 *
 * Relies on dsn-converter's stable one-place-per-line output (a pinned dependency with deterministic
 * formatting; the layout harness re-verifies on every run).
 */
export function fixPlaceRotations(dsn: string, circuitJson: TscElement[]): string {
    // source_component_id → pcb rotation (degrees). The DSN refdes is `${name}_${source_component_id}`.
    const rotById = new Map<string, number>();
    for (const el of circuitJson) {
        if (el.type !== 'pcb_component') continue;
        const e = el as { source_component_id?: string; rotation?: number };
        if (e.source_component_id) rotById.set(e.source_component_id, e.rotation ?? 0);
    }
    if (rotById.size === 0) return dsn;

    const rotOf = (refdes: string): number => {
        // the refdes suffix is the source_component_id (which itself contains underscores)
        for (const [id, rot] of rotById) {
            if (refdes.endsWith(`_${id}`)) return rot;
        }
        return 0;
    };

    const lines = dsn.split('\n');
    let donorRot: number | null = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.includes('(component ')) {
            donorRot = null; // new image group — its first place is the pin-frame donor
            continue;
        }
        const m = /^(\s*\(place\s+)(\S+)(\s+[-\d.eE]+\s+[-\d.eE]+\s+)front(\s+)([-\d.]+)/.exec(line);
        if (!m) continue;
        const theta = rotOf(m[2]!);
        donorRot ??= theta;
        const dsnRot = (((theta - donorRot) % 360) + 360) % 360;
        lines[i] = line.replace(m[0], `${m[1]}${m[2]}${m[3]}front${m[4]}${dsnRot}`);
    }
    return lines.join('\n');
}

/** Specctra clearance types that govern via spacing — freerouting under-spaces these unless told. */
const VIA_CLEARANCE_TYPES = ['via_via', 'via_smd', 'smd_via', 'wire_via', 'via_wire', 'via_pin', 'pin_via'];

/** Via clearance (µm): explicit override, else minClearance + a fixed guard for freerouting's via model. */
function viaClearanceUm(profile: FabProfile): number {
    const mm = profile.viaClearanceMm ?? profile.minClearanceMm + (profile.viaClearanceGuardMm ?? 0.1);
    return Math.round(mm * 1000);
}

/**
 * Raise the DSN net class to the fab floor: `(width)` and bare `(clearance)` up to the profile min,
 * PLUS explicit via clearance types so a routed via keeps ≥ viaClearance from tracks/pads (freerouting
 * otherwise applies a lax via default and lands ~0.12mm — a KiCad clearance violation). Verified live:
 * with the via types a board that freerouting completes WITH a via comes back DRC-clean.
 */
export function applyFabRulesToDsn(dsn: string, profile: FabProfile = JLC_FAB_PROFILE): string {
    const widthUm = Math.round(profile.minTraceWidthMm * 1000);
    const clearanceUm = Math.round(profile.minClearanceMm * 1000);
    const viaClr = viaClearanceUm(profile);
    // Idempotent: raising width/clearance is `max` (stable), but the via-clearance types would DUPLICATE
    // on a second pass (the rewritten bare `(clearance N)` still matches) — so append them only when the
    // DSN hasn't already been ruled.
    const viaTypes = dsn.includes('(type via_via)')
        ? ''
        : ' ' + VIA_CLEARANCE_TYPES.map((t) => `(clearance ${viaClr} (type ${t}))`).join(' ');
    return (
        dsn
            .replace(/\(width (\d+(?:\.\d+)?)\)/g, (_m, n: string) => `(width ${Math.max(Number(n), widthUm)})`)
            // bare `(clearance N)` only — the `)` must follow the number, so typed forms like
            // `(clearance 50 (type smd_smd))` are skipped. Append the via clearance types beside each.
            .replace(
                /\(clearance (\d+(?:\.\d+)?)\)/g,
                (_m, n: string) => `(clearance ${Math.max(Number(n), clearanceUm)})${viaTypes}`,
            )
    );
}

/** Balanced-paren s-expression starting at the first `kw` occurrence (from `from`); null if none. */
function balancedSexpr(s: string, kw: string, from = 0): { start: number; end: number; text: string } | null {
    const a = s.indexOf(kw, from);
    if (a < 0) return null;
    let depth = 0;
    for (let i = a; i < s.length; i++) {
        const c = s[i];
        if (c === '(') depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0) return { start: a, end: i + 1, text: s.slice(a, i + 1) };
        }
    }
    return null;
}

/**
 * Give individual nets their own trace width by splitting the single `kicad_default` net class into
 * width-keyed classes (freerouting honours per-class width — verified live 3 Tem 2026: a net moved to a
 * 1.0mm class routes at 1.0mm while signal nets stay 0.2mm). `widthMmByEmitted` is keyed by EMITTED net
 * name (e.g. "GND", "VCC"); a DSN net `VCC_source_net_3` maps back by stripping the `_source_net_N`
 * suffix. Widths ≤ the base floor stay in kicad_default. This is how IPC-2221 per-net widths reach the
 * router. (Quote tokens are matched with `[^"]*` — `+` cross-pairs around the empty class-name `""`.)
 */
export function applyPerNetWidths(
    dsn: string,
    widthMmByEmitted: Record<string, number>,
    profile: FabProfile = JLC_FAB_PROFILE,
): string {
    const blk = balancedSexpr(dsn, '(class "kicad_default"');
    if (!blk) return dsn;
    const headerLine = blk.text.slice(0, blk.text.indexOf('\n'));
    const nets = [...headerLine.matchAll(/"([^"]*)"/g)]
        .map((m) => m[1]!)
        .filter((s) => s !== 'kicad_default' && s !== '');
    const circuit = balancedSexpr(blk.text, '(circuit')?.text ?? '(circuit\n      )';
    const floorUm = Math.round(profile.minTraceWidthMm * 1000);
    const viaClr = viaClearanceUm(profile);
    const clearance =
        `(clearance ${Math.round(profile.minClearanceMm * 1000)}) ` +
        VIA_CLEARANCE_TYPES.map((t) => `(clearance ${viaClr} (type ${t}))`).join(' ');
    const emittedOf = (n: string) => n.replace(/_source_net_\d+$/, '');

    const groups = new Map<number, string[]>();
    for (const n of nets) {
        const mm = widthMmByEmitted[emittedOf(n)];
        const um = mm && Math.round(mm * 1000) > floorUm ? Math.round(mm * 1000) : floorUm;
        if (!groups.has(um)) groups.set(um, []);
        groups.get(um)!.push(n);
    }
    const mkClass = (name: string, ns: string[], um: number) =>
        `    (class "${name}" ${ns.map((n) => `"${n}"`).join(' ')}\n      ${circuit}\n      (rule\n        (width ${um})\n        ${clearance}\n      )\n    )`;
    const classes = [...groups.entries()].map(([um, ns]) =>
        mkClass(um === floorUm ? 'kicad_default' : `w${um}`, ns, um),
    );
    return dsn.slice(0, blk.start) + classes.join('\n') + dsn.slice(blk.end);
}

/**
 * Grow a board's rectangular outline symmetrically by `marginMm` on every side (keeps the placement
 * centred). freerouting routes within the board boundary; tscircuit's auto-size packs parts so tightly
 * that a dense net can be left unrouted — the margin is pure routing headroom. Both the DSN boundary
 * (dsn-converter) and the KiCad Edge.Cuts (circuit-json-to-kicad) derive from pcb_board width/height,
 * so enlarging it keeps the routed board and its outline consistent. No-op when marginMm ≤ 0.
 */
export function enlargeBoard(board: TscElement[], marginMm: number): TscElement[] {
    if (marginMm <= 0) return board;
    return board.map((e) => {
        if (e.type !== 'pcb_board') return e;
        const b = e as { width?: number; height?: number; outline?: unknown };
        // outline polygons (non-rectangular boards) aren't grown here — width/height covers the auto-sized
        // rectangular boards this pipeline produces; a custom outline is left untouched (honest no-op).
        if (b.outline) return e;
        return { ...e, width: Number(b.width ?? 0) + 2 * marginMm, height: Number(b.height ?? 0) + 2 * marginMm };
    });
}

/**
 * Shrink a routed board's rectangular outline down to what the board actually CONTAINS, plus a clearance.
 *
 * WHY. `enlargeBoard` adds routing headroom (6mm/side by default) because freerouting routes strictly
 * inside the boundary and tscircuit's auto-size packs parts too tightly for a dense net to complete. That
 * headroom does its job during routing and is then pure waste: it stays in the delivered outline, so every
 * board ships with up to 12mm of empty laminate on each axis. The customer pays for it (board area is what
 * fabs price on), it makes the 3D preview look like a hobby prototype, and it is invisible in the DRC
 * report because empty laminate violates nothing.
 *
 * This is a SUGGESTION, not a mutation of the verdict: the caller re-runs the DRC notary on the shrunk
 * board and keeps it only if it is still certified. Shrinking can genuinely fail — a trace freerouting ran
 * out near the old boundary can land inside the new edge clearance — and a smaller board that fails DRC is
 * strictly worse than a larger one that passes.
 *
 * Returns the board unchanged (same array identity) when there is nothing safe to do: a non-rectangular
 * outline, no measurable content, or a proposed size that is not actually smaller.
 */
export function shrinkBoardToContent(board: TscElement[], clearanceMm: number): TscElement[] {
    const boardEl = board.find((e) => e.type === 'pcb_board') as
        | { width?: number; height?: number; center?: { x?: number; y?: number }; outline?: unknown }
        | undefined;
    // A custom outline is the designer's shape, not our headroom — never second-guess it.
    if (!boardEl || boardEl.outline) return board;

    const box = contentBounds(board);
    if (!box) return board;

    const old = { x: Number(boardEl.center?.x ?? 0), y: Number(boardEl.center?.y ?? 0) };
    // Each axis is decided on its own. An axis is only touched when the content genuinely leaves slack
    // there — and its centre moves only with it, so a board whose content already overflows one axis is
    // left exactly as it was on that axis rather than being re-centred underneath the overflow.
    const x = axis(box.minX, box.maxX, Number(boardEl.width ?? 0), clearanceMm);
    const y = axis(box.minY, box.maxY, Number(boardEl.height ?? 0), clearanceMm);
    if (!x && !y) return board;

    return board.map((e) =>
        e === (boardEl as unknown as TscElement)
            ? {
                  ...e,
                  width: x?.size ?? Number(boardEl.width ?? 0),
                  height: y?.size ?? Number(boardEl.height ?? 0),
                  center: { x: x?.center ?? old.x, y: y?.center ?? old.y },
              }
            : e,
    );
}

/**
 * One axis of the shrink: the tighter size and the centre that goes with it, or null when there is no
 * slack to give back.
 *
 * Only ever shrinks. Content that already needs more room than the outline gives it is a real condition
 * for DRC to report; silently GROWING the board here would hide it. The centre moves to the content's
 * midpoint because freerouting's copper is not symmetric — a shrink that kept the old centre would clip
 * whichever side the routing leaned towards.
 */
function axis(min: number, max: number, oldSize: number, clearanceMm: number): { size: number; center: number } | null {
    const size = max - min + 2 * clearanceMm;
    return size < oldSize ? { size, center: (min + max) / 2 } : null;
}

/**
 * The bounding box of everything that must physically stay on the laminate: copper (pads, traces, vias)
 * and component courtyards (the body's own keep-out, which is what actually decides whether a part hangs
 * off the edge).
 *
 * Silkscreen is deliberately excluded. It carries no manufacturing constraint — a designator that would
 * fall outside the outline is simply not printed — and including it would let a wide reference label veto
 * the shrink on nearly every board, which is how a correction becomes a no-op nobody notices.
 */
function contentBounds(board: TscElement[]): { minX: number; maxX: number; minY: number; maxY: number } | null {
    let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
    const add = (x: unknown, y: unknown, halfW = 0, halfH = 0): void => {
        const nx = Number(x),
            ny = Number(y);
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
        minX = Math.min(minX, nx - halfW);
        maxX = Math.max(maxX, nx + halfW);
        minY = Math.min(minY, ny - halfH);
        maxY = Math.max(maxY, ny + halfH);
    };

    for (const e of board) {
        const r = e as Record<string, unknown>;
        switch (e.type) {
            case 'pcb_smtpad':
                add(r.x, r.y, half(r.width, r.radius), half(r.height, r.radius));
                break;
            case 'pcb_plated_hole':
            case 'pcb_hole': {
                // THT pads are described either by an outer diameter or by a rectangular pad size.
                const d = half(r.outer_diameter ?? r.hole_diameter, undefined) || 0;
                add(r.x, r.y, half(r.outer_width, undefined) || d, half(r.outer_height, undefined) || d);
                break;
            }
            case 'pcb_via':
                add(r.x, r.y, half(r.outer_diameter, undefined), half(r.outer_diameter, undefined));
                break;
            case 'pcb_trace': {
                const route = Array.isArray(r.route) ? (r.route as Record<string, unknown>[]) : [];
                for (const pt of route) add(pt.x, pt.y, half(pt.width, undefined), half(pt.width, undefined));
                break;
            }
            case 'pcb_courtyard_outline': {
                const outline = Array.isArray(r.outline) ? (r.outline as Record<string, unknown>[]) : [];
                for (const pt of outline) add(pt.x, pt.y);
                break;
            }
            default:
                break;
        }
    }
    return Number.isFinite(minX) && Number.isFinite(minY) ? { minX, maxX, minY, maxY } : null;
}

/** Half of a diameter/size field, or of twice a radius. 0 for anything non-numeric — a missing size must
 *  not poison the bounds with NaN. */
function half(size: unknown, radius: unknown): number {
    const s = Number(size);
    if (Number.isFinite(s) && s > 0) return s / 2;
    const r = Number(radius);
    return Number.isFinite(r) && r > 0 ? r : 0;
}

/**
 * Splice a freerouting SES session's routing back onto the ORIGINAL placed board.
 *
 * WHY not just return `convertDsnSessionToCircuitJson` (the old behaviour, proven lossy 3 Tem 2026):
 * that reconstructs a FRESH circuit-json from DSN+SES and drops `pcb_component`/footprints/`cad_component`
 * — re-exporting it yields a board of loose traces with NO pads or component bodies (a vacuous DRC pass:
 * nothing to violate). Instead we keep the real board (components, pads, silkscreen, courtyards, 3D
 * `cad_component`s) and swap only the copper: strip the local route, append the SES's `pcb_trace`/`pcb_via`.
 */
export async function mergeSes(original: TscElement[], dsn: string, ses: string): Promise<TscElement[]> {
    const mod = await import('dsn-converter');
    // Copper-free reference: keeps the source tables (nets/traces/components) the converter needs to remap,
    // with no old local copper that could leak into the output.
    const base = stripRouting(original);
    // Pass the reference as the 3rd arg so dsn-converter REMAPS the reconstructed copper's source_trace_ids
    // onto the real board's nets. Without it the converter assigns DSN-positional ids (nets emitted
    // alphabetically), which don't line up with the placed board's own trace ordering — every spliced
    // track then gets the WRONG net label (proven live 3 Tem 2026: 14/18 endpoints mis-netted on
    // opamp-mixed; DRC only passed because it re-infers connectivity from geometry). With the reference the
    // net labels resolve correctly, so the delivered netlist matches the copper.
    const reconstructed = mod.convertDsnSessionToCircuitJson(
        mod.parseDsnToDsnJson(dsn) as never,
        mod.parseDsnToDsnJson(ses) as never,
        base as never,
    ) as TscElement[];
    const routing = reconstructed.filter((e) => e.type === 'pcb_trace' || e.type === 'pcb_via');
    return [...base, ...dropDuplicateViaWaypoints(routing)];
}

/**
 * Describe each via ONCE.
 *
 * dsn-converter reconstructs every layer change twice: as a standalone `pcb_via` carrying the real padstack
 * (0.6mm pad / 0.3mm drill, from our fab profile) and, redundantly, as a `route_type:'via'` waypoint inside
 * the trace that passes through it. circuit-json-to-kicad faithfully emits a `(via …)` record for BOTH —
 * and the waypoint carries no dimensions, so that second record lands at KiCad's built-in default of
 * 0.8mm/0.4mm.
 *
 * The result reaches the customer. Measured on a delivered board: the drill file contains
 * `T1 (0.300) X90.657Y-110.535` and `T2 (0.400) X90.657Y-110.535` — two hits, two tool diameters, one
 * coordinate. The fab drills the hole twice; the wider one wins, so the finished annular ring is
 * (0.6−0.4)/2 = 0.10mm against a 0.15mm rule, on a board stamped manufacturable.
 *
 * Nothing caught it. KiCad does report it — `holes_co_located` — but at WARNING severity, and the notary
 * runs `--severity-error`, so the verdict never saw it. Every via on every board we have ever produced is
 * affected; it predates the outline and pour work by months.
 *
 * The standalone element is the authoritative one, so the waypoint is dropped — but only where a real via
 * sits at that exact point. A waypoint with no matching element is the ONLY record of that layer change and
 * is left alone, because losing a via is a broken board and a duplicated one is merely a bad hole.
 */
export function dropDuplicateViaWaypoints(routing: TscElement[]): TscElement[] {
    const key = (x: unknown, y: unknown): string => `${Number(x).toFixed(4)},${Number(y).toFixed(4)}`;
    const at = (e: TscElement): { x?: unknown; y?: unknown } => e as unknown as { x?: unknown; y?: unknown };
    const described = new Set(routing.filter((e) => e.type === 'pcb_via').map((e) => key(at(e).x, at(e).y)));
    if (described.size === 0) return routing;
    return routing.map((e) => {
        if (e.type !== 'pcb_trace') return e;
        const route = (e as { route?: unknown }).route;
        if (!Array.isArray(route)) return e;
        const kept = route.filter((p) => {
            const pt = p as { route_type?: string; x?: unknown; y?: unknown };
            return pt.route_type !== 'via' || !described.has(key(pt.x, pt.y));
        });
        return kept.length === route.length ? e : { ...e, route: kept };
    });
}

/** Drop routed geometry so an external router starts from placement only. */
export function stripRouting(circuitJson: TscElement[]): TscElement[] {
    return circuitJson.filter((e) => e.type !== 'pcb_trace' && e.type !== 'pcb_via');
}

/** Net names that have AT LEAST ONE wire in the SES — each `(net "X" (wire ...))` under `routes/network_out`. */
export function routedNetsFromSes(ses: string): Set<string> {
    const start = ses.indexOf('(network_out');
    const scope = start >= 0 ? ses.slice(start) : ses;
    const nets = new Set<string>();
    for (const m of scope.matchAll(/\(net\s+"([^"]+)"/g)) nets.add(m[1]!);
    return nets;
}

/** DSN nets that SHOULD be routed — a net with ≥2 pins (single-pin `unconnected-*` pseudo-nets excluded). */
export function routableNetsFromDsn(dsn: string): string[] {
    const out: string[] = [];
    for (const m of dsn.matchAll(/\(net\s+"([^"]+)"\s*\(pins([^)]*)\)/g)) {
        if (m[2]!.trim().split(/\s+/).filter(Boolean).length >= 2) out.push(m[1]!);
    }
    return out;
}

/**
 * Nets that freerouting left ENTIRELY unrouted — a routable net (≥2 pins) with no wires at all in the SES.
 * This is a fast, Docker-free PRE-CHECK the margin-retry loop uses to reject a margin that dropped a whole
 * net (the dominant tight-board failure, e.g. OUT on the auto-sized op-amp).
 *
 * LIMITATION (by construction — the library cannot run DRC): it is net-presence based, so a multi-pin net
 * that freerouting only PARTIALLY routes (some connections placed, one ratsnest left) still shows a wire
 * and is NOT reported here. Per-connection completeness is the NOTARY's job — `kicad-cli pcb drc`
 * `unconnected_items` (the harness/worker gate) is the authority; this never certifies "fully connected".
 */
export function findFullyUnroutedNets(dsn: string, ses: string): string[] {
    const routed = routedNetsFromSes(ses);
    return routableNetsFromDsn(dsn).filter((n) => !routed.has(n));
}

/** Injected freerouting runner: takes a fab-ruled DSN, returns the routed Specctra SES. */
export type FreeroutingRunner = (dsn: string) => Promise<string>;
