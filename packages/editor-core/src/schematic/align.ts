/**
 * Lining parts up, which is the difference between a sheet a machine wrote and one somebody can read.
 *
 * A design that arrives from a generator is placed on a grid by index — correct, and arbitrary. The first
 * thing anyone does to it is drag things into rows and columns, and doing that by hand costs a gesture per
 * part and lands them nearly aligned, which is worse than not aligned at all: a reader's eye reads a
 * two-unit stagger as meaning something.
 *
 * IT IS A CHANGE TO THE DRAWING, not to the design. Nothing here touches the netlist — which is why it lives
 * beside the placement it edits rather than among the document edits, and why an aligned sheet simulates
 * byte-identically to the one before it.
 *
 * WHAT IS ALIGNED IS THE SYMBOL, not the stored point. A part's position is its ORIGIN, and symbols are not
 * all centred on theirs — ground's bars hang below its terminal, and a derived box is centred while a
 * two-terminal part is centred on its body. Lining up origins would leave the drawn shapes visibly ragged,
 * which is precisely what the user asked to fix. So the edges being matched are the edges a reader sees, and
 * the stored point is worked back from them.
 *
 * AND IT IS AS EXACT AS THE LATTICE ALLOWS, which is not always exact. Every position must land on the pin
 * lattice — the guarantee the whole drawing rests on, since two pins off it cannot be joined by a straight
 * wire — and two symbols whose bounds differ by something that is not a whole number of steps cannot both
 * sit on the lattice AND share an edge. The lattice wins, and the residue is under half a step.
 *
 * That is a real trade, stated here because it will otherwise be read as a defect: a user who aligns two
 * parts and measures four units between them is looking at the price of wires that can be drawn straight.
 */

import type { Position } from '@circuit-forge/eda-core';

import type { PlacedPart } from './layout';
import { PIN_GRID } from './symbols';

/** Which edge — or centre — the parts are brought onto. */
export type AlignEdge = 'left' | 'right' | 'top' | 'bottom' | 'centre-x' | 'centre-y';

/** Which axis to spread along, leaving equal gaps between the drawn shapes. */
export type SpreadAxis = 'x' | 'y';

const snap = (v: number): number => Math.round(v / PIN_GRID) * PIN_GRID;

/** Where a part's drawn shape actually is, which is not where its position is. */
const boxOf = (p: PlacedPart) => ({
    minX: p.x + p.symbol.bounds.minX,
    maxX: p.x + p.symbol.bounds.maxX,
    minY: p.y + p.symbol.bounds.minY,
    maxY: p.y + p.symbol.bounds.maxY,
});

/**
 * Bring parts onto one edge, and give back only the positions that MOVED.
 *
 * Only the movers, so an alignment that changes nothing is not a revision: the commit kernel compares by
 * value, and a menu item pressed on parts that are already lined up must not mint an undo step and a save.
 *
 * Every result is snapped to the pin lattice. An alignment that put a part half a step off would break the
 * one guarantee the whole drawing rests on — that pins on a lattice can be joined by a straight wire — and
 * it would do it while the user was tidying up, which is the least likely moment for anyone to suspect it.
 */
export function alignParts(
    parts: readonly PlacedPart[],
    edge: AlignEdge,
    positions?: Record<string, Position>,
): Record<string, Position> {
    if (parts.length < 2) return {}; // one part is already aligned with itself
    const boxes = parts.map(boxOf);

    // The target comes from the parts themselves rather than from a first-one-wins rule: aligning left onto
    // the leftmost edge is what a user means, and it never moves the part they were happiest with.
    const to = {
        left: Math.min(...boxes.map((b) => b.minX)),
        right: Math.max(...boxes.map((b) => b.maxX)),
        top: Math.min(...boxes.map((b) => b.minY)),
        bottom: Math.max(...boxes.map((b) => b.maxY)),
        'centre-x': (Math.min(...boxes.map((b) => b.minX)) + Math.max(...boxes.map((b) => b.maxX))) / 2,
        'centre-y': (Math.min(...boxes.map((b) => b.minY)) + Math.max(...boxes.map((b) => b.maxY))) / 2,
    }[edge];

    const moved: Record<string, Position> = {};
    parts.forEach((p, i) => {
        const b = boxes[i]!;
        const shift = {
            left: to - b.minX,
            right: to - b.maxX,
            top: to - b.minY,
            bottom: to - b.maxY,
            'centre-x': to - (b.minX + b.maxX) / 2,
            'centre-y': to - (b.minY + b.maxY) / 2,
        }[edge];
        const vertical = edge === 'top' || edge === 'bottom' || edge === 'centre-y';
        const next = { x: snap(vertical ? p.x : p.x + shift), y: snap(vertical ? p.y + shift : p.y) };
        if (next.x !== p.x || next.y !== p.y) moved[p.id] = { ...positions?.[p.id], ...next };
    });
    return moved;
}

/**
 * Spread parts evenly along an axis, by the GAPS between their shapes rather than by their positions.
 *
 * Even gaps, not even centres. Parts are not the same size — a voltage source is twice the height of a
 * resistor — so spacing their centres equally leaves visibly uneven space between the things a reader
 * actually sees, which is the complaint the command exists to answer.
 *
 * The two at the ends do not move: they are the extent the user has already chosen, and a spread that also
 * slid them would be a different command that nobody asked for.
 */
export function spreadParts(
    parts: readonly PlacedPart[],
    axis: SpreadAxis,
    positions?: Record<string, Position>,
): Record<string, Position> {
    if (parts.length < 3) return {}; // two parts have one gap, which is already even
    const order = [...parts].sort((a, b) =>
        axis === 'x'
            ? boxOf(a).minX - boxOf(b).minX || a.id.localeCompare(b.id)
            : boxOf(a).minY - boxOf(b).minY || a.id.localeCompare(b.id),
    );
    const boxes = order.map(boxOf);
    const first = boxes[0]!;
    const last = boxes[boxes.length - 1]!;

    const span = axis === 'x' ? last.maxX - first.minX : last.maxY - first.minY;
    const filled = boxes.reduce((n, b) => n + (axis === 'x' ? b.maxX - b.minX : b.maxY - b.minY), 0);
    const gap = (span - filled) / (order.length - 1);

    const moved: Record<string, Position> = {};
    let cursor = axis === 'x' ? first.minX : first.minY;
    order.forEach((p, i) => {
        const b = boxes[i]!;
        const size = axis === 'x' ? b.maxX - b.minX : b.maxY - b.minY;
        if (i > 0 && i < order.length - 1) {
            const shift = cursor - (axis === 'x' ? b.minX : b.minY);
            const next = { x: snap(axis === 'x' ? p.x + shift : p.x), y: snap(axis === 'x' ? p.y : p.y + shift) };
            if (next.x !== p.x || next.y !== p.y) moved[p.id] = { ...positions?.[p.id], ...next };
        }
        cursor += size + gap;
    });
    return moved;
}
