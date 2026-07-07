import { shapeLayoutResult } from './layout-result';
import type { TscElement } from './parity';

/**
 * Compact hand-crafted soup exercising EVERY M1 edge case (field names from the real 7 Tem 2026 dump):
 *  - rect board with NO outline (must synthesize)          - THT plated-hole pad (drill) + SMD pad (no drill)
 *  - component WITH cad_component (footprint+height) and one WITHOUT (null/null)
 *  - courtyard as rect (U1) AND as outline w/ dup vertex (J1)
 *  - connected pad (net) + unconnected pad (net null)      - trace w/ connection_name + layer-change via (split)
 *  - trace WITHOUT connection_name (quality splice → net null)   - via net via its trace
 *  - component id = OUR CircuitJson id via namesById
 */
const soup = [
    { type: 'pcb_board', pcb_board_id: 'b0', center: { x: 0, y: 0 }, width: 20, height: 16, num_layers: 2 },

    { type: 'source_component', source_component_id: 'sc_u1', name: 'U1' },
    { type: 'pcb_component', pcb_component_id: 'pc_u1', source_component_id: 'sc_u1', center: { x: -3, y: 0 }, width: 4, height: 5, rotation: 90, layer: 'top' },
    { type: 'cad_component', cad_component_id: 'cad_u1', pcb_component_id: 'pc_u1', source_component_id: 'sc_u1', footprinter_string: 'soic8', position: { x: -3, y: 0, z: 0.9 } },
    { type: 'pcb_courtyard_rect', pcb_courtyard_rect_id: 'cy_u1', pcb_component_id: 'pc_u1', center: { x: -3, y: 0 }, width: 6, height: 7 },
    { type: 'source_port', source_port_id: 'sp_u1_1', name: 'pin1', port_hints: ['pin1', '1'], source_component_id: 'sc_u1' },
    { type: 'pcb_port', pcb_port_id: 'pp_u1_1', source_port_id: 'sp_u1_1', pcb_component_id: 'pc_u1', x: -4, y: 0 },
    { type: 'pcb_smtpad', pcb_smtpad_id: 'pad_u1_1', pcb_component_id: 'pc_u1', pcb_port_id: 'pp_u1_1', layer: 'top', shape: 'rect', width: 1, height: 0.6, x: -4, y: 0 },
    { type: 'source_port', source_port_id: 'sp_u1_2', name: 'pin2', port_hints: ['pin2', '2'], source_component_id: 'sc_u1' },
    { type: 'pcb_port', pcb_port_id: 'pp_u1_2', source_port_id: 'sp_u1_2', pcb_component_id: 'pc_u1', x: -2, y: 0 },
    { type: 'pcb_smtpad', pcb_smtpad_id: 'pad_u1_2', pcb_component_id: 'pc_u1', pcb_port_id: 'pp_u1_2', layer: 'top', shape: 'rect', width: 1, height: 0.6, x: -2, y: 0 },

    { type: 'source_component', source_component_id: 'sc_j1', name: 'J1' },
    { type: 'pcb_component', pcb_component_id: 'pc_j1', source_component_id: 'sc_j1', center: { x: 5, y: 0 }, width: 2.5, height: 5, rotation: 0, layer: 'top' },
    { type: 'pcb_courtyard_outline', pcb_courtyard_outline_id: 'cy_j1', pcb_component_id: 'pc_j1', outline: [{ x: 4, y: -2 }, { x: 4, y: -2 }, { x: 6, y: -2 }, { x: 6, y: 2 }, { x: 4, y: 2 }] },
    { type: 'source_port', source_port_id: 'sp_j1_1', name: 'pin1', port_hints: ['pin1', '1'], source_component_id: 'sc_j1' },
    { type: 'pcb_port', pcb_port_id: 'pp_j1_1', source_port_id: 'sp_j1_1', pcb_component_id: 'pc_j1', x: 5, y: -1.27 },
    { type: 'pcb_plated_hole', pcb_plated_hole_id: 'pth_j1_1', pcb_component_id: 'pc_j1', pcb_port_id: 'pp_j1_1', hole_diameter: 1, rect_pad_width: 1.5, rect_pad_height: 1.5, shape: 'circular_hole_with_rect_pad', x: 5, y: -1.27, layers: ['top', 'bottom'] },

    { type: 'source_net', source_net_id: 'sn_vin', name: 'VIN', is_ground: false },
    { type: 'source_trace', source_trace_id: 'st0', connected_source_port_ids: ['sp_u1_1', 'sp_j1_1'], connected_source_net_ids: ['sn_vin'] },
    { type: 'pcb_trace', pcb_trace_id: 'pt0', connection_name: 'sn_vin', route: [
        { route_type: 'wire', x: -4, y: 0, width: 0.2, layer: 'top' },
        { route_type: 'wire', x: 0, y: 0, width: 0.2, layer: 'top' },
        { route_type: 'via', x: 0, y: 0 },
        { route_type: 'wire', x: 0, y: 0, width: 0.2, layer: 'bottom' },
        { route_type: 'wire', x: 5, y: -1.27, width: 0.2, layer: 'bottom' },
    ] },
    { type: 'pcb_trace', pcb_trace_id: 'pt1', route: [
        { route_type: 'wire', x: 1, y: 1, width: 0.2, layer: 'top' },
        { route_type: 'wire', x: 2, y: 2, width: 0.2, layer: 'top' },
    ] },
    { type: 'pcb_via', pcb_via_id: 'v0', pcb_trace_id: 'pt0', x: 0, y: 0, hole_diameter: 0.2, outer_diameter: 0.3, from_layer: 'top', to_layer: 'bottom', layers: ['top', 'bottom'] },
] as unknown as TscElement[];

const NAMES = { u1: 'U1', j1: 'J1' };

describe('shapeLayoutResult — LayoutJob M1 contract shaper', () => {
    const g = shapeLayoutResult(soup, { namesById: NAMES });

    it('synthesizes a rectangle outline for a rect board with none, and lists 2 layers', () => {
        expect(g.board).toMatchObject({ widthMm: 20, heightMm: 16 });
        expect(g.board.outline).toEqual([
            { x: -10, y: -8 }, { x: 10, y: -8 }, { x: 10, y: 8 }, { x: -10, y: 8 },
        ]);
        expect(g.layers).toEqual([{ name: 'top' }, { name: 'bottom' }]);
    });

    it('maps component id to OUR CircuitJson id, resolves footprint+height from cad_component, null when absent', () => {
        const u1 = g.components.find((c) => c.designator === 'U1')!;
        const j1 = g.components.find((c) => c.designator === 'J1')!;
        expect(u1.id).toBe('u1'); // via namesById (cross-probe back to design)
        expect(u1).toMatchObject({ footprint: 'soic8', heightMm: 0.9, bodyWmm: 4, bodyHmm: 5, rotation: 90 });
        expect(j1).toMatchObject({ id: 'j1', footprint: null, heightMm: null }); // no cad_component
    });

    it('normalizes courtyard from BOTH rect and outline (deduping repeated vertices)', () => {
        const u1 = g.components.find((c) => c.designator === 'U1')!;
        const j1 = g.components.find((c) => c.designator === 'J1')!;
        expect(u1.courtyard).toEqual([{ x: -6, y: -3.5 }, { x: 0, y: -3.5 }, { x: 0, y: 3.5 }, { x: -6, y: 3.5 }]); // rect→4 corners
        expect(j1.courtyard).toEqual([{ x: 4, y: -2 }, { x: 6, y: -2 }, { x: 6, y: 2 }, { x: 4, y: 2 }]); // outline dup removed
    });

    it('resolves pad net for connected pads, null for unconnected; THT carries drill, SMD does not', () => {
        const p1 = g.pads.find((p) => p.id === 'pad_u1_1')!;
        const p2 = g.pads.find((p) => p.id === 'pad_u1_2')!;
        const pth = g.pads.find((p) => p.id === 'pth_j1_1')!;
        expect(p1).toMatchObject({ net: 'VIN', pin: 'pin1', drillMm: null, componentId: 'u1' });
        expect(p2.net).toBeNull(); // unconnected pin
        expect(pth).toMatchObject({ net: 'VIN', drillMm: 1, layers: ['top', 'bottom'], componentId: 'j1' });
    });

    it('splits a trace into per-layer segments at a layer-change via; resolves net from connection_name', () => {
        const t = g.traces.find((x) => x.id === 'pt0')!;
        expect(t.net).toBe('VIN');
        expect(t.segments).toEqual([
            { layer: 'top', widthMm: 0.2, points: [{ x: -4, y: 0 }, { x: 0, y: 0 }] },
            { layer: 'bottom', widthMm: 0.2, points: [{ x: 0, y: 0 }, { x: 5, y: -1.27 }] },
        ]);
    });

    it('leaves trace net null when the soup carries no connection_name (freerouting splice)', () => {
        const t = g.traces.find((x) => x.id === 'pt1')!;
        expect(t.net).toBeNull();
        expect(t.segments).toHaveLength(1);
    });

    it('shapes vias with layers, geometry, and net inherited from the trace', () => {
        expect(g.vias).toEqual([
            { id: 'v0', x: 0, y: 0, drillMm: 0.2, outerMm: 0.3, fromLayer: 'top', toLayer: 'bottom', net: 'VIN' },
        ]);
    });

    it('handles an empty board gracefully (no crash, empty collections)', () => {
        const empty = shapeLayoutResult([] as unknown as TscElement[]);
        expect(empty.components).toEqual([]);
        expect(empty.pads).toEqual([]);
        expect(empty.traces).toEqual([]);
        expect(empty.vias).toEqual([]);
        expect(empty.board.outline).toHaveLength(4); // degenerate 0×0 rectangle, still valid
    });

    it('falls back to the emitted designator as id when namesById is absent', () => {
        const g2 = shapeLayoutResult(soup);
        expect(g2.components.find((c) => c.designator === 'U1')!.id).toBe('U1');
    });
});
