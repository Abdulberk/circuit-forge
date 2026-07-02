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

export interface LayoutOptions {
    ui?: UiJson;
    fabProfile?: FabProfile;
    /** Accept a PARTIAL board when load-bearing sim-primitives are excluded (default: fail honest). */
    allowPartial?: boolean;
    /** 'fast' = tscircuit local router (Phase 1). 'quality' (freerouting) lands in Phase 2 — the
     *  option exists now so the signature never breaks (approval condition 5). */
    router?: 'fast' | 'quality';
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

    if (opts.router === 'quality') {
        diagnostics.push({
            code: 'PCB030',
            severity: 'info',
            message: "router:'quality' (freerouting) arrives with the Phase-2 worker — using the local fast router.",
        });
    }

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

    // 3) headless eval + local autoroute
    const evaluated = await evaluateTscircuit(adapted.code);
    // Post-route via ENLARGEMENT manufactures shorts (proven live), so undersized vias are only
    // REPORTED here; the Phase-2 quality router routes with compliant via geometry from the start.
    const viaCompliance = reportViaCompliance(evaluated, profile);
    if (viaCompliance.undersized > 0) {
        diagnostics.push({
            code: 'PCB034',
            severity: 'warning',
            message:
                `${viaCompliance.undersized}/${viaCompliance.total} via(s) below the fab profile ` +
                `(drill ${profile.viaDrillMm}mm / annular ${profile.viaAnnularMm}mm) — local-router limitation; ` +
                `the notary will flag annular_width until the quality router (Phase 2) takes over.`,
        });
    }
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

    // 5) production outputs (fab profile downstream: .kicad_pro rules + optional GND pour)
    const gerbers = await generateGerbers(evaluated);
    let kicadPcb = await generateKicadPcb(evaluated);
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
        evaluated,
        parity,
        outputs: {
            gerbers,
            kicadPcb,
            kicadPro: kicadProjectJson(profile),
            bomCsv: buildBomCsv(layout),
            pnpCsv: buildPnpCsv(evaluated),
        },
        stats: stats(evaluated, routeErrors.length, started),
    };
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
export { exportDsn, mergeSes, stripRouting } from './route';
