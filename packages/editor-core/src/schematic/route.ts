/**
 * Orthogonal wire routing, admissibility first.
 *
 * WHAT A SCHEMATIC WIRE MEANS. A schematic is not a picture of a circuit, it is a claim about which
 * terminals are the same electrical node. Everything a reader concludes, they conclude from the drawing:
 * two pins joined by a line are one node, a line that ends on a pin touches it, a dot means a junction and
 * a bare crossing means two wires that pass without meeting. Those readings are the whole language.
 *
 * WHY THIS IS HARDER THAN IT LOOKS. Right-angle wires are what every schematic uses and what every reader
 * expects — and turning diagonals into right angles CREATES a hazard that diagonals do not have. A diagonal
 * can cross anything and still be read correctly, because two diagonals that cross plainly cross. But two
 * axis-aligned wires that run along the same line for a stretch are indistinguishable from ONE wire, and a
 * wire that passes exactly through an unrelated pin is indistinguishable from a wire that connects to it.
 * Both are silent: the drawing states a circuit that is not the one in the document, and nothing on screen
 * marks the difference. That is the failure this module exists to prevent — not ugliness, a WRONG READING.
 *
 * SO: ADMISSIBILITY IS A GATE, NOT A SCORE. A route is drawn only when it cannot be misread. Candidates
 * that would produce a false reading are REFUSED, not penalised — no weighting can trade a legible corner
 * against a wire that lies. Preference among the survivors is lexicographic — fewer corners, then less
 * grazing, then shorter — rather than a weighted sum, because weights invent an exchange rate between
 * incomparable things and then hide it in a constant.
 *
 * THE GATE APPLIES TO THE FALLBACK TOO, and that took a test to see. The first version of this module
 * described its fallback as "a diagonal, which cannot be misread" and then emitted a straight line between
 * the two terminals — which for terminals that happen to share a row is not a diagonal at all, but an
 * axis-aligned run carrying every hazard the gate had just refused. A fallback outside the rule is not a
 * fallback, it is a hole. So the search ends in kinked diagonals that are themselves admissible, and the
 * remaining case — where even those fail — is REPORTED rather than drawn quietly.
 */

import { buildLattice, findPath, hold, type Lattice } from './lattice';
import { PIN_GRID, type SymbolPin } from './symbols';

/** An axis-aligned box in sheet coordinates. */
export interface Box {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export type Point = readonly [number, number];

/** Which way the wire leaves the terminal, so it never sets off through its own body. */
export type Side = SymbolPin['side'];

export interface RoutePin {
    x: number;
    y: number;
    side: Side;
    /** Identifies the terminal in diagnostics and as a stable React key. Never rendered. */
    label: string;
}

export interface RouteNet {
    id: string;
    name: string;
    pins: readonly RoutePin[];
}

/** How a wire ended up drawn. Reported rather than inferred: a fallback is invisible once it is on screen. */
export type RouteShape = 'straight' | 'elbow' | 'jog' | 'diagonal';

export interface RoutedWire {
    key: string;
    netId: string;
    netName: string;
    points: Point[];
    shape: RouteShape;
}

/** Where a net branches. Without the dot, the reader is entitled to read a crossing. */
export interface Junction {
    x: number;
    y: number;
    netId: string;
}

/**
 * A wire that could not be drawn the way it should be, and why.
 *
 * `no-orthogonal-route` is ordinary and cosmetic: the sheet is crowded here and the wire is a diagonal.
 * `no-legible-route` is not cosmetic — it means no line between these two terminals avoids stating
 * something false, which happens when a foreign terminal sits exactly on every path. The drawing shows the
 * best available line and this list is how anyone finds out it is not trustworthy.
 */
export interface Fallback {
    netId: string;
    key: string;
    reason: 'no-orthogonal-route' | 'no-legible-route';
}

export interface RoutedSheet {
    wires: RoutedWire[];
    junctions: Junction[];
    fellBack: Fallback[];
}

/** How far a wire travels along the pin's own direction before it is allowed to turn. */
const ESCAPE = PIN_GRID;

interface Seg {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

const lo = (a: number, b: number): number => (a < b ? a : b);
const hi = (a: number, b: number): number => (a > b ? a : b);
const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

function segsOf(pts: readonly Point[]): Seg[] {
    const out: Seg[] = [];
    for (let i = 1; i < pts.length; i++) {
        const [x1, y1] = pts[i - 1]!;
        const [x2, y2] = pts[i]!;
        if (x1 !== x2 || y1 !== y2) out.push({ x1, y1, x2, y2 });
    }
    return out;
}

/**
 * Does the segment enter the box's INTERIOR?
 *
 * Liang–Barsky clipping, kept general rather than special-cased to horizontal and vertical, because the
 * fallback wires are diagonals and a predicate that quietly assumed axis-alignment would wave them through.
 * The box is treated as OPEN, so a wire may run along a symbol's edge — deliberate, not lax: pins sit ON a
 * symbol's extent, a resistor's lead end being exactly its topmost point, so inflating these boxes even
 * slightly would place every pin inside an obstacle and refuse every route. Grazing is a PREFERENCE below.
 */
function entersBox(s: Seg, b: Box): boolean {
    const dx = s.x2 - s.x1;
    const dy = s.y2 - s.y1;
    let t0 = 0;
    let t1 = 1;
    for (const [p, q] of [
        [-dx, s.x1 - b.minX],
        [dx, b.maxX - s.x1],
        [-dy, s.y1 - b.minY],
        [dy, b.maxY - s.y1],
    ] as const) {
        if (p === 0) {
            // Parallel to this pair of edges: inside only if strictly between them.
            if (q <= 0) return false;
            continue;
        }
        const r = q / p;
        if (p < 0) {
            if (r > t1) return false;
            if (r > t0) t0 = r;
        } else {
            if (r < t0) return false;
            if (r < t1) t1 = r;
        }
    }
    return t1 - t0 > 0;
}

/**
 * Does the wire touch this point at all — including at its own ends?
 *
 * Ends count. A wire that STOPS on a foreign pin reads as connected to it even more plainly than one that
 * crosses it, so excluding endpoints would admit the worst case of the very thing being checked.
 */
function touchesPoint(s: Seg, x: number, y: number): boolean {
    if (cross(s.x2 - s.x1, s.y2 - s.y1, x - s.x1, y - s.y1) !== 0) return false;
    return x >= lo(s.x1, s.x2) && x <= hi(s.x1, s.x2) && y >= lo(s.y1, s.y2) && y <= hi(s.y1, s.y2);
}

/**
 * Do two segments run along the SAME LINE for a stretch?
 *
 * This is the false-connection hazard in full. Two wires that share a run are drawn as one wire, and the
 * reader has no mark to tell them apart — not a dot, not a hop, nothing. Sharing a single POINT is a
 * crossing and is fine; sharing any length is not.
 */
function sharesRun(a: Seg, b: Seg): boolean {
    const [adx, ady] = [a.x2 - a.x1, a.y2 - a.y1];
    if (cross(adx, ady, b.x2 - b.x1, b.y2 - b.y1) !== 0) return false; // not parallel
    if (cross(adx, ady, b.x1 - a.x1, b.y1 - a.y1) !== 0) return false; // parallel but apart
    // Project onto whichever axis the shared line actually spans, so a vertical pair is compared in y.
    const useX = Math.abs(adx) >= Math.abs(ady);
    const [al, ah] = useX ? [lo(a.x1, a.x2), hi(a.x1, a.x2)] : [lo(a.y1, a.y2), hi(a.y1, a.y2)];
    const [bl, bh] = useX ? [lo(b.x1, b.x2), hi(b.x1, b.x2)] : [lo(b.y1, b.y2), hi(b.y1, b.y2)];
    return lo(ah, bh) - hi(al, bl) > 0;
}

const STEP: Record<Side, Point> = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

/**
 * The sheet's contents, indexed so that asking about them is cheap.
 *
 * WHY AN INDEX AND NOT A LOOP. This runs on every change to a document, and the naive form is a product of
 * four counts — wires times candidates times segments times terminals — which on a four-hundred-part board
 * is tens of millions of comparisons per keystroke. One uniform grid holds bodies, terminals and claimed
 * wires; every query asks only the cells its own segment passes through. The grid returns a SUPERSET, and
 * the exact predicate above still runs on everything it returns, so the index can only cost time, never
 * correctness.
 */
const CELL = 64;

function makeField(bodies: readonly Box[]): {
    bodiesNear: (s: Seg) => readonly Box[];
    addPin: (p: RoutePin, netId: string) => void;
    foreignPinOn: (s: Seg, netId: string) => boolean;
    pinsAt: (x: number, y: number, netId: string) => readonly RoutePin[];
    claim: (segs: readonly Seg[]) => void;
    sharesClaimedRun: (s: Seg) => boolean;
} {
    const cells = (minX: number, minY: number, maxX: number, maxY: number): string[] => {
        const keys: string[] = [];
        for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++)
            for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) keys.push(`${cx},${cy}`);
        return keys;
    };
    const around = (s: Seg): string[] => cells(lo(s.x1, s.x2), lo(s.y1, s.y2), hi(s.x1, s.x2), hi(s.y1, s.y2));

    const put = <V>(m: Map<string, V[]>, k: string, v: V): void => {
        const at = m.get(k);
        if (at) at.push(v);
        else m.set(k, [v]);
    };
    const gather = <V>(m: Map<string, V[]>, keys: readonly string[]): V[] => {
        const seen = new Set<V>();
        for (const k of keys) for (const v of m.get(k) ?? []) seen.add(v);
        return [...seen];
    };

    const bodyGrid = new Map<string, Box[]>();
    for (const b of bodies) for (const k of cells(b.minX, b.minY, b.maxX, b.maxY)) put(bodyGrid, k, b);

    const pinGrid = new Map<string, Array<{ pin: RoutePin; netId: string }>>();
    const runGrid = new Map<string, Seg[]>();

    return {
        bodiesNear: (s) => gather(bodyGrid, around(s)),
        addPin: (pin, netId) => put(pinGrid, cells(pin.x, pin.y, pin.x, pin.y)[0]!, { pin, netId }),
        foreignPinOn: (s, netId) =>
            gather(pinGrid, around(s)).some((e) => e.netId !== netId && touchesPoint(s, e.pin.x, e.pin.y)),
        pinsAt: (x, y, netId) =>
            gather(pinGrid, cells(x, y, x, y))
                .filter((e) => e.netId === netId && e.pin.x === x && e.pin.y === y)
                .map((e) => e.pin),
        claim: (segs) => {
            for (const s of segs) for (const k of around(s)) put(runGrid, k, s);
        },
        sharesClaimedRun: (s) => gather(runGrid, around(s)).some((c) => sharesRun(s, c)),
    };
}

type Field = ReturnType<typeof makeField>;

/** The gate. Anything that would make the drawing state a different circuit is refused outright. */
function admissible(pts: readonly Point[], field: Field, netId: string): boolean {
    for (const s of segsOf(pts)) {
        for (const b of field.bodiesNear(s)) if (entersBox(s, b)) return false;
        if (field.foreignPinOn(s, netId)) return false;
        if (field.sharesClaimedRun(s)) return false;
    }
    return true;
}

/** Collapses the collinear seams the escape stubs introduce, so a straight wire is ONE segment. */
function dedupe(pts: readonly Point[]): Point[] {
    const out: Point[] = [];
    for (const p of pts) {
        const last = out[out.length - 1];
        if (last && last[0] === p[0] && last[1] === p[1]) continue;
        const prev = out[out.length - 2];
        if (last && prev) {
            const collinear = cross(last[0] - prev[0], last[1] - prev[1], p[0] - last[0], p[1] - last[1]) === 0;
            // Only when the middle point is genuinely BETWEEN the other two. Three points on one line that
            // double back are a real reversal, and folding them would erase it.
            const between =
                last[0] >= lo(prev[0], p[0]) &&
                last[0] <= hi(prev[0], p[0]) &&
                last[1] >= lo(prev[1], p[1]) &&
                last[1] <= hi(prev[1], p[1]);
            if (collinear && between) out.pop();
        }
        out.push(p);
    }
    return out;
}

/** The shape a path IS, read off the path — not a label chosen when it was built and free to drift from it. */
const shapeOf = (pts: readonly Point[]): RouteShape => {
    if (segsOf(pts).some((s) => s.x1 !== s.x2 && s.y1 !== s.y2)) return 'diagonal';
    return pts.length <= 2 ? 'straight' : pts.length === 3 ? 'elbow' : 'jog';
};

/**
 * When even the lattice has nothing, a shape that cannot be mistaken for a route.
 *
 * The straight line first, and then genuinely kinked diagonals if it is not admissible — which it may well
 * not be, since two terminals sharing a row have a straight line that is an axis-aligned run like any
 * other. The kink is perpendicular so the halves cannot lie along anything the wire was avoiding, and it is
 * deliberately off the lattice by half a step: a diagonal that lands on grid corners starts to look like a
 * route, and this shape's whole job is to look like what it is.
 */
function fallbacks(a: Point, b: Point): Point[][] {
    const [[ax, ay], [bx, by]] = [a, b];
    const out: Point[][] = [[a, b]];
    const [mx, my] = [(ax + bx) / 2, (ay + by) / 2];
    for (const d of [PIN_GRID / 2, -PIN_GRID / 2, PIN_GRID, -PIN_GRID])
        out.push(ay === by ? [a, [mx, my + d], b] : [a, [mx + d, my], b]);
    return out;
}

interface Search {
    lat: Lattice;
    /** Nets are numbered because the lattice holds them in typed arrays; 0 is kept to mean "nobody". */
    number: (netId: string) => number;
}

function routeOne(
    from: RoutePin,
    to: RoutePin,
    field: Field,
    net: RouteNet,
    search: Search,
): { points: Point[]; shape: RouteShape; reason?: Fallback['reason']; nodes?: number[] } {
    const escapeOf = (p: RoutePin): Point => {
        const [dx, dy] = STEP[p.side];
        return [p.x + dx * ESCAPE, p.y + dy * ESCAPE];
    };
    const head: Point = [from.x, from.y];
    const tail: Point = [to.x, to.y];
    const [ea, eb] = [escapeOf(from), escapeOf(to)];
    const n = search.number(net.id);

    const nodes = findPath(search.lat, search.lat.nodeAt(...ea), search.lat.nodeAt(...eb), n);
    if (nodes) {
        const points = dedupe([head, ...nodes.map((k): Point => [search.lat.xOf(k), search.lat.yOf(k)]), tail]);
        // THE GATE STILL RUNS. The lattice is built to make an inadmissible path unreachable, and this asks
        // anyway — the search works in node indices and the promise is about geometry, so the two could drift
        // apart without either being obviously wrong. If they ever do, the wire falls back and says so
        // instead of quietly drawing the first thing this module was written to prevent.
        if (admissible(points, field, net.id)) return { points, shape: shapeOf(points), nodes };
    }

    const honest = fallbacks(head, tail).find((p) => admissible(p, field, net.id));
    if (honest) return { points: honest, shape: 'diagonal', reason: 'no-orthogonal-route' };

    // Every line between these two terminals states something false. Drawn anyway — a missing wire is a
    // worse lie than a crowded one — and REPORTED, which is the only reason this case is not a silent bug.
    return { points: [head, tail], shape: 'diagonal', reason: 'no-legible-route' };
}

/**
 * Every wire on the sheet.
 *
 * THE STAR, kept here rather than in a renderer. A net is a SET of terminals that are one node; it carries
 * no order. Drawing A–B–C would state an order the netlist does not have and would invite the reader to
 * believe current reaches C through B. Spokes from one hub state the truth: everything meets at a point.
 *
 * ORDER MATTERS AND IS FIXED. Each net avoids the runs already claimed by earlier ones, so the result
 * depends on the order nets arrive in — and it is the caller's order, unshuffled, so the same document
 * always draws the same sheet. A net that arrives late is likelier to fall back; that shows up in
 * `fellBack` rather than hiding inside a heuristic.
 *
 * A net does NOT avoid its own runs. Two spokes of one net sharing a stretch of line are one node drawn
 * twice, which is exactly what they are — the shared-run hazard is about two DIFFERENT nodes being drawn as
 * one, and refusing it within a net would spend diagonals on a reading that was never wrong.
 */
export function routeSheet(nets: readonly RouteNet[], bodies: readonly Box[]): RoutedSheet {
    const field = makeField(bodies);
    for (const net of nets) for (const p of net.pins) field.addPin(p, net.id);

    // One space for the whole sheet, built once. Terminals are marked in it before anything is routed, so
    // the very first wire already knows which points belong to somebody else.
    const numbers = new Map<string, number>(nets.map((n, i) => [n.id, i + 1]));
    const lat = buildLattice(
        bodies,
        nets.flatMap((n) => [...n.pins]),
    );
    for (const net of nets)
        for (const p of net.pins) {
            const at = lat.nodeAt(p.x, p.y);
            if (at >= 0) lat.terminal[at] = numbers.get(net.id)!;
        }
    const search: Search = { lat, number: (id) => numbers.get(id) ?? 0 };

    const wires: RoutedWire[] = [];
    const fellBack: Fallback[] = [];
    const junctions: Junction[] = [];

    for (const net of nets) {
        const [hub, ...spokes] = net.pins;
        // A one-pin net is an UNCONNECTED terminal, and drawing nothing is the correct depiction of it: the
        // bare pin is the symbol for it, and ERC reports it in exactly those words.
        if (!hub || spokes.length === 0) continue;

        const mine: Seg[] = [];
        const held: number[][] = [];
        for (const spoke of spokes) {
            const { points, shape, reason, nodes } = routeOne(hub, spoke, field, net, search);
            const key = `${net.id}:${spoke.label}`;
            wires.push({ key, netId: net.id, netName: net.name, points, shape });
            if (reason) fellBack.push({ netId: net.id, key, reason });
            mine.push(...segsOf(points));
            if (nodes) held.push(nodes);
        }
        // Claimed only once the whole net is routed, so a net never refuses itself: two spokes of one node
        // may run along the same line, because on screen that is one node drawn twice and not two nodes
        // drawn as one.
        field.claim(mine);
        for (const path of held) hold(lat, path, numbers.get(net.id)!);
        junctions.push(...junctionsOf(mine, net, field));
    }

    return { wires, junctions, fellBack };
}

/**
 * Where this net needs a dot.
 *
 * THE CONVENTION, which is not decoration: a dot means these conductors are one node, and its absence means
 * they merely cross. A dot belongs wherever three or more conductors meet.
 *
 * COUNTED AS DIRECTIONS, NOT AS WIRE-ENDS, and the difference is the whole correctness of it. Spokes of one
 * net all leave the hub along the same escape, so several wires depart a terminal on top of each other and
 * a reader sees ONE wire leaving — counting ends would put a dot on that pin claiming a branch that is not
 * visible, and would miss the real branch a little further along where the wires part. Directions get both
 * right: identical departures collapse to one, a wire passing straight through contributes two, and the
 * terminal's own lead — arriving from the body, opposite to the side its wire leaves on — contributes one.
 */
function junctionsOf(segs: readonly Seg[], net: RouteNet, field: Field): Junction[] {
    const seen = new Set<string>();
    const out: Junction[] = [];

    for (const s of segs) {
        for (const [x, y] of [
            [s.x1, s.y1],
            [s.x2, s.y2],
        ] as const) {
            const at = `${x},${y}`;
            if (seen.has(at)) continue;
            seen.add(at);

            const dirs = new Set<string>();
            const towards = (px: number, py: number): void => {
                const [dx, dy] = [px - x, py - y];
                if (dx === 0 && dy === 0) return;
                const n = Math.abs(dx) + Math.abs(dy); // any consistent normaliser: only the ratio matters
                dirs.add(`${dx / n},${dy / n}`);
            };

            for (const t of segs) {
                if (!touchesPoint(t, x, y)) continue;
                towards(t.x1, t.y1);
                towards(t.x2, t.y2);
            }
            // The terminal's own lead, which is a conductor like any other and is why two wires meeting at a
            // pin is three conductors rather than two.
            for (const p of field.pinsAt(x, y, net.id)) {
                const [dx, dy] = STEP[p.side];
                dirs.add(`${-dx},${-dy}`);
            }

            if (dirs.size >= 3) out.push({ x, y, netId: net.id });
        }
    }
    return out;
}
