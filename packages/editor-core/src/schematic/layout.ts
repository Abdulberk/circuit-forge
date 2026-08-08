/**
 * Where each part sits on the sheet, and how big the sheet is.
 *
 * IT LIVES IN THE KERNEL because more than one thing needs the answer and they must not each have their own.
 * The canvas draws from it; the router's obstacles and terminals come from it; a test that pins the routed
 * result has to be looking at the sheet the product actually draws. When the canvas owned this and a test
 * re-implemented it, the two used different margins and different cell padding, so every part in the test
 * sat one full grid step from where the product put it — the file called itself "the canvas's own fallback
 * layout, reproduced" and was pinning a sheet nobody would ever see.
 *
 * A stored position always wins. The grid below is what a design gets when nobody has arranged it, which is
 * the ordinary case for a circuit a machine wrote, and it is deterministic by construction: no clock, no
 * randomness, no dependence on render order.
 */

import type { CircuitJson, Position } from '@circuit-forge/eda-core';

import { isDrawnOnSheet, isPlaceablePart } from '../tree/object-tree';

import { arrangeBySignalFlow } from './arrange';
import { orientSymbol } from './orient';
import type { Box, RouteNet, RoutePin } from './route';
import { PIN_GRID, symbolFor, type SymbolGeometry } from './symbols';

/**
 * How much clear sheet to leave between one part and the next.
 *
 * MEASURED IN LANES, because that is what the gap is for. Wires run between rows of parts, and a gap of n
 * grid steps holds n wires side by side; a gap that holds one holds the first net to ask and sends every
 * other one round the houses. Eight lanes is not a tuning constant so much as a statement about what a row
 * of parts needs — and it was arrived at by measurement, not taste: at four lanes a bridge rectifier had
 * three of its ten wires with no legible route at all, and at eight it has none.
 */
const LANES = 8;
const GAP = LANES * PIN_GRID;
/** The same clear space at the edges, so a wire can always leave a part on the outside of the sheet. */
const MARGIN = GAP / 2;

const snapToGrid = (v: number): number => Math.round(v / PIN_GRID) * PIN_GRID;

export interface PlacedPart {
    id: string;
    designator: string;
    x: number;
    y: number;
    symbol: SymbolGeometry;
    /**
     * For a net marker placed against a terminal: which terminal, as `componentId.pinId`.
     *
     * Recorded where the claim is MADE so nothing has to work it out again. `groundGlyphs` skips these pins,
     * and without that it drew a second ground symbol on top of the author's own — the two interpenetrating,
     * the marker's terminal landing on the middle of the glyph's widest bar, and the marker joined to nothing
     * because a ground net is no longer wired. Reproducible on this product's own divider after one drag.
     */
    annotates?: string;
}

/**
 * Every part, placed and turned.
 *
 * TURNED as well as placed. `Position` has carried `rotation` and `mirror` since it was written and for a
 * long time nothing applied them: the same diode rendered with `rotation:'90'` produced SVG byte-identical
 * to the upright one. That was not a missing feature but a disagreement — `pcb-core`'s adapter DOES read the
 * field and emits `pcbRotation={90}`, so the sheet and the board described the same design differently with
 * nothing comparing the two.
 *
 * `orientSymbol` returns the SAME object for an upright, unmirrored part, so the overwhelmingly common case
 * — every design a machine wrote — costs one comparison rather than a rebuilt symbol.
 *
 * EVERY CENTRE IS SNAPPED, and that is where the pin lattice actually has to hold. `symbolFor` guarantees
 * every pin sits on the lattice in the symbol's OWN frame; placing that symbol at an off-grid origin
 * destroys the guarantee in the frame wires are drawn in. Centres used to land at 68, 156 and 244, so pins
 * occupied three different residues mod 10 and no lattice contained them — two parts side by side had pins
 * at heights no straight line could join, which is the one thing a grid exists to make possible. It also
 * made a part jump the first time it was dragged, since the drop snaps and the fallback did not.
 */
export function placeParts(circuit: CircuitJson, positions?: Record<string, Position>): PlacedPart[] {
    const parts = (circuit.components ?? []).filter((c) => isDrawnOnSheet(c));
    const symbols = parts.map((c) => orientSymbol(symbolFor(c), positions?.[c.id]));
    const cellW = Math.max(GAP, ...symbols.map((s) => s.width)) + GAP;
    const cellH = Math.max(GAP, ...symbols.map((s) => s.height)) + GAP;
    // WHERE, decided by what is CONNECTED TO WHAT rather than by array order. A square grid filled by index
    // put two parts of one net at opposite corners of the sheet — measured at 640 units apart on an
    // eight-part ladder — and the router then drew the honest long way round. The wires on a sheet can only
    // be as short as the placement allows, and this is the placement.
    //
    // Markers do not take a slot: they are placed against the terminal they annotate, so counting them would
    // spread the real parts out around gaps nothing occupies.
    const slots = arrangeBySignalFlow(circuit);
    const placed = parts.map((c, i) => {
        const slot = slots.get(c.id);
        return {
            id: c.id,
            designator: c.designator,
            x: snapToGrid(positions?.[c.id]?.x ?? MARGIN + (slot?.column ?? 0) * cellW + cellW / 2),
            y: snapToGrid(positions?.[c.id]?.y ?? MARGIN + (slot?.row ?? 0) * cellH + cellH / 2),
            symbol: symbols[i]!,
        };
    });

    return attachMarkers(circuit, placed, positions);
}

/**
 * A net marker belongs BESIDE THE TERMINAL IT ANNOTATES, not in a cell of the grid.
 *
 * That is the whole point of the symbol: a ground mark next to a pin says "this pin is the reference" in the
 * space of one wire, which is why schematics use it instead of running a wire to every ground pin. Drawn at
 * whatever cell its position in the components array happened to land on, it becomes one more distant spoke
 * of the same star — MEASURED on the product's own four regression circuits, the ground net got longer on
 * all four. Against the terminal it is shorter on all four: 470→350, 1520→1430, 1280→1160, 7390→6840.
 *
 * IT IS STILL LONGER THAN NOT DRAWING THE MARKER AT ALL (180, 1070, 910, 6300), and that is not a defect to
 * fix but the truth about what a marker is: an extra terminal on the net, and a wire to reach it. The saving
 * a schematic actually gets comes from giving EVERY ground pin its own marker, which is a question about
 * what the design contains rather than about where this function puts things.
 *
 * The lowest terminal wins, because down is where a reader looks for ground, and each marker takes a
 * different one so that several markers annotate several pins rather than crowding one.
 */
function attachMarkers(circuit: CircuitJson, placed: PlacedPart[], positions?: Record<string, Position>): PlacedPart[] {
    const byId = new Map((circuit.components ?? []).map((c) => [c.id, c]));
    const markers = placed.filter((p) => !isPlaceablePart(byId.get(p.id) ?? { type: 'resistor' }));
    if (markers.length === 0) return placed;

    const taken = new Set<string>();
    const moved = new Map<string, Partial<PlacedPart>>();
    for (const marker of markers) {
        if (positions?.[marker.id]) continue; // somebody arranged it; that always wins
        const net = byId.get(marker.id)?.pins[0]?.netId;
        const at = placed
            .filter((p) => isPlaceablePart(byId.get(p.id) ?? { type: 'ground' }))
            .flatMap((p) =>
                (byId.get(p.id)?.pins ?? [])
                    .filter((pin) => pin.netId === net)
                    .flatMap((pin) => {
                        const sp = p.symbol.pins.find((q) => q.pinId === pin.pinId);
                        return sp ? [{ key: `${p.id}.${pin.pinId}`, x: p.x + sp.x, y: p.y + sp.y, side: sp.side }] : [];
                    }),
            )
            .filter((t) => !taken.has(t.key))
            // Lowest first, then leftmost, then by name — a total order, so the same document always draws
            // the same sheet however the parts arrived.
            .sort((u, v) => v.y - u.y || u.x - v.x || u.key.localeCompare(v.key))[0];
        if (!at) continue;
        taken.add(at.key);
        // ITS OWN TERMINAL ON THE PIN, exactly like the glyphs — because it IS one. It used to be parked a
        // fixed drop below the pin, which assumed a wire would be drawn from one to the other; once ground
        // stopped being wired, that assumption left the author's symbol dangling twenty units from a pin
        // that had grown a second ground symbol of its own, the two drawn through each other.
        const symbol = orientSymbol(symbolFor(GROUND_SYMBOL), { rotation: GLYPH_TURN[at.side] });
        const own = symbol.pins[0];
        if (!own) continue;
        moved.set(marker.id, { x: at.x - own.x, y: at.y - own.y, symbol, annotates: at.key });
    }
    return placed.map((p) => ({ ...p, ...(moved.get(p.id) ?? {}) }));
}

/**
 * The symbols as obstacles: what a wire may not be drawn through.
 *
 * FROM THE SYMBOL'S OWN BOUNDS, not from its extent about its centre. Those are the same thing for every
 * symbol that happens to be centred on its origin, which was all of them until ground arrived: its bars run
 * y=0…6 and its terminal sits at y=-10, so `centre ± height/2` missed the top two units of the drawing —
 * including the strip the terminal itself occupies — and declared two units of blank sheet solid below it.
 */
export const bodiesOf = (placed: readonly PlacedPart[]): Box[] =>
    placed.map((p) => ({
        minX: p.x + p.symbol.bounds.minX,
        minY: p.y + p.symbol.bounds.minY,
        maxX: p.x + p.symbol.bounds.maxX,
        maxY: p.y + p.symbol.bounds.maxY,
    }));

/**
 * The nets as the router wants them: terminals in sheet coordinates, with the side each wire leaves on.
 *
 * A net with fewer than two placed terminals is left out, and that is the correct depiction of it: a single
 * unconnected terminal is drawn as the bare pin it is, and ERC reports it in exactly those words.
 */
export function netsOf(circuit: CircuitJson, placed: readonly PlacedPart[]): RouteNet[] {
    const byId = new Map((circuit.components ?? []).map((c) => [c.id, c]));
    const out: RouteNet[] = [];
    for (const net of circuit.nets ?? []) {
        const pins: RoutePin[] = [];
        for (const p of placed)
            for (const pin of byId.get(p.id)?.pins ?? []) {
                if (pin.netId !== net.id) continue;
                const sp = p.symbol.pins.find((q) => q.pinId === pin.pinId);
                if (sp) pins.push({ x: p.x + sp.x, y: p.y + sp.y, side: sp.side, label: `${p.id}.${pin.pinId}` });
            }
        // THE REFERENCE IS NOT WIRED, IT IS MARKED. Every schematic in the world draws a ground symbol at
        // each pin that reaches the reference rather than running a wire from one to the next, for a reason
        // the measurements here make plain: ground was between a third and a HALF of every wire on the sheet
        // (38%, 46%, 35%, 53% of total length on the four regression circuits), and all of it crossing
        // everything else. A reader does not follow those wires; they read the symbol and know.
        //
        // So a ground net is left out of the routing entirely and `groundGlyphs` draws it instead. The
        // netlist is unchanged and still says what is connected — this is about how the drawing SPELLS it.
        // A SUPPLY RAIL IS THE SAME ARGUMENT, and now there is something to make it about: nothing had ever
        // written `isPower` — the model was never told the field existed — so a rail could not be drawn as a
        // rail. It is marked now, and a rail is the second-largest net in most designs after the reference.
        //
        // The difference is that a rail needs its NAME. Every ground symbol means the same node and can go
        // unlabelled; VCC and +3V3 are different nodes drawn with the same mark, so a reader who cannot see
        // which is which is worse off than with a wire.
        if (net.isGround || net.isPower) continue;
        if (pins.length >= 2) out.push({ id: net.id, name: net.name, pins });
    }
    return out;
}

/**
 * A ground symbol on every terminal that reaches the reference.
 *
 * PLACED SO ITS OWN TERMINAL COINCIDES WITH THE PIN, which is why no wire is needed: the symbol attaches to
 * the pin the way it does on paper. It is turned so it hangs AWAY from the part — a pin that leaves downward
 * gets a symbol below it, one that leaves left gets a symbol to its left — so the bars never sit on the body.
 *
 * A design that already carries ground COMPONENTS keeps them: those are the author's own marks, they are in
 * the netlist and the tree, and they can be selected and moved. Their pins are skipped here so a marker does
 * not get a second symbol drawn on top of it.
 */
export function groundGlyphs(circuit: CircuitJson, placed: readonly PlacedPart[]): PlacedPart[] {
    const byId = new Map((circuit.components ?? []).map((c) => [c.id, c]));
    const ground = new Set((circuit.nets ?? []).filter((n) => n.isGround).map((n) => n.id));
    if (ground.size === 0) return [];

    const claimed = new Set(placed.flatMap((p) => (p.annotates ? [p.annotates] : [])));
    const glyphs: PlacedPart[] = [];
    for (const part of placed) {
        const component = byId.get(part.id);
        if (!component || !isPlaceablePart(component)) continue; // a marker already IS the symbol
        for (const pin of component.pins) {
            if (!ground.has(pin.netId)) continue;
            // A pin the author's own marker is attached to already HAS its symbol. Drawing another would put
            // two ground marks on one terminal, which is what happened before the marker was made to sit on
            // the pin rather than below it.
            if (claimed.has(`${part.id}.${pin.pinId}`)) continue;
            const sp = part.symbol.pins.find((q) => q.pinId === pin.pinId);
            if (!sp) continue;
            // Turned so the symbol's own terminal points back at the pin it is attached to.
            const symbol = orientSymbol(symbolFor(GROUND_SYMBOL), { rotation: GLYPH_TURN[sp.side] });
            const own = symbol.pins[0];
            if (!own) continue;
            glyphs.push({
                id: `${part.id}.${pin.pinId}#gnd`,
                designator: '',
                x: part.x + sp.x - own.x,
                y: part.y + sp.y - own.y,
                symbol,
                // The terminal this symbol IS the mark for. A renderer needs it to keep the symbol with the
                // part while it is being dragged, and it is the same field the author's own markers carry.
                annotates: `${part.id}.${pin.pinId}`,
            });
        }
    }
    return glyphs;
}

/**
 * Which way to turn the symbol so it hangs away from the part.
 *
 * Its terminal points UP when upright — the bars are below it — so a pin that leaves downward needs no turn
 * at all, and the others follow from that one fact rather than from four separate decisions.
 */
/**
 * The component a ground glyph is drawn from.
 *
 * ONE PIN, and it has to be there. `symbolFor` compares the drawn shape's pin count against the component's
 * own and derives a plain labelled box when they disagree — which is the right rule (a "resistor" with four
 * pins is not the two-terminal part that shape describes) and it means a component with NO pins gets a box
 * with no terminal. Asking for a ground symbol without giving it a terminal returned exactly that: an empty
 * box, no pin, and every glyph silently skipped.
 */
const GROUND_SYMBOL = { type: 'ground', pins: [{ pinId: '1', netId: '' }] } as Parameters<typeof symbolFor>[0];

const GLYPH_TURN: Record<RoutePin['side'], Position['rotation']> = {
    bottom: undefined,
    top: '180',
    left: '90',
    right: '270',
};

/**
 * The symbol for a supply rail, on every terminal that reaches one.
 *
 * THE SAME ARGUMENT AS GROUND, with one difference that changes the drawing. A rail is the second-largest
 * net in most designs, it crosses everything on its way to each consumer, and no schematic wires it: it puts
 * a supply symbol on each pin. But every ground symbol means the SAME node, so it needs no label, while VCC
 * and +3V3 are different nodes drawn with the same mark — so a rail symbol carries its net's NAME, and a
 * reader who cannot see which rail a pin reaches is worse off than with a wire.
 *
 * A BAR AND A STEM, which is the conventional supply port: the stem rises out of the terminal and the bar
 * caps it. Drawn here rather than in `symbols.ts` because it is notation about a NET rather than a component
 * anybody places — there is no `type: 'power'` to look up, and inventing one would put a part in the tree
 * and on the BOM that nobody buys.
 */
export interface RailGlyph extends PlacedPart {
    /** The rail's name, drawn beside the bar — the one thing a ground symbol never needs and a rail always does. */
    label: string;
    /**
     * Which way the name runs from its anchor, so it runs AWAY from the bar rather than across it.
     *
     * The symbol turns with the terminal it marks; the NAME does not, because text on a schematic is always
     * read horizontally. Turning the anchor with the symbol — which is what happened — put the name beside a
     * vertical bar, centred on it, and an 8pt "VCC" is wider than the four units of clearance it had: the
     * name was drawn straight through the mark it was labelling. Anchoring it at the end that touches the
     * bar and letting it run outward is exact, and costs no guess about how wide the text will be.
     */
    labelRuns: 'middle' | 'start' | 'end';
}

export function railGlyphs(circuit: CircuitJson, placed: readonly PlacedPart[]): RailGlyph[] {
    const byId = new Map((circuit.components ?? []).map((c) => [c.id, c]));
    const rails = new Map(
        (circuit.nets ?? []).filter((n) => n.isPower && !n.isGround).map((n) => [n.id, n.name ?? n.id]),
    );
    if (rails.size === 0) return [];

    const out: RailGlyph[] = [];
    for (const part of placed) {
        const component = byId.get(part.id);
        if (!component || !isPlaceablePart(component)) continue;
        for (const pin of component.pins) {
            const name = rails.get(pin.netId);
            if (name === undefined) continue;
            const sp = part.symbol.pins.find((q) => q.pinId === pin.pinId);
            if (!sp) continue;
            const turned = orientSymbol(railSymbol(), { rotation: RAIL_TURN[sp.side] });
            const own = turned.pins[0]!;
            // The NAME's place is worked out from the side, not inherited from the rotation. Text stays
            // horizontal however the mark is turned, so an anchor that turned with it ended up beside the
            // bar instead of past it — measured: the bar at x=90 and "VCC" centred at x=86, drawn across it.
            const where = RAIL_LABEL[sp.side];
            const symbol = { ...turned, labelAnchor: { x: where.x, y: where.y } };
            out.push({
                id: `${part.id}.${pin.pinId}#rail`,
                designator: '',
                x: part.x + sp.x - own.x,
                y: part.y + sp.y - own.y,
                symbol,
                annotates: `${part.id}.${pin.pinId}`,
                label: name,
                labelRuns: where.runs,
            });
        }
    }
    return out;
}

/**
 * The supply port: a stem from the terminal to a bar across the top.
 *
 * Its pin points DOWN, because a rail is drawn above what it feeds — which is the opposite of ground and is
 * why the turn table below is the mirror of the ground one rather than the same.
 */
function railSymbol(): SymbolGeometry {
    const strokes = [
        { points: [[0, 0] as [number, number], [0, -10] as [number, number]] },
        { points: [[-8, -10] as [number, number], [8, -10] as [number, number]] },
    ];
    const pins = [{ pinId: '1', x: 0, y: 0, side: 'bottom' as const }];
    return {
        basis: 'drawn',
        width: 16,
        height: 10,
        bounds: { minX: -8, minY: -10, maxX: 8, maxY: 0 },
        strokes,
        pins,
        labelAnchor: { x: 0, y: -14 },
    };
}

/**
 * Where the rail's NAME sits, per side — in the turned symbol's own frame, since the pin is at its origin.
 *
 * Read against `railSymbol()`: the stem is 10 long and the bar caps it, so after turning, the bar is 10 from
 * the origin along the stem and spans 8 either side of it.
 *
 *  - STEM VERTICAL (the pin is on the part's top or bottom edge): the bar is horizontal, the name goes past
 *    it along the stem, centred. 4 clear of the bar going up; going down it must also clear the text's own
 *    height, because a baseline is the BOTTOM of the letters.
 *  - STEM HORIZONTAL: the bar is vertical and the name would be drawn straight across it. Anchored at the
 *    end nearest the bar and run outward instead, which needs no estimate of the text's width — the one
 *    quantity this module cannot know. Nudged 3 down so the letters straddle the stem rather than sit on it.
 */
const RAIL_LABEL: Record<RoutePin['side'], { x: number; y: number; runs: 'middle' | 'start' | 'end' }> = {
    top: { x: 0, y: -14, runs: 'middle' },
    bottom: { x: 0, y: 22, runs: 'middle' },
    left: { x: -14, y: 3, runs: 'end' },
    right: { x: 14, y: 3, runs: 'start' },
};

/** Turned so the bar sits AWAY from the part, the mirror of the ground table for the opposite reason. */
const RAIL_TURN: Record<RoutePin['side'], Position['rotation']> = {
    top: undefined,
    bottom: '180',
    left: '270',
    right: '90',
};
