/**
 * The size of the thing this module allocates, and the ceiling that stops it.
 *
 * WHY THIS FILE EXISTS. The lattice spans whatever coordinates it is given, and stored positions are
 * ordinary user data — a part dragged a long way, a document written by something else. There has been a
 * ceiling on it for a while and the development server still died on a real design:
 *
 *     ⨯ uncaughtException: RangeError: Array buffer allocation failed
 *         at new ArrayBuffer (<anonymous>)
 *         at new Uint8Array (<anonymous>)
 *
 * The ceiling was written as a node COUNT — four million, described in its own comment as "far past any real
 * schematic" — while the thing that runs out is memory. At a hundred bytes a node that is four hundred
 * megabytes in a single allocation, which is not far past anything. A limit expressed in the wrong unit
 * cannot be checked against what actually fails.
 *
 * So the budget is in bytes and the node count is derived from what a node really costs. That leaves one new
 * way to be wrong — the per-node cost is a hand-written number sitting beside seven typed arrays, and adding
 * an eighth without changing it would make the budget quietly stop meaning anything. The first test below
 * MEASURES the arrays instead of trusting the number.
 */

import { buildLattice, LATTICE_BUDGET } from './lattice';
import { PIN_GRID } from './symbols';

/** Every buffer a lattice owns, in bytes — read off the object rather than counted from the source. */
function bytesOf(lat: NonNullable<ReturnType<typeof buildLattice>>): number {
    const buffers = [
        lat.solid,
        lat.walled,
        lat.grazing,
        lat.heldBy,
        lat.nodeNet,
        lat.nodeMode,
        lat.terminal,
        lat.scratch.best,
        lat.scratch.cameFrom,
        lat.scratch.stamp,
    ];
    return buffers.reduce((n, b) => n + b.byteLength, 0);
}

/** A square sheet of a given side, in nodes, expressed as the two points that span it. */
const sheetOf = (nodesAcross: number) => [
    { x: 0, y: 0 },
    { x: (nodesAcross - 1) * PIN_GRID, y: (nodesAcross - 1) * PIN_GRID },
];

describe('what a lattice costs', () => {
    it('costs what the budget says it costs, measured rather than asserted', () => {
        // The number the ceiling is derived from, checked against the arrays themselves. If someone adds an
        // array and forgets this line, the budget silently becomes a larger number than it claims — which is
        // the exact shape of the defect that crashed the dev server, one level down.
        const lat = buildLattice([], sheetOf(50))!;
        expect(lat).not.toBeNull();
        const nodes = lat.cols * lat.rows;
        expect(bytesOf(lat) / nodes).toBe(LATTICE_BUDGET.bytesPerNode);
    });

    it('keeps a real sheet far inside the budget', () => {
        // A four-hundred-part design is about 2400 units square. It should not be anywhere near the ceiling,
        // and saying so here is what makes the ceiling a bound on the pathological rather than on the normal.
        const lat = buildLattice([], sheetOf(241))!;
        expect(lat).not.toBeNull();
        expect(bytesOf(lat)).toBeLessThan(LATTICE_BUDGET.maxBytes / 4);
    });

    it('refuses a sheet that would not fit, rather than trying and dying', () => {
        // The allocation the dev server died on. `buildLattice` returns null and the router falls back —
        // a poor drawing instead of an exception thrown from inside a render, on a document that would throw
        // again on every reopen because the position causing it is persisted.
        // Comfortably past it, so the test is about the refusal rather than about the ring arithmetic.
        const tooBig = Math.ceil(Math.sqrt(LATTICE_BUDGET.maxNodes)) + 16;
        expect(buildLattice([], sheetOf(tooBig))).toBeNull();
    });

    it('the LARGEST sheet it accepts still fits the budget', () => {
        // The boundary from the other side. Checking only the refusal would miss an off-by-one that let
        // through the very allocation the budget exists to prevent — so this walks up to the last sheet that
        // is accepted and weighs it.
        //
        // FOUND rather than computed, because the lattice is wider than the content it is given: a ring of
        // clear nodes on each side so a wire can always go around the outside. Deriving the boundary from
        // that arithmetic here would be this test keeping its own copy of it, and the two would drift.
        let biggest = null as ReturnType<typeof buildLattice>;
        for (let side = Math.floor(Math.sqrt(LATTICE_BUDGET.maxNodes)); side > 0; side--) {
            biggest = buildLattice([], sheetOf(side));
            if (biggest) break;
        }
        expect(biggest).not.toBeNull();
        expect(bytesOf(biggest!)).toBeLessThanOrEqual(LATTICE_BUDGET.maxBytes);
        // And it is genuinely the boundary: the budget is nearly spent, not merely respected.
        expect(bytesOf(biggest!)).toBeGreaterThan(LATTICE_BUDGET.maxBytes * 0.9);
    });
});
