/**
 * @circuit-forge/pcb-core — Phase 1: CircuitJson -> placed+routed board -> production outputs.
 *
 * `layoutCircuit` is the single entry: classify (honest layoutability) -> generate tscircuit code
 * (fab profile enforced upstream) -> headless eval+route (local, network-free) -> CONNECTIVITY
 * PARITY against our own netlist (approval condition 1 — a DRC-clean but miswired board can never
 * pass silently) -> Gerber/.kicad_pcb/.kicad_pro/BOM/PnP (fab profile enforced downstream too).
 */
import type { CircuitJson, UiJson } from '@circuit-forge/eda-core';
import { classifyCircuit, type LayoutabilityResult, type LayoutDiagnostic } from './layoutability';
import { generateTscircuitCode } from './adapter';
import { evaluateTscircuit } from './evaluate';
import { checkConnectivityParity, type ParityResult, type TscElement } from './parity';
import { boardExtraProps, reportViaCompliance, injectZone, kicadProjectJson, JLC_FAB_PROFILE, type FabProfile } from './fab-profile';
import { generateGerbers, generateKicadPcb, buildBomCsv, buildPnpCsv, type GerberOutputs } from './outputs';
import { exportDsn, mergeSes, stripRouting, enlargeBoard, findFullyUnroutedNets, type FreeroutingRunner } from './route';

export interface LayoutOptions {
    ui?: UiJson;
    fabProfile?: FabProfile;
    /** Accept a PARTIAL board when load-bearing sim-primitives are excluded (default: fail honest). */
    allowPartial?: boolean;
    /** 'fast' = tscircuit local router (deterministic, network-free). 'quality' = freerouting, applied
     *  only when a `freeroute` runner is injected (this library never touches Docker/child_process). */
    router?: 'fast' | 'quality';
    /** DSN -> SES freerouting executor, injected by the harness/worker (keeps pcb-core pure). Required
     *  for `router:'quality'`; absent, quality gracefully degrades to the fast local route. */
    freeroute?: FreeroutingRunner;
    /** Routing headroom (mm/side) added to the board before a quality route so freerouting can complete
     *  tight auto-sized boards. Default 6. Set 0 to route within the exact auto-size outline. */
    routingMarginMm?: number;
    boardWidthMm?: number;
    boardHeightMm?: number;
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
}

export async function layoutCircuit(circuit: CircuitJson, opts: LayoutOptions = {}): Promise<LayoutResult> {
    const started = Date.now();
    const profile = opts.fabProfile ?? JLC_FAB_PROFILE;
    const diagnostics: LayoutDiagnostic[] = [];

    // 1) honest pre-flight
    const layout = classifyCircuit(circuit, { allowPartial: opts.allowPartial });
    diagnostics.push(...layout.diagnostics);
    if (!layout.layoutable) {
        return failed(layout, diagnostics, started);
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
    const evaluated = await evaluateTscircuit(adapted.code);
    const routeErrors = evaluated.filter((e) => e.type.endsWith('_error'));
    for (const err of routeErrors) {
        diagnostics.push({
            code: 'PCB031',
            severity: 'error',
            message: `tscircuit: ${err.type}${'message' in err ? ` — ${String((err as { message?: unknown }).message)}` : ''}`,
        });
    }

    // 4) connectivity parity — OUR netlist vs the evaluated board (condition 1)
    const parity = checkConnectivityParity(evaluated, adapted.expectations);
    diagnostics.push(...parity.diagnostics);

    const ok = parity.ok && !diagnostics.some((d) => d.severity === 'error');
    if (!ok) {
        return {
            ok,
            completeness: layout.completeness,
            diagnostics,
            code: adapted.code,
            evaluated,
            parity,
            outputs: null, // never emit a "manufacturable package" for a board that failed parity/route
            stats: stats(evaluated, routeErrors.length, started),
        };
    }

    // 5) quality route (freerouting), applied only when a runner is injected. Reroute from placement,
    //    then splice the SES copper back onto the full board — components/pads/bodies preserved.
    //    Proven live 3 Tem 2026: this flow comes back DRC-CLEAN where the local route needs the notary.
    const { routedBoard, qualityApplied } = await applyQualityRoute(evaluated, opts, profile, diagnostics);

    // Via compliance on the FINAL copper. freerouting routes with the DSN padstack (0.6/0.3 = compliant),
    // so quality boards clear this; the local router's undersized vias are an honest limitation we report
    // (never enlarge post-route — that manufactures shorts, proven live).
    reportViaComplianceInto(routedBoard, profile, qualityApplied, diagnostics);

    // 6) production outputs (fab profile downstream: .kicad_pro rules + optional GND pour)
    const gerbers = await generateGerbers(routedBoard);
    let kicadPcb = await generateKicadPcb(routedBoard);
    if (profile.gndPour) {
        const zone = injectZone(kicadPcb, 'GND', 'B.Cu');
        if (zone.kind === 'ok') {
            kicadPcb = zone.kicadPcb;
            diagnostics.push({
                code: 'PCB032',
                severity: 'info',
                message: 'GND pour injected on B.Cu — the notary fills it via --refill-zones (KiCad 10).',
            });
        } else if (zone.kind === 'unsafe-unnetted-copper') {
            diagnostics.push({
                code: 'PCB033',
                severity: 'info',
                message:
                    'GND pour skipped: the kicad converter emits copper segments without net assignment ' +
                    '(upstream gap) — a fill against un-netted copper would false-short. Pour returns when ' +
                    'segments carry nets (upstream fix or Phase-2 notary-side netting).',
            });
        } else {
            diagnostics.push({
                code: 'PCB033',
                severity: 'info',
                message: 'gndPour requested but no GND net exists on the board — pour skipped.',
            });
        }
    }

    return {
        ok,
        completeness: layout.completeness,
        diagnostics,
        code: adapted.code,
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
    };
}

/** Reroute a placed board through the injected freerouting runner and splice the copper back. */
async function applyQualityRoute(
    evaluated: TscElement[],
    opts: LayoutOptions,
    profile: FabProfile,
    diagnostics: LayoutDiagnostic[],
): Promise<{ routedBoard: TscElement[]; qualityApplied: boolean }> {
    if (opts.router !== 'quality') return { routedBoard: evaluated, qualityApplied: false };
    if (!opts.freeroute) {
        diagnostics.push({
            code: 'PCB030',
            severity: 'info',
            message: "router:'quality' requested but no freeroute runner was injected — using the local fast route.",
        });
        return { routedBoard: evaluated, qualityApplied: false };
    }
    try {
        // freerouting completion on a tight auto-sized board is non-monotonic in the routing margin
        // (proven live 3 Tem 2026: margin 5 & 12 complete, 8 leaves a net unrouted). So try a spread of
        // margins and keep the first that routes EVERY net (SES-level oracle, no Docker); fall to the
        // best partial otherwise. The enlarged board is the splice base, so its outline stays consistent.
        const best = await routeBestMargin(evaluated, opts, profile);
        if (best.unrouted.length > 0) {
            // freerouting dropped a whole net (electrically broken) — worse than the fast route, which is
            // fully connected (only its via geometry trips DRC). Ship the fast board and say so honestly;
            // the notary flags its vias, never a silent open.
            diagnostics.push({
                code: 'PCB036',
                severity: 'warning',
                message: `quality route left ${best.unrouted.length} net(s) fully unrouted (${best.unrouted.slice(0, 4).join(', ')}) after ${best.tried} margin attempt(s) — using the fully-routed local route instead (a manual board-size/placement hint may let freerouting complete it).`,
            });
            return { routedBoard: evaluated, qualityApplied: false };
        }
        const traces = best.routedBoard.filter((e) => e.type === 'pcb_trace').length;
        const vias = best.routedBoard.filter((e) => e.type === 'pcb_via').length;
        // "no fully-dropped net" is all the library can verify without DRC; the notary's unconnected_items
        // check is the authority on per-connection completeness (see findFullyUnroutedNets).
        diagnostics.push({
            code: 'PCB030',
            severity: 'info',
            message: `quality route (freerouting) applied — ${traces} trace(s), ${vias} via(s) at margin ${best.marginMm}mm; the notary confirms full connectivity.`,
        });
        return { routedBoard: best.routedBoard, qualityApplied: true };
    } catch (e) {
        diagnostics.push({
            code: 'PCB035',
            severity: 'warning',
            message: `quality route failed (${String(e).slice(0, 160)}) — falling back to the local fast route.`,
        });
        return { routedBoard: evaluated, qualityApplied: false };
    }
}

/** Try a spread of routing margins; return the first fully-routed result, else the least-unrouted one. */
async function routeBestMargin(
    evaluated: TscElement[],
    opts: LayoutOptions,
    profile: FabProfile,
): Promise<{ routedBoard: TscElement[]; unrouted: string[]; marginMm: number; tried: number }> {
    const freeroute = opts.freeroute!;
    // An EXPLICIT routingMarginMm is a binding cap: try only that size (no auto-growth), honouring the
    // LayoutOptions contract ("Set 0 to route within the exact auto-size outline"). When unset, sweep a
    // spread — freerouting completion is non-monotonic in the margin, so more candidates route more boards.
    const margins = opts.routingMarginMm !== undefined ? [opts.routingMarginMm] : [6, 4, 10, 2, 8, 12];
    // Only the winning (fully-routed) margin is spliced; partial attempts keep just their unrouted metadata
    // (the caller falls back to the fast board when none complete), so mergeSes runs at most once.
    let fewest: { unrouted: string[]; marginMm: number } | null = null;
    let tried = 0;
    for (const marginMm of margins) {
        tried++;
        const routingBase = enlargeBoard(evaluated, marginMm);
        const dsn = await exportDsn(stripRouting(routingBase), profile);
        const ses = await freeroute(dsn);
        const unrouted = findFullyUnroutedNets(dsn, ses);
        if (unrouted.length === 0) {
            return { routedBoard: await mergeSes(routingBase, dsn, ses), unrouted, marginMm, tried };
        }
        if (!fewest || unrouted.length < fewest.unrouted.length) fewest = { unrouted, marginMm };
    }
    return { routedBoard: evaluated, unrouted: fewest!.unrouted, marginMm: fewest!.marginMm, tried };
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

function failed(layout: LayoutabilityResult, diagnostics: LayoutDiagnostic[], started: number): LayoutResult {
    return {
        ok: false,
        completeness: layout.completeness,
        diagnostics,
        code: '',
        evaluated: [],
        parity: { ok: false, diagnostics: [], checkedPins: 0, expectedPins: 0 },
        outputs: null,
        stats: { traces: 0, vias: 0, errors: 0, durationMs: Date.now() - started },
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
export { JLC_FAB_PROFILE, boardExtraProps, kicadProjectJson, injectZone, reportViaCompliance } from './fab-profile';
export type { FabProfile, ZoneInjectionResult } from './fab-profile';
export { generateGerbers, generateKicadPcb, buildBomCsv, buildPnpCsv } from './outputs';
export type { GerberOutputs } from './outputs';
export { evaluateTscircuit } from './evaluate';
export { exportDsn, mergeSes, stripRouting, applyFabRulesToDsn, enlargeBoard } from './route';
export type { FreeroutingRunner } from './route';
export { resolveModel, injectModels, KICAD_3DMODEL_BASE } from './models3d';
export type { InjectModelsResult } from './models3d';
