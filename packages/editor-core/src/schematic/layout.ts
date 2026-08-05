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

import { isDrawnOnSheet } from '../tree/object-tree';

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
    const cols = Math.max(1, Math.ceil(Math.sqrt(parts.length)));

    return parts.map((c, i) => ({
        id: c.id,
        designator: c.designator,
        x: snapToGrid(positions?.[c.id]?.x ?? MARGIN + (i % cols) * cellW + cellW / 2),
        y: snapToGrid(positions?.[c.id]?.y ?? MARGIN + Math.floor(i / cols) * cellH + cellH / 2),
        symbol: symbols[i]!,
    }));
}

/** The symbols as obstacles: what a wire may not be drawn through. */
export const bodiesOf = (placed: readonly PlacedPart[]): Box[] =>
    placed.map((p) => ({
        minX: p.x - p.symbol.width / 2,
        minY: p.y - p.symbol.height / 2,
        maxX: p.x + p.symbol.width / 2,
        maxY: p.y + p.symbol.height / 2,
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
        if (pins.length >= 2) out.push({ id: net.id, name: net.name, pins });
    }
    return out;
}
