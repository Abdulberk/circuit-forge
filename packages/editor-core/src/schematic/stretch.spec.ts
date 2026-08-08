/**
 * What a wire looks like while a part is being dragged.
 *
 * The founder put it plainly: dragging a part in this editor felt stiff and dishonest next to every other
 * one. The wire attached to the dragged part swung through any angle the hand travelled, and the whole
 * drawing changed shape at the moment of release — so the picture during the gesture was never the picture
 * that would result from it.
 *
 * The property under test is the one the entire drawing rests on and the drag was the only place breaking
 * it: EVERY SEGMENT IS AXIS-ALIGNED. It has to hold mid-gesture too, because a wire at forty degrees is not
 * a wire anybody would draw, and seeing one tells the user the editor does not know what it is doing.
 */

import type { Point } from './route';
import { stretchWire } from './stretch';

const at = (x: number, y: number) => `${x},${y}`;

/** Every segment is horizontal or vertical — the claim, stated once and asked of every case. */
const orthogonal = (points: readonly Point[]): boolean =>
    points.slice(1).every((p, i) => p[0] === points[i]![0] || p[1] === points[i]![1]);

/** Where the wire's two ends are, which is what "still attached" means. */
const ends = (points: readonly Point[]) => [points[0], points[points.length - 1]];

describe('a wire while its part is dragged', () => {
    describe('the property that must not break', () => {
        it('keeps every segment axis-aligned, whatever direction the hand went', () => {
            // THE DEFECT. Moving only the end point left the last segment at whatever angle the drag
            // happened to travel: drag a part in a circle and the wire sweeps through 360°.
            const wire: Point[] = [
                [100, 100],
                [200, 100],
                [200, 300],
            ];
            const moved = new Set([at(200, 300)]);
            for (const [dx, dy] of [
                [40, 0],
                [0, 40],
                [40, 40],
                [-70, 30],
                [13, -97],
                [-5, -5],
            ] as const) {
                const after = stretchWire(wire, moved, dx, dy);
                expect({ dx, dy, orthogonal: orthogonal(after) }).toEqual({ dx, dy, orthogonal: true });
            }
        });

        it('keeps the moved end ON the terminal it belongs to', () => {
            // The other half: a wire that stayed orthogonal by refusing to follow the part would be worse
            // than the diagonal, because it would show a connection that is not there.
            const wire: Point[] = [
                [100, 100],
                [200, 100],
                [200, 300],
            ];
            const after = stretchWire(wire, new Set([at(200, 300)]), -60, 25);
            expect(ends(after)[1]).toEqual([140, 325]);
        });

        it('leaves the END NOBODY DRAGGED exactly where it was', () => {
            // It is on a terminal that did not move. Shifting it would detach the wire from a part that is
            // sitting still, which is the same lie pointed the other way.
            const wire: Point[] = [
                [100, 100],
                [200, 100],
                [200, 300],
            ];
            const after = stretchWire(wire, new Set([at(200, 300)]), -60, 25);
            expect(ends(after)[0]).toEqual([100, 100]);
        });
    });

    describe('what absorbs the movement', () => {
        it('slides a horizontal last segment up and down by moving its bend', () => {
            const wire: Point[] = [
                [0, 0],
                [0, 100],
                [200, 100],
            ];
            const after = stretchWire(wire, new Set([at(200, 100)]), 50, 40);
            expect(after).toEqual([
                [0, 0],
                [0, 140],
                [250, 140],
            ]);
        });

        it('slides a vertical last segment left and right the same way', () => {
            const wire: Point[] = [
                [0, 0],
                [100, 0],
                [100, 200],
            ];
            const after = stretchWire(wire, new Set([at(100, 200)]), 30, 60);
            expect(after).toEqual([
                [0, 0],
                [130, 0],
                [130, 260],
            ]);
        });

        it('works from the HEAD end as readily as the tail', () => {
            // Which end of a wire belongs to the dragged part is not the wire's business to care about.
            const wire: Point[] = [
                [0, 0],
                [0, 100],
                [200, 100],
            ];
            const after = stretchWire(wire, new Set([at(0, 0)]), 25, -15);
            expect(orthogonal(after)).toBe(true);
            expect(ends(after)[0]).toEqual([25, -15]);
            expect(ends(after)[1]).toEqual([200, 100]);
        });
    });

    describe('a straight wire, which has no bend to give', () => {
        it('gains the bend a router would have drawn', () => {
            // A single segment cannot absorb a movement across its own axis. Every editor answers this by
            // turning the straight wire into an L, and so does this.
            const wire: Point[] = [
                [0, 0],
                [200, 0],
            ];
            const after = stretchWire(wire, new Set([at(200, 0)]), 50, 80);
            expect(orthogonal(after)).toBe(true);
            expect(ends(after)[1]).toEqual([250, 80]);
            expect(after).toHaveLength(3);
        });

        it('does NOT gain one when the movement is along its own axis', () => {
            // It just gets longer. A bend inserted here would be a visible kink in a straight wire, put
            // there for nothing.
            const wire: Point[] = [
                [0, 0],
                [200, 0],
            ];
            const after = stretchWire(wire, new Set([at(200, 0)]), 50, 0);
            expect(after).toEqual([
                [0, 0],
                [250, 0],
            ]);
        });
    });

    describe('what it must not touch', () => {
        it('moves a wire whose BOTH ends are dragged whole, without bending it', () => {
            // A group drag. The two terminals kept exactly their relationship to each other, so inventing a
            // bend would be inventing a change in a connection that did not change.
            const wire: Point[] = [
                [0, 0],
                [0, 100],
                [200, 100],
            ];
            const after = stretchWire(wire, new Set([at(0, 0), at(200, 100)]), 30, -20);
            expect(after).toEqual([
                [30, -20],
                [30, 80],
                [230, 80],
            ]);
        });

        it('leaves a wire alone when neither end is being dragged', () => {
            const wire: Point[] = [
                [0, 0],
                [0, 100],
            ];
            expect(stretchWire(wire, new Set([at(999, 999)]), 40, 40)).toEqual(wire);
        });

        it('leaves a DIAGONAL alone rather than pretending it can be squared', () => {
            // A diagonal is the router reporting that it could not draw this pair honestly at right angles.
            // The drag has no better idea than the router did, and squaring it here would quietly turn a
            // declared failure into a wire that looks trustworthy.
            const wire: Point[] = [
                [0, 0],
                [200, 130],
            ];
            const after = stretchWire(wire, new Set([at(200, 130)]), 20, 20);
            expect(after).toEqual([
                [0, 0],
                [220, 150],
            ]);
        });

        it('does not mutate the wire it was given', () => {
            // It is rendered from the routed sheet, which is memoised: editing it in place would leave the
            // committed drawing holding a shape from a gesture that was never committed.
            const wire: Point[] = [
                [0, 0],
                [0, 100],
                [200, 100],
            ];
            const copy = wire.map((p) => [...p] as Point);
            stretchWire(wire, new Set([at(200, 100)]), 40, 40);
            expect(wire).toEqual(copy);
        });

        it('returns the wire unchanged for a drag of zero distance', () => {
            const wire: Point[] = [
                [0, 0],
                [0, 100],
            ];
            expect(stretchWire(wire, new Set([at(0, 100)]), 0, 0)).toEqual(wire);
        });
    });
});
