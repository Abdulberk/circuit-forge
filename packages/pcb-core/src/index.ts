/**
 * @circuit-forge/pcb-core — Phase 1: CircuitJson -> placed+routed board -> production outputs.
 *
 * `layoutCircuit` is the single entry: classify (honest layoutability) -> generate tscircuit code
 * (fab profile enforced upstream) -> headless eval+route (local, network-free) -> CONNECTIVITY
 * PARITY against our own netlist (approval condition 1 — a DRC-clean but miswired board can never
 * pass silently) -> Gerber/.kicad_pcb/.kicad_pro/BOM/PnP (fab profile enforced downstream too).
 */
import type { CircuitJson, UiJson } from '@circuit-forge/eda-core';

import { generateTscircuitCode, type AdapterResult } from './adapter';
import { evaluateTscircuit } from './evaluate';
import {
    boardExtraProps,
    reportViaCompliance,
    injectZone,
    kicadProjectJson,
    resolveFabProfile,
    type FabProfile,
    type FabProfileInput,
    type FabTierName,
} from './fab-profile';
import { ipc2221WidthMm } from './ipc2221';
import { classifyCircuit, type LayoutabilityResult, type LayoutDiagnostic } from './layoutability';
import { generateGerbers, generateKicadPcb, buildBomCsv, buildPnpCsv, type GerberOutputs } from './outputs';
import { checkConnectivityParity, type ParityResult, type TscElement } from './parity';
import { placeParts, computeHpwl, type PlacementInput, type PlacementOutput } from './placement';
import { extractPlacementParts, gridPositions, buildNetWeights, deriveExtraEdges } from './placement-bridge';
import type { PlacementRunner } from './placement-engine';
import {
    exportDsn,
    mergeSes,
    stripRouting,
    enlargeBoard,
    findFullyUnroutedNets,
    type FreeroutingRunner,
} from './route';

export interface LayoutOptions {
    ui?: UiJson;
    /** Caller overrides on top of a named fab tier. Partial and untrusted — resolveFabProfile completes it
     *  against the tier's published limits, so an override can never leave the board half-specified. */
    fabProfile?: FabProfileInput;
    /** Accept a PARTIAL board when load-bearing sim-primitives are excluded (default: fail honest). */
    allowPartial?: boolean;
    /** 'fast' = tscircuit local router (deterministic, network-free). 'quality' = freerouting, applied
     *  only when a `freeroute` runner is injected (this library never touches Docker/child_process). */
    router?: 'fast' | 'quality';
    /** DSN -> SES freerouting executor, injected by the harness/worker (keeps pcb-core pure). Required
     *  for `router:'quality'`; absent, quality gracefully degrades to the fast local route. */
    freeroute?: FreeroutingRunner;
    /** Injected DRC oracle (kicadPcb, kicadPro) -> true iff DRC-clean (0 violations AND 0 unconnected).
     *  When provided, the quality margin-retry uses REAL DRC as the completeness+cleanliness oracle (the
     *  only reliable one — freerouting's SES doesn't preserve per-connection routedness), and if no margin
     *  is DRC-clean the board falls back to the fully-connected local route (guaranteeing zero open nets).
     *  Absent: the cheap net-presence oracle is used (fully-dropped nets only). Lives in the worker/harness
     *  (Docker); the library stays pure. */
    notaryDrc?: (kicadPcb: string, kicadPro: string) => Promise<boolean>;
    /** Routing headroom (mm/side) added to the board before a quality route so freerouting can complete
     *  tight auto-sized boards. Default 6. Set 0 to route within the exact auto-size outline. */
    routingMarginMm?: number;
    /** RMS current (A) per EMITTED net name (e.g. { GND: 1.5, VBUS: 2 }). Drives IPC-2221 per-net trace
     *  width on the quality router — a power/ground net routes wider than a signal net, deterministically.
     *  Typically fed from simulation; nets without an entry use the profile's minimum width. */
    netCurrentsA?: Record<string, number>;
    boardWidthMm?: number;
    boardHeightMm?: number;
    /** Placement engine (Lever 2, PLACEMENT_PLAN.md). 'grid' = the deterministic connectivity-blind
     *  grid (today's default). 'auto' = two-pass connectivity-aware placement: the grid pass is the
     *  baseline, the force-directed placement must beat it on HPWL AND re-pass eval+parity, else the
     *  board keeps the grid (quality can never regress — floor guarantee, plan §4.7). */
    placer?: 'grid' | 'auto' | 'rust';
    /** Out-of-process Rust placement runner. Required only for `placer:'rust'`; injected by the
     *  worker/harness so pcb-core remains child-process-free. */
    rustPlace?: PlacementRunner;
}

export interface LayoutStats {
    traces: number;
    vias: number;
    errors: number;
    durationMs: number;
}

export interface LayoutResult {
    ok: boolean;
    completeness: 'full' | 'partial';
    diagnostics: LayoutDiagnostic[];
    /** The generated tscircuit source (debuggability / future editor substrate). */
    code: string;
    /** tscircuit's evaluated circuit-json (placed + routed) — feeds viewers and Faz-2 converters. */
    evaluated: TscElement[];
    parity: ParityResult;
    outputs: {
        gerbers: GerberOutputs;
        kicadPcb: string;
        kicadPro: string;
        bomCsv: string;
        pnpCsv: string;
    } | null;
    stats: LayoutStats;
    /** The fab rules the board was ACTUALLY built and judged against, after the caller's overrides were
     *  completed and clamped. Recorded because "which rules produced these gerbers" is the first question
     *  asked when a fab rejects a panel, and reconstructing it from the request is guesswork. */
    fab: { tier: FabTierName; profile: FabProfile };
    /**
     * What the pipeline actually DID, after every fallback — as data, not as prose buried in diagnostics.
     *
     * Both stages degrade gracefully on purpose: an unavailable quality router still yields a
     * fully-connected local route, and a failed placement engine still yields the proven grid. That is the
     * right behaviour, but silent it is a lie by omission: a board routed by the local fast router carries
     * undersized vias and looser clearances, and until now its result was byte-indistinguishable from a
     * freerouting board that the DRC notary certified. A caller could not tell which one it was holding,
     * so nobody could notice the quality tier being dead — exactly how it went unnoticed in CI.
     *
     * Typed rather than derived: reconstructing this by string-matching diagnostic MESSAGES would make
     * every consumer depend on wording that is meant to be human-readable and changeable.
     */
    delivery: {
        routing: {
            /** 'quality' = freerouting's copper was accepted; 'local' = the fast in-process router's. */
            tier: 'quality' | 'local';
            /** True only when a real DRC oracle certified the accepted board (0 violations, 0 unconnected). */
            drcCertified: boolean;
            /** Routing headroom the accepted margin attempt used. Absent when the tier is 'local'. */
            marginMm?: number;
            /** Why the quality tier was not used. Absent exactly when tier === 'quality'. */
            degradedReason?: string;
        };
        placement: {
            /** The engine whose positions the delivered board actually uses. */
            engine: 'grid' | 'auto' | 'rust';
            /** What the caller asked for — differs from `engine` whenever a fallback happened. */
            requested: 'grid' | 'auto' | 'rust';
            /** Why the requested engine was not used. Absent exactly when engine === requested. */
            degradedReason?: string;
        };
    };
    /** OUR componentId -> emitted (sanitized) name; and netId -> emitted net name. The LayoutJob
     *  contract shaper (shapeLayoutResult) needs these to cross-probe geometry back to the design. */
    namesById: Record<string, string>;
    netNameById: Record<string, string>;
}

/** The delivery record for a board that never reached the router — honest rather than absent. Consumers
 *  read `delivery` unconditionally, so leaving it undefined on a failure path would push a null-check
 *  into every one of them and invite the field to be treated as optional. */
const undelivered = (opts: LayoutOptions, why: string): LayoutResult['delivery'] => {
    const requested = opts.placer ?? 'grid';
    return {
        routing: { tier: 'local', drcCertified: false, degradedReason: why },
        placement: {
            engine: 'grid',
            requested,
            ...(requested !== 'grid' ? { degradedReason: why } : {}),
        },
    };
};

export async function layoutCircuit(circuit: CircuitJson, opts: LayoutOptions = {}): Promise<LayoutResult> {
    const started = Date.now();
    // Complete the caller's overrides against a real fab tier BEFORE anything reads them. A raw partial
    // object here leaves via geometry undefined, which propagates as NaN into the KiCad design rules the
    // DRC notary judges against — the board would be checked by a rulebook that is not a rulebook.
    const { profile, tier, adjustments } = resolveFabProfile(opts.fabProfile);
    const fab = { tier, profile };
    const diagnostics: LayoutDiagnostic[] = adjustments.map((message) => ({
        code: 'fab_profile_adjusted',
        severity: 'warning' as const,
        message,
    }));

    // 1) honest pre-flight
    const layout = classifyCircuit(circuit, { allowPartial: opts.allowPartial });
    diagnostics.push(...layout.diagnostics);
    if (!layout.layoutable) {
        return failed(layout, diagnostics, started, fab, opts);
    }

    // 2) adapter -> tscircuit code (fab profile upstream)
    const adapted = generateTscircuitCode(circuit, opts.ui, layout, {
        boardWidthMm: opts.boardWidthMm,
        boardHeightMm: opts.boardHeightMm,
        boardExtraProps: boardExtraProps(profile),
    });
    diagnostics.push(...adapted.diagnostics);

    // 3) headless eval + local autoroute (always: parity checks the placement, and the local route is
    //    the base board the quality router splices into)
    let evaluated = await evaluateTscircuit(adapted.code);
    let routeErrors = evaluated.filter((e) => e.type.endsWith('_error'));
    for (const err of routeErrors) diagnostics.push(passThroughError(err, 'tscircuit'));

    // 4) connectivity parity — OUR netlist vs the evaluated board (condition 1)
    let parity = checkConnectivityParity(evaluated, adapted.expectations);
    diagnostics.push(...parity.diagnostics);

    // 4.25) COURTYARD-OVERLAP RESCUE. The size-blind grid can pack a physically large part (e.g. a 14mm
    //       6-pin header) into a cell smaller than its courtyard; tscircuit then rejects the WHOLE board
    //       with pcb_courtyard_overlap_error. But the failed eval still carries every part's REAL geometry,
    //       so re-run the courtyard-aware placement engine off it and re-evaluate, adopting ANY valid result
    //       (there is no valid grid baseline to beat on HPWL). Turns dense boards that used to hard-fail
    //       (MCU + ICSP header, …) into producible layouts. Guarded: only when parity is otherwise ok and
    //       EVERY error is a courtyard overlap — a pure placement-geometry fault that a re-place can fix.
    let rescuedCode: string | null = null;
    const errsNow = () => diagnostics.filter((d) => d.severity === 'error');
    if (parity.ok && errsNow().length > 0 && errsNow().every((d) => d.errorType === 'pcb_courtyard_overlap_error')) {
        const rescue = await attemptAutoPlacement(circuit, opts, layout, adapted, evaluated, profile, undefined, true);
        diagnostics.push(...rescue.diagnostics);
        if (rescue.adopted && rescue.code && rescue.evaluated && rescue.parity) {
            // the courtyard errors belonged to the DISCARDED grid placement — drop them; the board was re-placed
            for (let k = diagnostics.length - 1; k >= 0; k--) {
                if (diagnostics[k]!.errorType === 'pcb_courtyard_overlap_error') diagnostics.splice(k, 1);
            }
            evaluated = rescue.evaluated;
            parity = rescue.parity;
            routeErrors = evaluated.filter((e) => e.type.endsWith('_error'));
            rescuedCode = rescue.code;
        }
    }

    const ok = parity.ok && !diagnostics.some((d) => d.severity === 'error');
    if (!ok) {
        return {
            ok,
            completeness: layout.completeness,
            diagnostics,
            code: rescuedCode ?? adapted.code,
            evaluated,
            parity,
            outputs: null, // never emit a "manufacturable package" for a board that failed parity/route
            stats: stats(evaluated, routeErrors.length, started),
            fab,
            delivery: undelivered(opts, 'the board failed connectivity parity or evaluation before routing'),
            namesById: adapted.namesById,
            netNameById: adapted.netNameById,
        };
    }

    // 4.5) Lever 2 — connectivity-aware placement (two-pass, plan §4). The VALID grid board above is
    //      the baseline; auto must beat it on HPWL and re-pass eval+parity, or the grid stays. When a
    //      DRC oracle is available the routing acceptance happens in 5b (channel ladder).
    let codeActive = rescuedCode ?? adapted.code;
    const gridEvaluated = evaluated;
    const advancedPlacement = opts.placer === 'auto' || opts.placer === 'rust';
    const placementRunnerReady = opts.placer !== 'rust' || !!opts.rustPlace;
    // What the delivered board will report: the engine actually used, and why the requested one was
    // not, when that happens. Tracked as the code runs rather than reconstructed afterwards — a board
    // that quietly fell back to the grid must not be indistinguishable from one the engine placed.
    const placementRequested: 'grid' | 'auto' | 'rust' = opts.placer ?? 'grid';
    let placementAdopted = !advancedPlacement; // a grid request is trivially "as requested"
    let placementReason: string | undefined;
    if (advancedPlacement && !placementRunnerReady) placementReason = 'the rust placement runner is not configured';
    const canLadder =
        advancedPlacement && placementRunnerReady && opts.router === 'quality' && !!opts.freeroute && !!opts.notaryDrc;
    if (advancedPlacement && !canLadder) {
        // no routing oracle (fast router / no notary): single attempt, HPWL-gated adoption
        const auto = await attemptAutoPlacement(circuit, opts, layout, adapted, evaluated, profile, undefined);
        diagnostics.push(...auto.diagnostics);
        placementAdopted = auto.adopted;
        placementReason = auto.reason ?? placementReason;
        if (auto.adopted && auto.code && auto.evaluated && auto.parity) {
            codeActive = auto.code;
            evaluated = auto.evaluated;
            parity = auto.parity;
        }
    }

    // 5a) IPC-2221 per-net trace widths from supplied net currents (a power/ground net must be wider than
    //     a signal net — deterministic, no LLM). Merges with any explicit profile.perNetMinWidthMm.
    const perNetWidthMm = computeIpcWidths(opts.netCurrentsA, profile, diagnostics);

    // 5b) quality route (freerouting), applied only when a runner is injected. Reroute from placement,
    //     then splice the SES copper back onto the full board — components/pads/bodies preserved.
    //     Proven live 3 Tem 2026: this flow comes back DRC-CLEAN where the local route needs the notary.
    //
    //     Lever-2 channel LADDER (plan §4.7): freerouting's DRC-clean success is non-monotonic in the
    //     inter-part channel width, so an adopted auto placement that fails to route clean is retried
    //     with wider channels before reverting to the grid — the shipped board is never worse than today.
    let route: Awaited<ReturnType<typeof applyQualityRoute>> | null = null;
    if (canLadder) {
        for (const spacingMm of [undefined, 3.6] as Array<number | undefined>) {
            const auto = await attemptAutoPlacement(circuit, opts, layout, adapted, gridEvaluated, profile, spacingMm);
            diagnostics.push(...auto.diagnostics);
            if (!auto.adopted || !auto.code || !auto.evaluated || !auto.parity) {
                placementReason = auto.reason ?? placementReason;
                break; // wider channels can't fix an HPWL/overlap rejection
            }
            const attempt = await applyQualityRoute(auto.evaluated, opts, profile, perNetWidthMm, diagnostics);
            if (attempt.clean) {
                codeActive = auto.code;
                evaluated = auto.evaluated;
                parity = auto.parity;
                route = attempt;
                placementAdopted = true;
                placementReason = undefined;
                break;
            }
            if (attempt.toolFailed) {
                // The router or the notary FAILED rather than judging the board. The next rung widens the
                // channels, which makes a LARGER board — strictly more work for the tool that just timed
                // out or crashed — so it cannot help and would only spend the timeout again. On a queue
                // that drains one job at a time, each wasted rung is dead wall-clock for every tenant.
                // Stop laddering; the single grid attempt below is genuinely different work and still runs.
                placementReason = `the quality router failed before it could judge the placement (${attempt.reason ?? 'tool failure'})`;
                break;
            }
            diagnostics.push({
                code: 'PCB051',
                severity: spacingMm === undefined ? 'info' : 'warning',
                message: `auto-placement (channel ${spacingMm ?? 2.4}mm) did not route DRC-clean — ${spacingMm === undefined ? 'retrying with wider channels' : 'reverting to the grid placement (floor guarantee)'}.`,
            });
            placementReason = 'the placed board did not route DRC-clean at any channel width';
        }
    }
    if (!route) route = await applyQualityRoute(evaluated, opts, profile, perNetWidthMm, diagnostics);
    const { routedBoard, qualityApplied } = route;

    // The delivered board’s own account of how it was made. Assembled from tracked outcomes, never
    // from diagnostic text, so consumers depend on data rather than on wording.
    const delivery: LayoutResult['delivery'] = {
        routing: {
            tier: qualityApplied ? 'quality' : 'local',
            drcCertified: route.clean,
            ...(route.marginMm !== undefined ? { marginMm: route.marginMm } : {}),
            ...(route.reason ? { degradedReason: route.reason } : {}),
        },
        placement: {
            engine: placementAdopted ? placementRequested : 'grid',
            requested: placementRequested,
            ...(!placementAdopted && placementReason ? { degradedReason: placementReason } : {}),
        },
    };

    // Confirm the widened nets actually routed at their IPC width (freerouting honoured the per-net class).
    if (qualityApplied) verifyPerNetWidths(routedBoard, perNetWidthMm, diagnostics);

    // Via compliance on the FINAL copper. freerouting routes with the DSN padstack (0.6/0.3 = compliant),
    // so quality boards clear this; the local router's undersized vias are an honest limitation we report
    // (never enlarge post-route — that manufactures shorts, proven live).
    reportViaComplianceInto(routedBoard, profile, qualityApplied, diagnostics);

    // 6) production outputs (fab profile downstream: .kicad_pro rules + optional GND pour)
    const gerbers = await generateGerbers(routedBoard);
    const assembled = await assembleKicadPcb(routedBoard, profile);
    const kicadPcb = assembled.kicadPcb;
    if (assembled.pour === 'ok') {
        diagnostics.push({
            code: 'PCB032',
            severity: 'info',
            message: 'GND pour injected on B.Cu — the notary fills it via --refill-zones (KiCad 10).',
        });
    } else if (assembled.pour === 'unsafe-unnetted-copper') {
        diagnostics.push({
            code: 'PCB033',
            severity: 'info',
            message:
                'GND pour skipped: kicad converter emits copper segments without net assignment — a fill against un-netted copper would false-short.',
        });
    } else if (assembled.pour === 'no-net') {
        diagnostics.push({
            code: 'PCB033',
            severity: 'info',
            message: 'gndPour requested but no GND net exists on the board — pour skipped.',
        });
    }

    return {
        ok,
        completeness: layout.completeness,
        diagnostics,
        code: codeActive,
        evaluated: routedBoard,
        parity,
        outputs: {
            gerbers,
            kicadPcb,
            kicadPro: kicadProjectJson(profile),
            bomCsv: buildBomCsv(layout),
            pnpCsv: buildPnpCsv(routedBoard),
        },
        stats: stats(routedBoard, routeErrors.length, started),
        fab,
        delivery,
        namesById: adapted.namesById,
        netNameById: adapted.netNameById,
    };
}

/**
 * Structured pass-through of a tool's error element (tscircuit/KiCad/freerouting) WITHOUT hand-mapping:
 * the tool's own `type` is the errorType, its message/description is forwarded verbatim, and any id-like
 * fields are collected as refs generically. Unknown/new error types flow through unchanged — nothing is
 * dropped and there is no per-error table to maintain (handles ALL errors by construction).
 */
function errText(err: Record<string, unknown>): string {
    if (typeof err.message === 'string') return err.message;
    if (typeof err.error === 'string') return err.error;
    return String(err.type);
}
/** Collect id-like values from any *_id / *_ids field (generic — no per-error-type knowledge). */
function errRefs(err: Record<string, unknown>): string[] {
    const refs: string[] = [];
    for (const [k, v] of Object.entries(err)) {
        if (!/_id$|_ids$/.test(k)) continue;
        for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string') refs.push(x);
    }
    return refs;
}
function passThroughError(err: { type: string; [k: string]: unknown }, tool: string): LayoutDiagnostic {
    const refs = errRefs(err);
    return {
        code: 'PCB031',
        severity: 'error',
        message: `${tool}: ${errText(err)}`,
        errorType: err.type,
        refs: refs.length ? refs : undefined,
    };
}

/** Result of the Lever-2 auto-placement attempt (adopted:false ⇒ the grid pass stays untouched). */
interface AutoPlacementAttempt {
    adopted: boolean;
    diagnostics: LayoutDiagnostic[];
    /** Why the advanced placement was NOT adopted. Present exactly when adopted === false, and it is
     *  what LayoutResult.delivery.placement.degradedReason reports. */
    reason?: string;
    code?: string;
    evaluated?: TscElement[];
    parity?: ParityResult;
}

/**
 * Two-pass connectivity-aware placement (PLACEMENT_PLAN.md §4). Extract REAL geometry from the valid
 * grid pass, run the pure engine, and adopt ONLY if HPWL improved AND the re-generated board passes
 * eval + parity again. Every decision lands in diagnostics (PCB050 adopted/info, PCB051 not adopted).
 */
async function attemptAutoPlacement(
    circuit: CircuitJson,
    opts: LayoutOptions,
    layout: LayoutabilityResult,
    adapted: AdapterResult,
    gridEvaluated: TscElement[],
    profile: FabProfile,
    spacingMm: number | undefined,
    /** RESCUE mode: the grid baseline is INVALID (it overlapped a courtyard), so there is no valid HPWL to
     *  beat — adopt ANY placement that re-evaluates valid. Off = normal HPWL-gated improvement. */
    adoptOnValidity = false,
): Promise<AutoPlacementAttempt> {
    const diags: LayoutDiagnostic[] = [];
    const placementLabel = opts.placer === 'rust' ? 'rust-placement' : 'auto-placement';
    const keepGrid = (why: string, severity: 'info' | 'warning' = 'info'): AutoPlacementAttempt => {
        diags.push({
            code: 'PCB051',
            severity,
            message: `${placementLabel} not adopted — ${why} (grid placement kept; floor guarantee).`,
        });
        return { adopted: false, diagnostics: diags, reason: why };
    };

    const { parts, missing } = extractPlacementParts(gridEvaluated, adapted.namesById, layout);
    if (missing.length) {
        diags.push({
            code: 'PCB050',
            severity: 'info',
            message: `${placementLabel}: ${missing.length} part(s) without resolvable geometry keep their grid spot (${missing.join(', ')}).`,
        });
    }
    if (parts.length < 2) return keepGrid('fewer than 2 parts with resolvable geometry');

    const netWeights = buildNetWeights(circuit, adapted.netNameById);
    const extraEdges = deriveExtraEdges(circuit, adapted.namesById);
    const gridPos = gridPositions(
        gridEvaluated,
        parts.map((p) => p.id),
    );
    const hpwlGrid = computeHpwl(parts, gridPos);

    const placementInput: PlacementInput = {
        parts,
        netWeights,
        extraEdges,
        boardW: adapted.boardWidthMm,
        boardH: adapted.boardHeightMm,
        gridMm: profile.placementGridMm ?? 0.5,
        marginMm: profile.placementMarginMm ?? 4,
        spacingMm,
    };
    let placed: PlacementOutput;
    if (opts.placer === 'rust') {
        if (!opts.rustPlace) return keepGrid('Rust placement runner is not configured', 'warning');
        const started = Date.now();
        try {
            placed = await opts.rustPlace(placementInput);
        } catch (e) {
            return keepGrid(`Rust placement runner failed: ${String(e).slice(0, 180)}`, 'warning');
        }
        diags.push({
            code: 'PCB050',
            severity: 'info',
            message: `rust-placement engine completed in ${Date.now() - started}ms (process + JSON included).`,
        });
    } else {
        placed = placeParts(placementInput);
    }
    for (const note of placed.notes)
        diags.push({ code: 'PCB050', severity: 'info', message: `${placementLabel}: ${note}` });
    if (!placed.ok) return keepGrid('legalization failed even after board growth', 'warning');
    if (!adoptOnValidity && placed.hpwl >= hpwlGrid)
        return keepGrid(
            `HPWL did not improve (${placementLabel} ${placed.hpwl.toFixed(1)}mm vs grid ${hpwlGrid.toFixed(1)}mm)`,
        );

    // pass 2: regenerate with verbatim mm placements + the fitted board, then re-verify EVERYTHING
    const adapted2 = generateTscircuitCode(circuit, opts.ui, layout, {
        boardWidthMm: placed.boardW,
        boardHeightMm: placed.boardH,
        boardExtraProps: boardExtraProps(profile),
        placementsById: placed.positions,
    });
    let evaluated2 = await evaluateTscircuit(adapted2.code);
    const errors2 = evaluated2.filter((e) => e.type.endsWith('_error'));
    // With the quality router, the LOCAL route is scaffolding — freerouting strips and re-routes the
    // copper, and the DRC oracle judges completeness. So local ROUTE-class errors on the denser auto
    // board are tolerated (stripped); geometry errors (courtyard overlap, ...) stay blocking.
    const routeTolerated = opts.router === 'quality' && !!opts.freeroute;
    const isRouteClass = (t: string) => /trace|rout/i.test(t);
    const blocking = errors2.filter((e) => !(routeTolerated && isRouteClass(e.type)));
    if (blocking.length > 0) {
        return keepGrid(
            `pass-2 eval reported ${blocking.length} blocking error(s), first: ${blocking[0]!.type}`,
            'warning',
        );
    }
    if (errors2.length > 0) {
        diags.push({
            code: 'PCB050',
            severity: 'info',
            message: `${placementLabel}: pass-2 local route incomplete (${errors2.length} route error(s)) — freerouting re-routes; the DRC oracle decides.`,
        });
        evaluated2 = evaluated2.filter((e) => !e.type.endsWith('_error'));
    }
    const parity2 = checkConnectivityParity(evaluated2, adapted2.expectations);
    if (!parity2.ok) return keepGrid('pass-2 connectivity parity failed', 'warning');

    diags.push({
        code: 'PCB050',
        severity: 'info',
        message: adoptOnValidity
            ? `${placementLabel} ADOPTED (courtyard-overlap rescue — the size-blind grid packed a part into a cell smaller than its courtyard) — board ${placed.boardW}×${placed.boardH}mm.`
            : `${placementLabel} ADOPTED — HPWL ${hpwlGrid.toFixed(1)} → ${placed.hpwl.toFixed(1)}mm (${(100 * (1 - placed.hpwl / hpwlGrid)).toFixed(0)}% shorter), board ${placed.boardW}×${placed.boardH}mm.`,
    });
    return { adopted: true, diagnostics: diags, code: adapted2.code, evaluated: evaluated2, parity: parity2 };
}

/** Build the manufacturable .kicad_pcb (traces + optional GND pour) — shared by the final output and the
 *  DRC-oracle retry so the notary judges exactly what ships. */
async function assembleKicadPcb(
    board: TscElement[],
    profile: FabProfile,
): Promise<{ kicadPcb: string; pour: 'ok' | 'unsafe-unnetted-copper' | 'no-net' | 'off' }> {
    const raw = await generateKicadPcb(board);
    if (!profile.gndPour) return { kicadPcb: raw, pour: 'off' };
    const zone = injectZone(raw, 'GND', 'B.Cu');
    return zone.kind === 'ok' ? { kicadPcb: zone.kicadPcb, pour: 'ok' } : { kicadPcb: raw, pour: zone.kind };
}

/**
 * Merge explicit `profile.perNetMinWidthMm` with IPC-2221 widths computed from `netCurrentsA`. Emits a
 * diagnostic per widened net (and per clamp) so the sizing is never silent. Keyed by EMITTED net name.
 */
function computeIpcWidths(
    netCurrentsA: Record<string, number> | undefined,
    profile: FabProfile,
    diagnostics: LayoutDiagnostic[],
): Record<string, number> {
    const widths: Record<string, number> = { ...(profile.perNetMinWidthMm ?? {}) };
    if (!netCurrentsA) return widths;
    for (const [net, currentA] of Object.entries(netCurrentsA)) {
        // A current we cannot size from must be REFUSED, never silently treated as "no current stated".
        // `Math.abs('2A')` is NaN, the envelope clamp cannot fire on NaN (a comparison with NaN is always
        // false), so `clamped` stays false, PCB040/PCB041 both stay quiet, and the net drops to the signal
        // floor — a rail the caller declared at 2 A ships as a 0.2 mm trace with nothing anywhere saying so.
        // KiCad DRC cannot catch it either: the board carries one global minimum width, which that trace
        // meets. Same posture as resolveFabProfile's per-entry handling of perNetMinWidthMm.
        if (typeof currentA !== 'number' || !Number.isFinite(currentA) || currentA <= 0) {
            diagnostics.push({
                code: 'PCB041',
                severity: 'warning',
                message: `net ${net}: ignored current ${JSON.stringify(currentA)} — not a positive finite number, so no IPC-2221 width was computed and the net routes at the ${profile.minTraceWidthMm}mm signal default.`,
            });
            continue;
        }
        const r = ipc2221WidthMm({ currentA, copperOz: profile.copperOz, deltaTC: profile.deltaTC });
        const widthMm = Math.max(r.widthMm, profile.minTraceWidthMm, widths[net] ?? 0);
        widths[net] = widthMm;
        if (widthMm > profile.minTraceWidthMm) {
            diagnostics.push({
                code: 'PCB040',
                severity: 'info',
                message: `net ${net}: ${currentA}A → IPC-2221 min width ${widthMm}mm (vs ${profile.minTraceWidthMm}mm signal default).`,
            });
        }
        if (r.clamped) {
            diagnostics.push({
                code: 'PCB041',
                severity: 'warning',
                message: `net ${net} IPC-2221 sizing clamped — ${r.notes.join('; ')}`,
            });
        }
    }
    return widths;
}

/** After a quality route, confirm each widened net actually carries a trace at (≈) its target width. */
function verifyPerNetWidths(
    board: TscElement[],
    perNetWidthMm: Record<string, number>,
    diagnostics: LayoutDiagnostic[],
): void {
    const wide = Object.entries(perNetWidthMm).filter(([, mm]) => mm > 0);
    if (wide.length === 0) return;
    const srcTraceById = new Map(
        board
            .filter((e) => e.type === 'source_trace')
            .map((e) => [(e as { source_trace_id?: string }).source_trace_id, e]),
    );
    const netNameById = new Map(
        board
            .filter((e) => e.type === 'source_net')
            .map((e) => [(e as { source_net_id?: string }).source_net_id, (e as { name?: string }).name]),
    );
    const maxWidthByNet = new Map<string, number>();
    for (const t of board.filter((e) => e.type === 'pcb_trace')) {
        const st = srcTraceById.get((t as { source_trace_id?: string }).source_trace_id) as
            | { connected_source_net_ids?: string[] }
            | undefined;
        const name = st?.connected_source_net_ids?.[0] ? netNameById.get(st.connected_source_net_ids[0]) : undefined;
        if (!name) continue;
        const w = Math.max(...((t as { route?: Array<{ width?: number }> }).route ?? []).map((p) => p.width ?? 0), 0);
        maxWidthByNet.set(name, Math.max(maxWidthByNet.get(name) ?? 0, w));
    }
    for (const [net, target] of wide) {
        if (target <= 0) continue;
        const got = maxWidthByNet.get(net);
        if (got === undefined) continue; // net not on this board (or single-pin) — nothing to check
        if (got < target * 0.95) {
            diagnostics.push({
                code: 'PCB042',
                severity: 'warning',
                message: `net ${net} routed at ${got.toFixed(2)}mm but IPC-2221 needs ${target}mm — the router narrowed it; widen the board or check clearances.`,
            });
        }
    }
}

/** Reroute a placed board through the injected freerouting runner and splice the copper back. */
/** applyQualityRoute's outcome. `reason` is present exactly when the quality tier was NOT used, and it
 *  is what LayoutResult.delivery.routing.degradedReason reports — so a fallback can never be silent. */
interface QualityRouteOutcome {
    routedBoard: TscElement[];
    qualityApplied: boolean;
    clean: boolean;
    marginMm?: number;
    reason?: string;
    /** The router or the DRC oracle THREW — an infrastructure fault, not a verdict about this board.
     *  A dirty board and a broken tool must not drive the same retry policy: retrying a broken tool on a
     *  bigger board only spends the timeout again. */
    toolFailed?: boolean;
}

async function applyQualityRoute(
    evaluated: TscElement[],
    opts: LayoutOptions,
    profile: FabProfile,
    perNetWidthMm: Record<string, number>,
    diagnostics: LayoutDiagnostic[],
): Promise<QualityRouteOutcome> {
    if (opts.router !== 'quality')
        return { routedBoard: evaluated, qualityApplied: false, clean: false, reason: "router:'fast' was requested" };
    if (!opts.freeroute) {
        diagnostics.push({
            code: 'PCB030',
            severity: 'info',
            message: "router:'quality' requested but no freeroute runner was injected — using the local fast route.",
        });
        return {
            routedBoard: evaluated,
            qualityApplied: false,
            clean: false,
            reason: 'no freerouting runner was injected',
        };
    }
    try {
        // Margin-retry: freerouting completion is non-monotonic in the routing margin, so try a spread and
        // accept the first margin whose board passes the oracle. With an injected notaryDrc the oracle is
        // REAL DRC (0 violations AND 0 unconnected — the only reliable completeness check); otherwise it's
        // the cheap net-presence pre-check (fully-dropped nets only). No accepted margin -> fall back to the
        // fully-connected local route (never an open net).
        const best = await routeBestMargin(evaluated, opts, profile, perNetWidthMm);
        if (!best.accepted) {
            diagnostics.push({
                code: 'PCB036',
                severity: 'warning',
                message: `no ${best.mode === 'drc' ? 'DRC-clean' : 'fully-routed'} quality route across ${best.tried} margin attempt(s) — using the fully-connected local route instead (the notary flags its via geometry, never an open net).`,
            });
            return {
                routedBoard: evaluated,
                qualityApplied: false,
                clean: false,
                reason: `no ${best.mode === 'drc' ? 'DRC-clean' : 'fully-routed'} quality route across ${best.tried} margin attempt(s)`,
            };
        }
        const traces = best.routedBoard!.filter((e) => e.type === 'pcb_trace').length;
        const vias = best.routedBoard!.filter((e) => e.type === 'pcb_via').length;
        diagnostics.push({
            code: 'PCB030',
            severity: 'info',
            message:
                `quality route (freerouting) applied — ${traces} trace(s), ${vias} via(s) at margin ${best.marginMm}mm` +
                (best.mode === 'drc'
                    ? ' — DRC-clean confirmed by the notary oracle.'
                    : '; the notary confirms full connectivity.'),
        });
        return {
            routedBoard: best.routedBoard!,
            qualityApplied: true,
            clean: best.mode === 'drc',
            marginMm: best.marginMm,
        };
    } catch (e) {
        diagnostics.push({
            code: 'PCB035',
            severity: 'warning',
            message: `quality route failed (${String(e).slice(0, 160)}) — falling back to the local fast route.`,
        });
        return {
            routedBoard: evaluated,
            qualityApplied: false,
            clean: false,
            reason: `quality route failed: ${String(e).slice(0, 200)}`,
            toolFailed: true,
        };
    }
}

/**
 * Try a spread of routing margins; return the first margin whose board passes the oracle.
 * Oracle = injected notaryDrc (real KiCad DRC: 0 violations AND 0 unconnected — the reliable one) when
 * present, else the cheap net-presence pre-check. `accepted:false` means no margin passed (caller falls
 * back to the local route). An explicit routingMarginMm is a binding single-margin cap.
 */
async function routeBestMargin(
    evaluated: TscElement[],
    opts: LayoutOptions,
    profile: FabProfile,
    perNetWidthMm: Record<string, number>,
): Promise<{
    routedBoard: TscElement[] | null;
    accepted: boolean;
    marginMm: number;
    tried: number;
    mode: 'drc' | 'presence';
}> {
    const freeroute = opts.freeroute!;
    const notaryDrc = opts.notaryDrc;
    const mode = notaryDrc ? 'drc' : 'presence';
    const margins = opts.routingMarginMm !== undefined ? [opts.routingMarginMm] : [6, 4, 10, 2, 8, 12];
    let tried = 0;
    for (const marginMm of margins) {
        tried++;
        const routingBase = enlargeBoard(evaluated, marginMm);
        const dsn = await exportDsn(stripRouting(routingBase), profile, perNetWidthMm);
        const ses = await freeroute(dsn);
        if (notaryDrc) {
            const routed = await mergeSes(routingBase, dsn, ses);
            const { kicadPcb } = await assembleKicadPcb(routed, profile);
            if (await notaryDrc(kicadPcb, kicadProjectJson(profile)))
                return { routedBoard: routed, accepted: true, marginMm, tried, mode };
        } else if (findFullyUnroutedNets(dsn, ses).length === 0) {
            return { routedBoard: await mergeSes(routingBase, dsn, ses), accepted: true, marginMm, tried, mode };
        }
    }
    return { routedBoard: null, accepted: false, marginMm: 0, tried, mode };
}

/** Report vias below the fab profile on the final copper (never mutate — enlarging manufactures shorts). */
function reportViaComplianceInto(
    board: TscElement[],
    profile: FabProfile,
    qualityApplied: boolean,
    diagnostics: LayoutDiagnostic[],
): void {
    const viaCompliance = reportViaCompliance(board, profile);
    if (viaCompliance.undersized === 0) return;
    const tail = qualityApplied
        ? ' — unexpected on a quality route; the notary will flag annular_width.'
        : ' — local-router limitation; the notary will flag annular_width until a quality route is applied.';
    diagnostics.push({
        code: 'PCB034',
        severity: 'warning',
        message:
            `${viaCompliance.undersized}/${viaCompliance.total} via(s) below the fab profile ` +
            `(drill ${profile.viaDrillMm}mm / annular ${profile.viaAnnularMm}mm)${tail}`,
    });
}

function stats(evaluated: TscElement[], errors: number, started: number): LayoutStats {
    return {
        traces: evaluated.filter((e) => e.type === 'pcb_trace').length,
        vias: evaluated.filter((e) => e.type === 'pcb_via').length,
        errors,
        durationMs: Date.now() - started,
    };
}

function failed(
    layout: LayoutabilityResult,
    diagnostics: LayoutDiagnostic[],
    started: number,
    fab: { tier: FabTierName; profile: FabProfile },
    opts: LayoutOptions,
): LayoutResult {
    return {
        ok: false,
        completeness: layout.completeness,
        diagnostics,
        code: '',
        evaluated: [],
        parity: { ok: false, diagnostics: [], checkedPins: 0, expectedPins: 0 },
        outputs: null,
        stats: { traces: 0, vias: 0, errors: 0, durationMs: Date.now() - started },
        fab,
        delivery: undelivered(opts, 'the circuit was not layoutable — nothing was placed or routed'),
        namesById: {},
        netNameById: {},
    };
}

// ---------------------------------------------------------------- public surface
export { classifyCircuit } from './layoutability';
export type { LayoutabilityResult, LayoutDiagnostic, ComponentPlan, LayoutRole } from './layoutability';
export { resolveFootprint, normalizeFootprint, isLedDiode } from './footprints';
export type { FootprintResolution } from './footprints';
export { generateTscircuitCode, sanitizeName, buildNetNames } from './adapter';
export type { AdapterResult, PinExpectation, AdapterOptions } from './adapter';
export { checkConnectivityParity } from './parity';
export type { ParityResult, TscElement } from './parity';
export {
    JLC_FAB_PROFILE,
    FAB_TIERS,
    boardExtraProps,
    kicadProjectJson,
    injectZone,
    reportViaCompliance,
    resolveFabProfile,
} from './fab-profile';
export type { FabProfile, FabProfileInput, FabTierName, ResolvedFabProfile, ZoneInjectionResult } from './fab-profile';
export { generateGerbers, generateKicadPcb, buildBomCsv, buildPnpCsv } from './outputs';
export type { GerberOutputs } from './outputs';
export { evaluateTscircuit } from './evaluate';
export { exportDsn, mergeSes, stripRouting, applyFabRulesToDsn, applyPerNetWidths, enlargeBoard } from './route';
export type { FreeroutingRunner } from './route';
export { ipc2221WidthMm } from './ipc2221';
export type { IpcWidthInput, IpcWidthResult } from './ipc2221';
export { placeParts, computeHpwl, rot } from './placement';
export type { PlacementInput, PlacementOutput, PlaceablePart, PlaceablePad, Rotation } from './placement';
export { resolveModel, injectModels, KICAD_3DMODEL_BASE } from './models3d';
export type { InjectModelsResult } from './models3d';
export { shapeLayoutResult } from './layout-result';
export type { LayoutGeometry, LayoutComponent, LayoutPad, LayoutTrace, LayoutVia, Pt } from './layout-result';
export { parseDrcReport, drcCategory, drcToChecks, airwiresFromDrc } from './drc';
export type { ParsedDrc, DrcEntry, DrcItem, DrcCheck, Airwire } from './drc';
export type { PlacementRunner } from './placement-engine';
// Re-export the eda-core scope manifest so the pcb-worker (which depends only on pcb-core) can emit the
// layout verdict's disclosure fragment without a direct eda-core dependency.
export { buildLayoutScope, buildManifest, CHECK_IDS, CHECK_LABELS } from '@circuit-forge/eda-core';
export type {
    ScopeManifest,
    CheckId,
    CheckStatus,
    CheckGradation,
    CheckEntry,
    DeterminedEntry,
} from '@circuit-forge/eda-core';
