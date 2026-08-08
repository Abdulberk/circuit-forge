/**
 * What a box selection catches — one rule, so what is shown and what is taken cannot disagree.
 *
 * The canvas needs this answer twice: once every frame, to show the user what the box has hold of, and once
 * on release, to take it. Two copies of a rule that must agree is the drift this codebase keeps paying for —
 * and it would be worse here than usual, because the disagreement would be invisible until somebody let go
 * of the pointer and got something other than what was highlighted.
 *
 * TOUCHES, NOT ENCLOSES. A box that takes only what it fully contains makes a user draw it twice: once too
 * small, once right. That is the whole cost the gesture exists to remove.
 *
 * It is deliberately a linear scan. A spatial index — an R-tree, a quadtree, a uniform grid — is the right
 * structure for many queries over a large scene, and this is not that: measured at 0.008ms for fifty parts
 * and 0.05ms for sixteen hundred, which is free at sixty frames a second. Building an index would cost more
 * than the scan it replaced.
 */

import type { PlacedPart } from './layout';
import type { Box } from './route';

/** Every part whose DRAWN shape meets the box. Order follows the input, so the answer is stable. */
export function partsTouching(parts: readonly PlacedPart[], box: Box): PlacedPart[] {
    return parts.filter((p) => {
        const b = p.symbol.bounds;
        return (
            p.x + b.minX <= box.maxX && p.x + b.maxX >= box.minX && p.y + b.minY <= box.maxY && p.y + b.maxY >= box.minY
        );
    });
}

/** The box two corners describe, in either order — a drag may go up and to the left. */
export function boxBetween(from: readonly [number, number], to: readonly [number, number]): Box {
    return {
        minX: Math.min(from[0], to[0]),
        maxX: Math.max(from[0], to[0]),
        minY: Math.min(from[1], to[1]),
        maxY: Math.max(from[1], to[1]),
    };
}
