/**
 * Lining parts up, and the one claim that makes it worth having: what gets aligned is what a reader SEES.
 *
 * A position is an ORIGIN, and symbols are not all centred on theirs. Matching origins is easy and wrong —
 * it leaves the drawn shapes visibly ragged, which is exactly the complaint the command answers.
 */

import type { Position } from '@circuit-forge/eda-core';

import { alignParts, spreadParts } from './align';
import type { PlacedPart } from './layout';

/** A part with a stated shape relative to its own origin, so a test can be about off-centre symbols. */
const part = (id: string, x: number, y: number, bounds: PlacedPart['symbol']['bounds']): PlacedPart => ({
    id,
    designator: id.toUpperCase(),
    x,
    y,
    symbol: {
        basis: 'drawn',
        width: bounds.maxX - bounds.minX,
        height: bounds.maxY - bounds.minY,
        bounds,
        strokes: [],
        pins: [],
        labelAnchor: { x: 0, y: 0 },
    },
});

/** Centred on its origin, like nearly every symbol in the library. */
const centred = (id: string, x: number, y: number, w = 40, h = 20) =>
    part(id, x, y, { minX: -w / 2, maxX: w / 2, minY: -h / 2, maxY: h / 2 });

/** NOT centred — the ground symbol's shape: its terminal is above its origin and its bars below. */
const offCentre = (id: string, x: number, y: number) => part(id, x, y, { minX: -8, maxX: 8, minY: -10, maxY: 6 });

const boxOf = (p: PlacedPart, moved: Record<string, Position>) => {
    const at = moved[p.id] ?? { x: p.x, y: p.y };
    return {
        minX: at.x + p.symbol.bounds.minX,
        maxX: at.x + p.symbol.bounds.maxX,
        minY: at.y + p.symbol.bounds.minY,
        maxY: at.y + p.symbol.bounds.maxY,
    };
};

describe('aligning', () => {
    it('lines up the DRAWN EDGES, not the stored points', () => {
        // The claim the whole thing rests on. These two have the SAME origin x and different shapes, so
        // aligning origins would report "already aligned" while the drawing stayed ragged — twelve units
        // apart, which is more than a grid step and plainly visible.
        const parts = [centred('a', 100, 100), offCentre('b', 100, 200)];
        const before = parts.map((p) => boxOf(p, {}).minX);
        expect(Math.abs(before[0]! - before[1]!)).toBe(12);

        const moved = alignParts(parts, 'left');
        const after = parts.map((p) => boxOf(p, moved).minX);
        // WITHIN THE LATTICE, not exactly. Every position must land on the pin lattice, and two symbols whose
        // bounds differ by something that is not a whole number of steps cannot both sit on it and share an
        // edge. The lattice wins — wires depend on it and this does not — and the residue is under half a
        // step. Asserting exact equality here would be asserting something the drawing cannot afford.
        expect(Math.abs(after[0]! - after[1]!)).toBeLessThanOrEqual(5);
    });

    it('brings everything onto the OUTERMOST edge, so the part you liked does not move', () => {
        const parts = [centred('a', 100, 100), centred('b', 200, 200), centred('c', 300, 300)];
        const moved = alignParts(parts, 'left');
        // a was already leftmost, so it stays; the others come to it.
        expect(moved).not.toHaveProperty('a');
        expect(Object.keys(moved).sort()).toEqual(['b', 'c']);
        expect(new Set(parts.map((p) => boxOf(p, moved).minX)).size).toBe(1);
    });

    it('moves ONLY along the axis it is asked about', () => {
        const parts = [centred('a', 100, 100), centred('b', 200, 250)];
        const moved = alignParts(parts, 'top');
        expect(moved.b!.x).toBe(200); // untouched
        expect(new Set(parts.map((p) => boxOf(p, moved).minY)).size).toBe(1);
    });

    it('returns NOTHING when the parts are already lined up', () => {
        // A menu item pressed on an aligned row must not mint a revision and a save for a sheet that did not
        // change. The commit kernel compares by value, and this is the other half of that bargain.
        const parts = [centred('a', 100, 100), centred('b', 100, 200)];
        expect(alignParts(parts, 'left')).toEqual({});
    });

    it('keeps every part on the pin lattice', () => {
        // The guarantee the whole drawing rests on: pins on a lattice can be joined by a straight wire.
        // Breaking it while the user is TIDYING UP is the least likely moment for anyone to suspect it.
        const parts = [centred('a', 100, 100, 41, 21), centred('b', 137, 200, 23, 15), centred('c', 251, 300, 37, 11)];
        for (const edge of ['left', 'right', 'centre-x'] as const) {
            const moved = alignParts(parts, edge);
            for (const at of Object.values(moved)) expect([at.x % 10, at.y % 10]).toEqual([0, 0]);
        }
    });

    it('keeps whatever else the position carried', () => {
        // A part that was turned stays turned. Losing it here would make the sheet disagree with the board
        // about the same part, while the user was doing something that has nothing to do with rotation.
        const parts = [centred('a', 100, 100), centred('b', 200, 200)];
        const moved = alignParts(parts, 'left', { b: { x: 200, y: 200, rotation: '90', mirror: 'x' } });
        expect(moved.b).toEqual(expect.objectContaining({ rotation: '90', mirror: 'x' }));
    });

    it('does nothing to one part, which is already aligned with itself', () => {
        expect(alignParts([centred('a', 100, 100)], 'left')).toEqual({});
    });
});

describe('spreading', () => {
    it('leaves equal GAPS between the shapes, not equal distances between the points', () => {
        // Parts are not the same size. Spacing their centres equally leaves visibly uneven space between the
        // things a reader actually sees, which is the complaint the command exists to answer.
        const parts = [centred('a', 0, 0, 20), centred('b', 100, 0, 80), centred('c', 300, 0, 20)];
        const moved = spreadParts(parts, 'x');
        const boxes = parts.map((p) => boxOf(p, moved)).sort((u, v) => u.minX - v.minX);
        const gaps = boxes.slice(1).map((b, i) => b.minX - boxes[i]!.maxX);
        expect(Math.abs(gaps[0]! - gaps[1]!)).toBeLessThanOrEqual(10); // one lattice step of rounding
    });

    it('does not move the two at the ends', () => {
        // They are the extent the user already chose. A spread that slid them too would be a different
        // command, and not one anybody asked for.
        const parts = [centred('a', 0, 0), centred('b', 130, 0), centred('c', 300, 0)];
        const moved = spreadParts(parts, 'x');
        expect(Object.keys(moved)).toEqual(['b']);
    });

    it('needs three to mean anything', () => {
        // Two parts have one gap, and one gap is already even.
        expect(spreadParts([centred('a', 0, 0), centred('b', 100, 0)], 'x')).toEqual({});
    });

    it('is the same answer however the parts arrived', () => {
        // Sorted by edge with the id as a tie-break, so the same sheet spreads the same way whatever order
        // the selection was built in.
        const parts = [centred('a', 0, 0), centred('b', 130, 0), centred('c', 300, 0)];
        expect(spreadParts([...parts].reverse(), 'x')).toEqual(spreadParts(parts, 'x'));
    });
});
