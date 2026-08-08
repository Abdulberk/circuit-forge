/**
 * What a wire does WHILE a part is being dragged, before anything is committed.
 *
 * Re-routing every frame is the obvious answer and it is the wrong one twice over. It does not fit a frame
 * on a large sheet — measured at 27ms for four hundred parts against a 16ms budget — and even where it fits
 * it makes the drawing rearrange itself continuously under the pointer, which is not what any editor does
 * and not what anyone dragging a part is asking for. What they are asking for is that the wire STAYS
 * ATTACHED and stays legible until they let go.
 *
 * The previous answer moved the wire's END POINT by the drag delta and left every other point alone. That
 * attaches the wire, and it destroys the one property the whole drawing rests on: the last segment becomes a
 * line at whatever angle the hand happened to travel. Drag a part in a circle and its wire sweeps through
 * three hundred and sixty degrees. Then the pointer is released, the router runs properly, and the shape
 * snaps to something else — so the drag showed the user a picture that was never going to be the answer.
 *
 * A schematic wire is a chain of axis-aligned segments. Moving one end of it does not have to break that:
 * the segment touching the moved end has ONE free coordinate — a horizontal one may slide up and down, a
 * vertical one left and right — so pushing that coordinate onto the neighbouring bend absorbs the whole
 * movement and leaves every segment axis-aligned. That is what dragging a wire looks like in an editor
 * somebody drew by hand, and it costs a few additions per wire.
 *
 * IT IS NOT THE ROUTE. It is what the wire looks like mid-gesture; the router still runs on release and may
 * find something better. The point is that what the user sees while dragging obeys the same rule as what
 * they get when they stop.
 */

import type { Point } from './route';

/** A point's identity on the sheet, for asking whether it is one of the terminals being dragged. */
const key = (x: number, y: number): string => `${x},${y}`;

/**
 * Move whichever ends of a wire are being dragged, keeping every segment axis-aligned.
 *
 * `movedPins` holds the sheet positions of the terminals under the drag, as `x,y`. A wire whose BOTH ends
 * are being dragged travels whole — that is a group drag, and the connection between two parts moving
 * together does not change shape.
 */
export function stretchWire(points: readonly Point[], movedPins: ReadonlySet<string>, dx: number, dy: number): Point[] {
    if (points.length < 2 || (dx === 0 && dy === 0)) return points.map((p) => [p[0], p[1]] as Point);

    const first = points[0]!;
    const last = points[points.length - 1]!;
    const headMoves = movedPins.has(key(first[0], first[1]));
    const tailMoves = movedPins.has(key(last[0], last[1]));
    if (!headMoves && !tailMoves) return points.map((p) => [p[0], p[1]] as Point);

    // BOTH ENDS: the whole wire travels. Bending it would be inventing a change in a connection whose two
    // terminals kept exactly the same relationship to each other.
    if (headMoves && tailMoves) return points.map((p) => [p[0] + dx, p[1] + dy] as Point);

    const out: Point[] = points.map((p) => [p[0], p[1]] as Point);
    const end = headMoves ? 0 : out.length - 1;
    const inward = headMoves ? 1 : out.length - 2;

    const before = out[end]!;
    const neighbour = out[inward]!;
    const wasHorizontal = before[1] === neighbour[1];
    const wasVertical = before[0] === neighbour[0];

    out[end] = [before[0] + dx, before[1] + dy];

    // A DIAGONAL SEGMENT has no free coordinate to push the movement onto — it is the router saying it could
    // not draw this pair honestly at right angles, and the drag has no better idea. It moves as it is.
    if (!wasHorizontal && !wasVertical) return out;

    if (out.length === 2) {
        // A single straight segment cannot absorb a movement across its own axis, so the drag INSERTS the
        // bend that a router would have drawn. Along the segment's own axis it just gets longer or shorter,
        // and no bend is needed — adding one there would put a visible kink in a straight wire for nothing.
        const along = wasHorizontal ? dy === 0 : dx === 0;
        if (along) return out;
        const corner: Point = wasHorizontal
            ? [neighbour[0], out[end]![1]] // keep the far end's x, take the moved end's y
            : [out[end]![0], neighbour[1]];
        // The same three points whichever end moved: the corner takes the moved end's free coordinate and
        // the far end's fixed one, which reads correctly from either direction.
        return [out[0]!, corner, out[1]!];
    }

    // THE BEND ABSORBS IT. A horizontal segment slides vertically, so its far end takes the new y; a
    // vertical one slides horizontally and takes the new x. Every other point is untouched, which is why
    // the far end of the wire stays exactly where its own terminal is.
    out[inward] = wasHorizontal ? [neighbour[0], out[end]![1]] : [out[end]![0], neighbour[1]];

    return out;
}
