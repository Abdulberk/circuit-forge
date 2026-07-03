/**
 * freerouting bridge seam (quality tier, consumed by the Faz-2 worker + the layout harness).
 * Pure conversions only — the actual freerouting EXECUTION (Docker: ghcr.io/freerouting/freerouting
 * pinned 2.2.4, `--entrypoint java -jar /app/freerouting-executable.jar --gui.enabled=false -de/-do`)
 * is INJECTED as `LayoutOptions.freeroute` so this library never touches child_process/Docker.
 * Golden-fixture + live-DRC coverage runs in the `pnpm test:layout` harness (the ESM deps keep these
 * out of jest).
 */
import type { TscElement } from './parity';
import { JLC_FAB_PROFILE, type FabProfile } from './fab-profile';

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
export async function exportDsn(circuitJson: TscElement[], profile: FabProfile = JLC_FAB_PROFILE): Promise<string> {
    const { convertCircuitJsonToDsnString } = await import('dsn-converter');
    const raw = convertCircuitJsonToDsnString(circuitJson as never);
    return applyFabRulesToDsn(raw, profile);
}

/** Specctra clearance types that govern via spacing — freerouting under-spaces these unless told. */
const VIA_CLEARANCE_TYPES = ['via_via', 'via_smd', 'smd_via', 'wire_via', 'via_wire', 'via_pin', 'pin_via'];

/**
 * Raise the DSN net class to the fab floor: `(width)` and bare `(clearance)` up to the profile min,
 * PLUS explicit via clearance types so a routed via keeps ≥ viaClearance from tracks/pads (freerouting
 * otherwise applies a lax via default and lands ~0.12mm — a KiCad clearance violation). Verified live:
 * with the via types a board that freerouting completes WITH a via comes back DRC-clean.
 */
export function applyFabRulesToDsn(dsn: string, profile: FabProfile = JLC_FAB_PROFILE): string {
    const widthUm = Math.round(profile.minTraceWidthMm * 1000);
    const clearanceUm = Math.round(profile.minClearanceMm * 1000);
    const viaClearanceUm = Math.round((profile.viaClearanceMm ?? profile.minClearanceMm * 1.25) * 1000);
    // Idempotent: raising width/clearance is `max` (stable), but the via-clearance types would DUPLICATE
    // on a second pass (the rewritten bare `(clearance N)` still matches) — so append them only when the
    // DSN hasn't already been ruled.
    const viaTypes = dsn.includes('(type via_via)') ? '' : ' ' + VIA_CLEARANCE_TYPES.map((t) => `(clearance ${viaClearanceUm} (type ${t}))`).join(' ');
    return dsn
        .replace(/\(width (\d+(?:\.\d+)?)\)/g, (_m, n: string) => `(width ${Math.max(Number(n), widthUm)})`)
        // bare `(clearance N)` only — the `)` must follow the number, so typed forms like
        // `(clearance 50 (type smd_smd))` are skipped. Append the via clearance types beside each.
        .replace(/\(clearance (\d+(?:\.\d+)?)\)/g, (_m, n: string) => `(clearance ${Math.max(Number(n), clearanceUm)})${viaTypes}`);
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
    const reconstructed = mod.convertDsnSessionToCircuitJson(mod.parseDsnToDsnJson(dsn) as never, mod.parseDsnToDsnJson(ses) as never, base as never) as TscElement[];
    const routing = reconstructed.filter((e) => e.type === 'pcb_trace' || e.type === 'pcb_via');
    return [...base, ...routing];
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
