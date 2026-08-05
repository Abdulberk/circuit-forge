/**
 * Turning a symbol — the half of rotation that reaches the screen.
 *
 * `Position.rotation` and `Position.mirror` have been in the schema since it was written, and NOTHING has
 * ever applied them. Measured rather than assumed: rendering the same diode with `rotation:'90'` produces
 * SVG byte-identical to the unrotated case, because the canvas reads only x and y. The sheet has been
 * quietly discarding a field it stores.
 *
 * That is worse than a missing feature, because `pcb-core`'s adapter does NOT discard it — a real adapter
 * run on a position carrying `rotation:'90'` emits `pcbRotation={90}`. So the board already honours a
 * number the drawing ignores: the same design, drawn one way and built another, with nothing anywhere
 * comparing the two.
 *
 * WHAT MUST TURN, and the one that is easy to forget. The strokes and the pin coordinates are obvious. The
 * pin's SIDE is not, and leaving it is invisible in a still picture: the pin lands in exactly the right
 * place, and then the router leaves its wire in the old direction — straight back across the body of the
 * part it just left.
 *
 * WHAT MUST NOT TURN. Text. A designator rendered at 180° is upside down, and a schematic is read; the
 * convention in every EDA tool is that labels stay upright while the symbol turns under them. So the label
 * ANCHOR moves with the shape and the text itself does not rotate — which is a renderer instruction, and
 * why this returns an anchor rather than a transform.
 *
 * ORDER: MIRROR FIRST, THEN ROTATE. The two do not commute — Mx∘R90 = R270∘Mx, measured — so an order has
 * to be picked and stated. This one matches how the fields read: a part is mirrored (a variant of the
 * symbol) and then placed at an angle. Reversing it silently changes what every stored drawing means.
 */
import { mirrorPoint, mirrorSide, rotatePoint, rotateSide, toDegrees, type Position } from '@circuit-forge/eda-core';

import type { SymbolGeometry, SymbolPin, SymbolStroke } from './symbols';

/** How a part is placed on the sheet — the subset of `Position` that changes the drawing. */
export type Orientation = Pick<Position, 'rotation' | 'mirror'>;

/**
 * Apply a part's orientation to its symbol.
 *
 * Returns the SAME geometry object when there is nothing to do, so a caller can use identity to skip work
 * and React can skip a re-render. An upright, unmirrored part is the overwhelmingly common case — every
 * design a machine wrote is entirely upright — and paying for a full rebuild of every symbol on every
 * render to express that would be a cost with no corresponding fact.
 */
export function orientSymbol(geometry: SymbolGeometry, at: Orientation | undefined): SymbolGeometry {
    const turn = toDegrees(at?.rotation);
    const axis = at?.mirror;
    if (turn === 0 && !axis) return geometry;

    const place = (x: number, y: number): [number, number] => {
        const [mx, my] = mirrorPoint(axis, x, y);
        return rotatePoint(turn, mx, my);
    };

    const strokes: SymbolStroke[] = geometry.strokes.map((s) => ({
        ...s,
        points: s.points.map(([x, y]) => place(x, y)),
    }));

    const pins: SymbolPin[] = geometry.pins.map((p) => {
        const [x, y] = place(p.x, p.y);
        return { ...p, x, y, side: rotateSide(turn, mirrorSide(axis, p.side)) };
    });

    const [lx, ly] = place(geometry.labelAnchor.x, geometry.labelAnchor.y);

    // Extents are re-scanned. Swapping width and height at 90°/270° would give the SAME answer — always,
    // not just for these symbols: an axis-aligned bounding box's dimensions depend on the orientation and
    // not on where the box sits, so being off-centre changes nothing. (I first wrote the opposite here, that
    // the swap breaks for shapes not centred on their origin. It does not; a synthetic off-centre case
    // measured identical under both rules.)
    //
    // Scanning is kept because it is the SAME rule the unrotated symbol already lives by — `symbolFor`
    // derives extents by scanning precisely so a declared size cannot disagree with a drawing. Two rules
    // that provably agree today still have to be kept in step tomorrow, and the one that reads the shape
    // stays true whatever the shape becomes.
    const xs = [...strokes.flatMap((s) => s.points.map((p) => p[0])), ...pins.map((p) => p.x)];
    const ys = [...strokes.flatMap((s) => s.points.map((p) => p[1])), ...pins.map((p) => p.y)];

    return {
        ...geometry,
        strokes,
        pins,
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
        // The bounds are scanned by the SAME rule as the extents, from the same points — so a turned or
        // mirrored symbol reports where it actually lies rather than where an unturned one used to.
        bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
        labelAnchor: { x: lx, y: ly },
    };
}
