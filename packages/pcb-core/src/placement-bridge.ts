/**
 * Bridge between the evaluated tscircuit soup / OUR CircuitJson and the pure placement engine
 * (PLACEMENT_PLAN.md §4.1–4.2). Extracts REAL part geometry from eval pass 1 (no curated dimension
 * tables), derives net weights and the decap→IC ownership edges the netlist doesn't carry, and
 * reads back the grid baseline positions for the HPWL comparison.
 */
import type { CircuitJson } from '@circuit-forge/eda-core';
import { parseSpiceValue } from '@circuit-forge/eda-core';

import type { LayoutabilityResult } from './layoutability';
import type { TscElement } from './parity';
import type { PlaceablePart, Rotation } from './placement';

type AnyEl = TscElement & Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Build PlaceablePart[] from the pass-1 soup: pcb_component gives real w/h/center; pcb_port positions
 * (relative to the component center — pass 1 emits rotation 0) are the electrical pads; net names come
 * from source_trace membership. Parts whose geometry can't be resolved are skipped with a note (the
 * engine then simply doesn't move them — they keep their grid spot via the adapter fallback).
 */
export function extractPlacementParts(
    evaluated: TscElement[],
    namesById: Record<string, string>,
    layout: LayoutabilityResult,
): { parts: PlaceablePart[]; missing: string[] } {
    const els = evaluated as AnyEl[];
    const srcCompIdByName = new Map<string, string>();
    for (const e of els) {
        if (e.type !== 'source_component') continue;
        const name = str(e.name);
        const id = str(e.source_component_id);
        if (name && id) srcCompIdByName.set(name, id);
    }

    // source_port -> net name (via source_trace membership + source_net names)
    const netNameBySrcNetId = new Map<string, string>();
    for (const e of els) {
        if (e.type !== 'source_net') continue;
        const id = str(e.source_net_id);
        const name = str(e.name);
        if (id && name) netNameBySrcNetId.set(id, name);
    }
    const netBySrcPort = new Map<string, string>();
    for (const e of els) {
        if (e.type !== 'source_trace') continue;
        const ports = Array.isArray(e.connected_source_port_ids) ? (e.connected_source_port_ids as unknown[]) : [];
        const nets = Array.isArray(e.connected_source_net_ids) ? (e.connected_source_net_ids as unknown[]) : [];
        const netName = nets.length ? netNameBySrcNetId.get(String(nets[0])) : undefined;
        if (!netName) continue;
        for (const p of ports) if (typeof p === 'string') netBySrcPort.set(p, netName);
    }

    const srcCompByPortId = new Map<string, string>();
    for (const e of els) {
        if (e.type !== 'source_port') continue;
        const pid = str(e.source_port_id);
        const cid = str(e.source_component_id);
        if (pid && cid) srcCompByPortId.set(pid, cid);
    }

    // pcb_port world positions grouped by owning source component
    const portsBySrcComp = new Map<string, Array<{ x: number; y: number; net: string }>>();
    for (const e of els) {
        if (e.type !== 'pcb_port') continue;
        const spid = str(e.source_port_id);
        const x = num(e.x);
        const y = num(e.y);
        if (!spid || x === null || y === null) continue;
        const comp = srcCompByPortId.get(spid);
        if (!comp) continue;
        let arr = portsBySrcComp.get(comp);
        if (!arr) portsBySrcComp.set(comp, (arr = []));
        arr.push({ x, y, net: netBySrcPort.get(spid) ?? '' });
    }

    // TRUE footprint extent per pcb_component: the body alone is NOT the courtyard (pads stick out —
    // SOIC gull-wings, passive end caps). Union the body box with every pad's box and any courtyard
    // element; symmetric about the component center (measured 5 Tem 2026: body-only sizing made eval#2
    // reject most auto placements with pcb_courtyard_overlap_error).
    const extentByPcbComp = new Map<string, { hx: number; hy: number }>();
    const widen = (pcbId: string, dx: number, dy: number) => {
        const e = extentByPcbComp.get(pcbId) ?? { hx: 0, hy: 0 };
        if (dx > e.hx) e.hx = dx;
        if (dy > e.hy) e.hy = dy;
        extentByPcbComp.set(pcbId, e);
    };
    const centerByPcbId = new Map<string, { x: number; y: number }>();
    const pcbIdBySrc = new Map<string, string>();
    for (const e of els) {
        if (e.type !== 'pcb_component') continue;
        const pid = str(e.pcb_component_id);
        const src = str(e.source_component_id);
        const cx = num(e.center && (e.center as Record<string, unknown>).x);
        const cy = num(e.center && (e.center as Record<string, unknown>).y);
        if (!pid || cx === null || cy === null) continue;
        if (src) pcbIdBySrc.set(src, pid);
        centerByPcbId.set(pid, { x: cx, y: cy });
        widen(pid, (num(e.width) ?? 0) / 2, (num(e.height) ?? 0) / 2);
    }
    for (const e of els) {
        const pid = str(e.pcb_component_id);
        if (!pid) continue;
        const c = centerByPcbId.get(pid);
        if (!c) continue;
        const t = e.type;
        const isPad = t === 'pcb_smtpad' || t === 'pcb_plated_hole';
        const isCourtyard = t.startsWith('pcb_courtyard');
        if (!isPad && !isCourtyard) continue;
        // courtyard outlines are point lists (the authoritative extent — measured 5 Tem 2026: pin
        // headers' courtyards are taller than body∪pads, which caused eval#2 overlap rejections)
        const outline = Array.isArray(e.outline) ? (e.outline as unknown[]) : null;
        if (outline) {
            for (const pt of outline) {
                const px = num((pt as Record<string, unknown>)?.x);
                const py = num((pt as Record<string, unknown>)?.y);
                if (px !== null && py !== null) widen(pid, Math.abs(px - c.x), Math.abs(py - c.y));
            }
            continue;
        }
        const x = num(e.x) ?? num(e.center && (e.center as Record<string, unknown>).x);
        const y = num(e.y) ?? num(e.center && (e.center as Record<string, unknown>).y);
        if (x === null || y === null) continue;
        const halfW = (num(e.width) ?? num(e.outer_diameter) ?? 1.2) / 2;
        const halfH = (num(e.height) ?? num(e.outer_diameter) ?? 1.2) / 2;
        widen(pid, Math.abs(x - c.x) + halfW, Math.abs(y - c.y) + halfH);
    }

    const roleById = new Map(layout.plans.map((p) => [p.component.id, p.role]));
    const parts: PlaceablePart[] = [];
    const missing: string[] = [];
    for (const [compId, name] of Object.entries(namesById)) {
        const srcId = srcCompIdByName.get(name);
        const pcbId = srcId ? pcbIdBySrc.get(srcId) : undefined;
        const center = pcbId ? centerByPcbId.get(pcbId) : undefined;
        const extent = pcbId ? extentByPcbComp.get(pcbId) : undefined;
        if (!srcId || !pcbId || !center || !extent || extent.hx === 0 || extent.hy === 0) {
            missing.push(name);
            continue;
        }
        const pads = (portsBySrcComp.get(srcId) ?? []).map((p) => ({ x: round3(p.x - center.x), y: round3(p.y - center.y), net: p.net }));
        parts.push({
            id: name,
            w: round3(extent.hx * 2),
            h: round3(extent.hy * 2),
            pads,
            role: roleById.get(compId) === 'connectorized' ? 'connector' : 'part',
        });
    }
    return { parts, missing };
}

/** Grid-baseline positions straight from the pass-1 soup (rotation 0), keyed by emitted name. */
export function gridPositions(
    evaluated: TscElement[],
    names: string[],
): Record<string, { x: number; y: number; rotation: Rotation }> {
    const els = evaluated as AnyEl[];
    const bySrcId = new Map<string, string>();
    for (const e of els) {
        if (e.type !== 'source_component') continue;
        const name = str(e.name);
        const id = str(e.source_component_id);
        if (name && id && names.includes(name)) bySrcId.set(id, name);
    }
    const out: Record<string, { x: number; y: number; rotation: Rotation }> = {};
    for (const e of els) {
        if (e.type !== 'pcb_component') continue;
        const name = bySrcId.get(str(e.source_component_id) ?? '');
        if (!name) continue;
        const cx = num(e.center && (e.center as Record<string, unknown>).x);
        const cy = num(e.center && (e.center as Record<string, unknown>).y);
        if (cx !== null && cy !== null) out[name] = { x: cx, y: cy, rotation: 0 };
    }
    return out;
}

/**
 * Net attraction weights (plan §4.2): GND ≈ 0 (routed by the pour), source-driven power rails low,
 * signals 1. Keyed by EMITTED net name.
 */
export function buildNetWeights(circuit: CircuitJson, netNameById: Record<string, string>): Record<string, number> {
    const weights: Record<string, number> = {};
    const powerNetIds = new Set<string>();
    for (const c of circuit.components) {
        if (c.type !== 'voltage_source' && c.type !== 'current_source') continue;
        for (const pin of c.pins) powerNetIds.add(pin.netId);
    }
    for (const net of circuit.nets) {
        const name = netNameById[net.id];
        if (!name) continue;
        if (net.isGround) weights[name] = 0.05;
        else if (powerNetIds.has(net.id)) weights[name] = 0.3;
        else weights[name] = 1;
    }
    return weights;
}

/**
 * Derived edges the netlist doesn't carry (plan §4.2): a decoupling cap (≤1µF between a power rail and
 * GND) has NO graph edge to any IC — both its nets are weight-suppressed. We synthesize the ownership
 * edge deterministically: each decap pairs with the highest-pin-count UNSERVED IC on the same rail
 * (ties: designator order; all served → round-robin). Timing/coupling caps sharing a signal net with
 * exactly one IC get a milder proximity edge. Same rule for every circuit — pattern, not hand labels.
 */
export function deriveExtraEdges(
    circuit: CircuitJson,
    namesById: Record<string, string>,
): Array<{ a: string; b: string; weight: number }> {
    const gndIds = new Set(circuit.nets.filter((n) => n.isGround).map((n) => n.id));
    const powerIds = new Set<string>();
    for (const c of circuit.components) {
        if (c.type !== 'voltage_source' && c.type !== 'current_source') continue;
        for (const pin of c.pins) if (!gndIds.has(pin.netId)) powerIds.add(pin.netId);
    }
    const ics = circuit.components
        .filter((c) => (c.type === 'generic' || c.type === 'subckt') && namesById[c.id])
        .sort((a, b) => b.pins.length - a.pins.length || a.designator.localeCompare(b.designator));

    const edges: Array<{ a: string; b: string; weight: number }> = [];
    const served = new Set<string>();
    const caps = circuit.components
        .filter((c) => c.type === 'capacitor' && namesById[c.id])
        .sort((a, b) => a.designator.localeCompare(b.designator));

    for (const cap of caps) {
        const netIds = cap.pins.map((p) => p.netId);
        const onPower = netIds.find((n) => powerIds.has(n));
        const onGnd = netIds.some((n) => gndIds.has(n));
        const parsed = cap.value !== undefined ? parseSpiceValue(cap.value) : null;
        const farads = parsed?.isValid ? parsed.value : NaN;

        if (onPower && onGnd && Number.isFinite(farads) && farads <= 1e-6) {
            // decap: pair with the highest-pin-count unserved IC on the same rail
            const railIcs = ics.filter((ic) => ic.pins.some((p) => p.netId === onPower));
            const target = railIcs.find((ic) => !served.has(ic.id)) ?? railIcs[0];
            if (target) {
                served.add(target.id);
                edges.push({ a: namesById[cap.id]!, b: namesById[target.id]!, weight: 4 });
            }
            continue;
        }
        // timing/coupling cap: signal net shared with exactly one IC → mild proximity edge
        const signalIds = netIds.filter((n) => !gndIds.has(n) && !powerIds.has(n));
        for (const netId of signalIds) {
            const touching = ics.filter((ic) => ic.pins.some((p) => p.netId === netId));
            if (touching.length === 1) {
                edges.push({ a: namesById[cap.id]!, b: namesById[touching[0]!.id]!, weight: 2 });
                break;
            }
        }
    }
    return edges;
}

function round3(n: number): number {
    const r = Math.round(n * 1000) / 1000;
    return Object.is(r, -0) ? 0 : r;
}
