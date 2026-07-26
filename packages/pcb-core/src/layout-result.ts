/**
 * LayoutJob contract shaper (LAYOUTJOB_PLAN.md §2, M1) — turns the raw evaluated tscircuit soup into
 * the clean, frontend-facing geometry the PCB editor consumes (components, pads, traces, vias, board,
 * layers). PURE + deterministic; no Docker, no fs. Field names verified against the real soup
 * (7 Tem 2026 dump), not assumed.
 *
 * DELIBERATELY NOT here (later slices, honestly):
 *   • airwires  — quality/freerouting traces LOSE per-connection routedness; derived from the KiCad
 *                 notary's unconnected_items via the widened seam (M1b), NOT from the soup.
 *   • pours     — no pour/zone element exists in the soup; the GND pour is injected as a bbox into the
 *                 .kicad_pcb and only FILLED at export. `poursFromKicadPcb` (M1b) reads that separately.
 *   • glbUrl / manufacturing — produced by the kicad-cli export step in the worker (M2/M3), not the soup.
 */
import type { TscElement } from './parity';

export interface Pt {
    x: number;
    y: number;
}

export interface LayoutComponent {
    /** OUR CircuitJson component id when resolvable (cross-probe back to the user's design), else the emitted name. */
    id: string;
    designator: string;
    x: number;
    y: number;
    /** degrees */
    rotation: number;
    /** tscircuit footprinter string (e.g. "soic8"), or null if no cad_component. */
    footprint: string | null;
    /** body box (NOT the courtyard extent — use `courtyard` for collision/drag). */
    bodyWmm: number;
    bodyHmm: number;
    /** 3D body height (mm) from cad_component.position.z, or null. */
    heightMm: number | null;
    /** courtyard polygon (normalized from pcb_courtyard_rect OR pcb_courtyard_outline). */
    courtyard: Pt[];
    layer: string;
}

export interface LayoutPad {
    id: string;
    componentId: string;
    /** best-available pin reference for schematic cross-probe (source_port name / hint), or null. */
    pin: string | null;
    /** emitted net name, or null for an unconnected / single-pin pad. */
    net: string | null;
    x: number;
    y: number;
    /** layers the pad sits on ("top" for SMD; ["top","bottom"] for a plated hole). */
    layers: string[];
    shape: string;
    wMm: number;
    hMm: number;
    /** through-hole drill (mm) for plated holes; null for SMD. */
    drillMm: number | null;
}

export interface LayoutTrace {
    id: string;
    /** emitted net name when the soup carries it (fast route / connection_name), else null (quality splice). */
    net: string | null;
    /** copper polylines split per layer (a trace can change layer via a via). */
    segments: Array<{ layer: string; widthMm: number; points: Pt[] }>;
}

export interface LayoutVia {
    id: string;
    x: number;
    y: number;
    drillMm: number;
    outerMm: number;
    fromLayer: string;
    toLayer: string;
    net: string | null;
}

export interface LayoutGeometry {
    board: { widthMm: number; heightMm: number; outline: Pt[] };
    layers: Array<{ name: string }>;
    components: LayoutComponent[];
    pads: LayoutPad[];
    traces: LayoutTrace[];
    vias: LayoutVia[];
}

export interface ShapeOptions {
    /** OUR componentId -> emitted (sanitized) name, from AdapterResult. Enables cross-probe to the design. */
    namesById?: Record<string, string>;
}

// ---------------------------------------------------------------- helpers

type El = TscElement & Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const r3 = (n: number): number => {
    const x = Math.round(n * 1000) / 1000;
    return Object.is(x, -0) ? 0 : x;
};
const pt = (o: unknown): Pt | null => {
    const x = num((o as Record<string, unknown>)?.x);
    const y = num((o as Record<string, unknown>)?.y);
    return x === null || y === null ? null : { x: r3(x), y: r3(y) };
};

/** Collapse consecutive duplicate points (tscircuit courtyard outlines repeat vertices). */
function dedupe(points: Pt[]): Pt[] {
    const out: Pt[] = [];
    for (const p of points) {
        const last = out[out.length - 1];
        if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
    }
    return out;
}

// ---------------------------------------------------------------- shaper

export function shapeLayoutResult(evaluated: TscElement[], opts: ShapeOptions = {}): LayoutGeometry {
    const els = evaluated as El[];
    const of = (t: string) => els.filter((e) => e.type === t);

    // reverse map emitted-name -> OUR id (namesById is ourId -> emittedName, uniquified 1:1)
    const ourIdByName = new Map<string, string>();
    for (const [ourId, name] of Object.entries(opts.namesById ?? {})) ourIdByName.set(name, ourId);

    // source_component_id -> designator(name); cad by pcb_component_id -> {footprint, z}
    const designatorBySrcComp = new Map<string, string>();
    for (const e of of('source_component')) {
        const id = str(e.source_component_id);
        const name = str(e.name);
        if (id && name) designatorBySrcComp.set(id, name);
    }
    const cadByPcbComp = new Map<string, { footprint: string | null; z: number | null }>();
    for (const e of of('cad_component')) {
        const pid = str(e.pcb_component_id);
        if (!pid) continue;
        cadByPcbComp.set(pid, {
            footprint: str(e.footprinter_string),
            z: num((e.position as Record<string, unknown>)?.z),
        });
    }

    // net name resolution: source_net_id -> name, and pcb_port_id -> net name (via source_trace membership)
    const netNameBySrcNet = new Map<string, string>();
    for (const e of of('source_net')) {
        const id = str(e.source_net_id);
        const name = str(e.name);
        if (id && name) netNameBySrcNet.set(id, name);
    }
    const srcPortIdByPcbPort = new Map<string, string>();
    for (const e of of('pcb_port')) {
        const pp = str(e.pcb_port_id);
        const sp = str(e.source_port_id);
        if (pp && sp) srcPortIdByPcbPort.set(pp, sp);
    }
    const netBySrcPort = new Map<string, string>();
    for (const e of of('source_trace')) {
        const ports = Array.isArray(e.connected_source_port_ids) ? (e.connected_source_port_ids as unknown[]) : [];
        const nets = Array.isArray(e.connected_source_net_ids) ? (e.connected_source_net_ids as unknown[]) : [];
        const netName = nets.length ? netNameBySrcNet.get(String(nets[0])) : undefined;
        if (!netName) continue;
        for (const p of ports) if (typeof p === 'string') netBySrcPort.set(p, netName);
    }
    // pin reference (source_port name/hint) for cross-probe
    const pinBySrcPort = new Map<string, string>();
    for (const e of of('source_port')) {
        const sp = str(e.source_port_id);
        if (!sp) continue;
        const hints = Array.isArray(e.port_hints)
            ? (e.port_hints as unknown[]).filter((h) => typeof h === 'string')
            : [];
        pinBySrcPort.set(sp, str(e.name) ?? (hints[hints.length - 1] as string) ?? sp);
    }
    const netByPcbPort = (pcbPortId: string | null): string | null => {
        if (!pcbPortId) return null;
        const sp = srcPortIdByPcbPort.get(pcbPortId);
        return sp ? (netBySrcPort.get(sp) ?? null) : null;
    };
    const pinByPcbPort = (pcbPortId: string | null): string | null => {
        if (!pcbPortId) return null;
        const sp = srcPortIdByPcbPort.get(pcbPortId);
        return sp ? (pinBySrcPort.get(sp) ?? null) : null;
    };

    // component id + designator resolver keyed by pcb_component_id
    const compRefByPcbComp = new Map<string, { id: string; designator: string }>();
    for (const e of of('pcb_component')) {
        const pid = str(e.pcb_component_id);
        const src = str(e.source_component_id);
        if (!pid) continue;
        const designator = (src && designatorBySrcComp.get(src)) || pid;
        compRefByPcbComp.set(pid, { id: ourIdByName.get(designator) ?? designator, designator });
    }

    // courtyard polygons per pcb_component (rect → 4 corners; outline → deduped points)
    const courtyardByPcbComp = new Map<string, Pt[]>();
    for (const e of of('pcb_courtyard_rect')) {
        const pid = str(e.pcb_component_id);
        const c = pt(e.center);
        const w = num(e.width);
        const h = num(e.height);
        if (!pid || !c || w === null || h === null) continue;
        courtyardByPcbComp.set(pid, [
            { x: r3(c.x - w / 2), y: r3(c.y - h / 2) },
            { x: r3(c.x + w / 2), y: r3(c.y - h / 2) },
            { x: r3(c.x + w / 2), y: r3(c.y + h / 2) },
            { x: r3(c.x - w / 2), y: r3(c.y + h / 2) },
        ]);
    }
    for (const e of of('pcb_courtyard_outline')) {
        const pid = str(e.pcb_component_id);
        const outline = Array.isArray(e.outline) ? (e.outline as unknown[]).map(pt).filter((p): p is Pt => !!p) : [];
        if (pid && outline.length && !courtyardByPcbComp.has(pid)) courtyardByPcbComp.set(pid, dedupe(outline));
    }

    // ---- board (rect boards carry NO outline → synthesize the rectangle from center ± size/2)
    const boardEl = of('pcb_board')[0];
    const bw = (boardEl && num(boardEl.width)) ?? 0;
    const bh = (boardEl && num(boardEl.height)) ?? 0;
    const bc = (boardEl && pt(boardEl.center)) ?? { x: 0, y: 0 };
    const explicitOutline =
        boardEl && Array.isArray(boardEl.outline)
            ? (boardEl.outline as unknown[]).map(pt).filter((p): p is Pt => !!p)
            : [];
    const outline = explicitOutline.length
        ? dedupe(explicitOutline)
        : [
              { x: r3(bc.x - bw / 2), y: r3(bc.y - bh / 2) },
              { x: r3(bc.x + bw / 2), y: r3(bc.y - bh / 2) },
              { x: r3(bc.x + bw / 2), y: r3(bc.y + bh / 2) },
              { x: r3(bc.x - bw / 2), y: r3(bc.y + bh / 2) },
          ];
    const numLayers = (boardEl && num(boardEl.num_layers)) ?? 2;
    const layers = numLayers >= 2 ? [{ name: 'top' }, { name: 'bottom' }] : [{ name: 'top' }];

    // ---- components
    const components: LayoutComponent[] = of('pcb_component').map((e) => {
        const pid = str(e.pcb_component_id)!;
        const ref = compRefByPcbComp.get(pid) ?? { id: pid, designator: pid };
        const c = pt(e.center) ?? { x: 0, y: 0 };
        const cad = cadByPcbComp.get(pid);
        return {
            id: ref.id,
            designator: ref.designator,
            x: c.x,
            y: c.y,
            rotation: num(e.rotation) ?? 0,
            footprint: cad?.footprint ?? null,
            bodyWmm: r3(num(e.width) ?? 0),
            bodyHmm: r3(num(e.height) ?? 0),
            heightMm: cad?.z != null ? r3(cad.z) : null,
            courtyard: courtyardByPcbComp.get(pid) ?? [],
            layer: str(e.layer) ?? 'top',
        };
    });

    // ---- pads: SMD (pcb_smtpad) + THT (pcb_plated_hole)
    const pads: LayoutPad[] = [];
    for (const e of of('pcb_smtpad')) {
        const pcbPort = str(e.pcb_port_id);
        const comp = compRefByPcbComp.get(str(e.pcb_component_id) ?? '');
        pads.push({
            id: str(e.pcb_smtpad_id) ?? `smt_${pads.length}`,
            componentId: comp?.id ?? str(e.pcb_component_id) ?? '',
            pin: pinByPcbPort(pcbPort),
            net: netByPcbPort(pcbPort),
            x: r3(num(e.x) ?? 0),
            y: r3(num(e.y) ?? 0),
            layers: [str(e.layer) ?? 'top'],
            shape: str(e.shape) ?? 'rect',
            wMm: r3(num(e.width) ?? 0),
            hMm: r3(num(e.height) ?? 0),
            drillMm: null,
        });
    }
    for (const e of of('pcb_plated_hole')) {
        const pcbPort = str(e.pcb_port_id);
        const comp = compRefByPcbComp.get(str(e.pcb_component_id) ?? '');
        const layersArr = Array.isArray(e.layers)
            ? (e.layers as unknown[]).filter((l): l is string => typeof l === 'string')
            : ['top', 'bottom'];
        pads.push({
            id: str(e.pcb_plated_hole_id) ?? `pth_${pads.length}`,
            componentId: comp?.id ?? str(e.pcb_component_id) ?? '',
            pin: pinByPcbPort(pcbPort),
            net: netByPcbPort(pcbPort),
            x: r3(num(e.x) ?? 0),
            y: r3(num(e.y) ?? 0),
            layers: layersArr,
            shape: str(e.shape) ?? 'circular_hole_with_rect_pad',
            wMm: r3(num(e.rect_pad_width) ?? num(e.outer_diameter) ?? num(e.hole_diameter) ?? 0),
            hMm: r3(num(e.rect_pad_height) ?? num(e.outer_diameter) ?? num(e.hole_diameter) ?? 0),
            drillMm: r3(num(e.hole_diameter) ?? 0),
        });
    }

    // ---- traces: split the route into per-layer polylines (a trace can change layer through a via)
    const traces: LayoutTrace[] = of('pcb_trace').map((e) => {
        const connSrcNet = str(e.connection_name); // present on the fast route; absent after freerouting splice
        const net = connSrcNet ? (netNameBySrcNet.get(connSrcNet) ?? null) : null;
        const route = Array.isArray(e.route) ? (e.route as Array<Record<string, unknown>>) : [];
        const segments: LayoutTrace['segments'] = [];
        let cur: LayoutTrace['segments'][number] | null = null;
        for (const p of route) {
            if (str(p.route_type) === 'via') {
                cur = null;
                continue;
            } // layer transition — break the polyline
            const x = num(p.x);
            const y = num(p.y);
            if (x === null || y === null) continue;
            const layer = str(p.layer) ?? 'top';
            const width = r3(num(p.width) ?? 0);
            if (!cur || cur.layer !== layer) {
                cur = { layer, widthMm: width, points: [] };
                segments.push(cur);
            }
            cur.points.push({ x: r3(x), y: r3(y) });
        }
        return {
            id: str(e.pcb_trace_id) ?? `trace_${traces.length}`,
            net,
            segments: segments.filter((s) => s.points.length > 1),
        };
    });

    // ---- vias
    const netByTraceId = new Map<string, string | null>();
    for (const t of of('pcb_trace')) {
        const id = str(t.pcb_trace_id);
        const cn = str(t.connection_name);
        if (id) netByTraceId.set(id, cn ? (netNameBySrcNet.get(cn) ?? null) : null);
    }
    const vias: LayoutVia[] = of('pcb_via').map((e, i) => ({
        id: str(e.pcb_via_id) ?? `via_${i}`,
        x: r3(num(e.x) ?? 0),
        y: r3(num(e.y) ?? 0),
        drillMm: r3(num(e.hole_diameter) ?? 0),
        outerMm: r3(num(e.outer_diameter) ?? 0),
        fromLayer: str(e.from_layer) ?? 'top',
        toLayer: str(e.to_layer) ?? 'bottom',
        net: netByTraceId.get(str(e.pcb_trace_id) ?? '') ?? null,
    }));

    return {
        board: { widthMm: r3(bw), heightMm: r3(bh), outline },
        layers,
        components,
        pads,
        traces,
        vias,
    };
}
