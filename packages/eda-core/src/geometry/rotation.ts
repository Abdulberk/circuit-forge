/**
 * Quarter-turn rotation — the one operator, beside the type it turns.
 *
 * WHY IT LIVES HERE. `Position.rotation` is declared in this package, and TWO consumers act on it: the
 * schematic editor turns a symbol on the sheet, and `pcb-core`'s adapter turns a footprint on the board.
 * They are looking at the same number and must mean the same thing by it, because a part drawn one way and
 * placed another is a board that does not match its drawing — and nothing downstream compares the two.
 *
 * The operator already existed, exactly and correctly, as `rot` in `pcb-core/src/placement.ts`. It could
 * not be shared: `editor-core` is browser-bound and its dependency allowlist admits only this package and
 * `pcb-contract`, deliberately — importing pcb-core would drag an evaluator, a footprint library and three
 * format converters into a browser bundle on one line. So the choice was to copy it or to move it, and a
 * copy is how two authorities on one question get created. This session already paid for that lesson twice
 * over: a probe-name map kept in two places, each subtly short of the other, reported correct designs as
 * unverifiable.
 *
 * EXACT INTEGERS, NO TRIGONOMETRY, and that is not an optimisation. A matrix built from `Math.cos(π/2)`
 * carries 6.1e-17 where it should carry zero, so rotating four times does not return the original: measured
 * drift is 3.6e-15 after four turns and 1e-14 after forty. On a symbol whose pins must sit exactly on a
 * lattice — and they must, or a wire between two parts cannot be a straight line — that drift is the
 * difference between a coordinate and a coordinate-shaped number. Turning a symbol four times gives back
 * the symbol, bit for bit.
 *
 * ROTATION IS NOT MIRROR, and they are not interchangeable. It is tempting to normalise `mirror: 'x'` into
 * `(rotation + 180, mirror: 'y')` — the two are the same picture on a sheet, so a canonical form looks like
 * tidying. It is not: mirror is board-INVISIBLE by contract (see `Position.mirror`) and rotation is the one
 * field the board consumes. Measured against the shipped adapter, that rewrite turns `{rotation:'0',
 * mirror:'x'}` into a footprint emitted with `pcbRotation={180}` — a resistor survives it; a diode, an
 * electrolytic, a SOT-23 or a connector is placed a half turn wrong. There is no canonical form here.
 */

/** The quarter turns a symbol may take, as the DOCUMENT spells them. */
export type RotationDeg = 0 | 90 | 180 | 270;

/**
 * As `Position.rotation` stores it — a string.
 *
 * The two spellings are a real seam: this package writes strings (the zod schema accepts only these
 * literals) and `pcb-core`'s placer works in numbers. Both are converted HERE rather than at each call
 * site, so a caller cannot invent a third convention.
 */
export type RotationString = '0' | '90' | '180' | '270';

const TURNS: readonly RotationDeg[] = [0, 90, 180, 270];

/** Read a stored rotation. Anything unrecognised — absent, malformed, hand-edited — is no rotation. */
export function toDegrees(r: RotationString | number | undefined | null): RotationDeg {
    const n = typeof r === 'string' ? Number(r) : r;
    return TURNS.includes(n as RotationDeg) ? (n as RotationDeg) : 0;
}

/**
 * Write a rotation back, OMITTING zero.
 *
 * `{x, y}` and `{x, y, rotation: '0'}` describe the same part and are not equal as values — the editor
 * compares drawings structurally to decide whether a gesture changed anything, so writing an explicit zero
 * makes "rotate four times" mint a revision and a save for a symbol that is back where it started.
 */
export function rotationField(r: RotationDeg): { rotation?: RotationString } {
    return r === 0 ? {} : { rotation: String(r) as RotationString };
}

/** The next quarter turn clockwise on screen — what one press of the rotate key does. */
export const nextTurn = (r: RotationDeg): RotationDeg => ((r + 90) % 360) as RotationDeg;

/**
 * Rotate a point about the origin by a quarter turn.
 *
 * CLOCKWISE ON SCREEN. Screen coordinates run y-DOWN, so `(x, y) → (−y, x)` — which is counter-clockwise in
 * school geometry — appears clockwise to the person looking at it. The direction is not free: `pcb-core`'s
 * placer has used exactly this mapping since it was written, and the adapter hands the same number to the
 * board, so choosing the other one would silently mirror the relationship between what is drawn and what is
 * built.
 */
export function rotatePoint(r: RotationDeg, x: number, y: number): [number, number] {
    switch (r) {
        case 0:
            return [x, y];
        case 90:
            return [-y, x];
        case 180:
            return [-x, -y];
        case 270:
            return [y, -x];
    }
}

/** Which way a pin's wire leaves, after the symbol is turned. */
export type Side = 'left' | 'right' | 'top' | 'bottom';

const SIDE_ORDER: readonly Side[] = ['right', 'bottom', 'left', 'top'];

/**
 * Turn a pin's side with the symbol.
 *
 * Rotating the coordinates and leaving the side alone is the mistake this exists to prevent, and it is
 * invisible in a static picture: the pin lands in the right place and the router then leaves its wire in
 * the old direction, straight back across the body of the part. The order below follows the same clockwise
 * screen convention as `rotatePoint`, so a pin on the right of an upright symbol is at the bottom of one
 * turned 90°.
 */
export function rotateSide(r: RotationDeg, side: Side): Side {
    const i = SIDE_ORDER.indexOf(side);
    return i < 0 ? side : SIDE_ORDER[(i + r / 90) % 4]!;
}

/** Mirror a point about an axis. `'x'` flips left-to-right; `'y'` flips top-to-bottom. */
export function mirrorPoint(axis: 'x' | 'y' | undefined, x: number, y: number): [number, number] {
    if (axis === 'x') return [-x, y];
    if (axis === 'y') return [x, -y];
    return [x, y];
}

/** Mirror a pin's side about the same axis. A mirror leaves top/bottom alone; `'y'` leaves left/right. */
export function mirrorSide(axis: 'x' | 'y' | undefined, side: Side): Side {
    if (axis === 'x') return side === 'left' ? 'right' : side === 'right' ? 'left' : side;
    if (axis === 'y') return side === 'top' ? 'bottom' : side === 'bottom' ? 'top' : side;
    return side;
}
