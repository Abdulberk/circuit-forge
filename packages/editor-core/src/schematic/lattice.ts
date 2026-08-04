/**
 * The lattice a wire is allowed to travel on, and the search that finds a way across it.
 *
 * WHY A SEARCH AND NOT A LIST OF SHAPES. The first version of the router enumerated the routes a person
 * would think of — the straight line, the two elbows, a step across on some other line — and asked which of
 * them were legible. On two-part and eight-part circuits that was enough. On a twenty-part one it drew
 * fourteen of twenty-six wires and gave up on the rest, because a sheet with more nets than gaps needs
 * wires that go partway along one lane, step across, and continue on another. No list of named shapes
 * contains that; the shape depends on what every earlier wire has already taken.
 *
 * So the lanes are not enumerated, they are SEARCHED. Every point where wires may run is a node, every
 * hop between neighbouring points is an edge, and a wire is a path. What the drawing may not say becomes
 * simply what the path may not use:
 *
 *   - a point inside a symbol is not a place a wire can be
 *   - a point holding another net's terminal is not either, because a wire that reaches it states a
 *     connection the netlist does not have
 *   - a hop already used by another net is taken, because two wires along one line are drawn as one wire
 *
 * The rules do not change; they move from being tests applied after the fact to being the shape of the
 * space, which is why the search cannot propose something the gate would refuse.
 *
 * THE COST HAS NO TUNING CONSTANT. A schematic reader wants few corners first and short wires second, and
 * that ordering is exact rather than a trade: a corner is worth more than any amount of length, so the
 * cost of a path is its corner count in the high digits and its length in the low ones. `TURN` is set to
 * one more than the longest path the lattice can hold, which makes the comparison lexicographic by
 * construction — no weight to pick, and nothing to re-tune when a sheet gets bigger.
 */

import { PIN_GRID } from './symbols';

export interface LatticeBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** Which way a step goes. The order is fixed so that equal-cost paths resolve the same way every time. */
const DIRS = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
] as const;

/** How much empty sheet to keep outside everything, so a wire can always go around the outside. */
const RING = 4;

/**
 * How far a search may look before it gives up.
 *
 * Not a quality knob — a bound on work. Most wires join terminals near each other, and letting every one
 * sweep the whole sheet before admitting defeat costs the sheet's entire area on each wire that cannot be
 * drawn. The narrow window is tried first and answers almost everything; the wide one runs only if the
 * narrow one was actually clipped by it, since a search that already had the whole sheet and found nothing
 * will not find anything by being handed the same thing again. When the wider bound binds too, the wire
 * falls back and SAYS SO rather than pretending the sheet was full.
 */
const WINDOWS = [24, 120];

export interface Lattice {
    /** Snaps a sheet coordinate to the nearest node, and back. */
    readonly originX: number;
    readonly originY: number;
    readonly cols: number;
    readonly rows: number;
    nodeAt: (x: number, y: number) => number;
    xOf: (node: number) => number;
    yOf: (node: number) => number;
    /** A point no wire may occupy: inside a symbol. Static for the whole sheet. */
    solid: Uint8Array;
    /** A hop no wire may take because it would pass through a symbol. Indexed `node * 2 + axis`. */
    walled: Uint8Array;
    /**
     * A hop that runs ALONG a symbol's edge.
     *
     * Legible — a wire down the side of a part is read correctly — but a wire that appears to be touching a
     * symbol it has nothing to do with is a worse drawing than one that keeps clear. Allowed, and preferred
     * against, which is why it is a cost rather than a wall: forbidding it would make narrow gaps impassable.
     */
    grazing: Uint8Array;
    /** Which net holds each hop, or 0 for free. Net numbers start at 1 so that 0 can mean nobody. */
    heldBy: Int32Array;
    /** Which net's terminal sits on each node, or 0. A node held by another net is closed to this one. */
    terminal: Int32Array;
    /**
     * The search's own workspace, allocated ONCE for the sheet rather than once per wire.
     *
     * Five entries per node: a wire arriving from each of four directions, plus the start, which has come
     * from nowhere and so turns for free. Allocated inside the search, a twelve-part sheet cost a hundred
     * and seventy kilobytes per wire, and a sheet is thousands of wires — handing the same buffers back is
     * most of the difference between a schematic that redraws while you drag and one that stutters.
     *
     * `stamp` is what makes reuse safe. A slot whose stamp is not the current search's is unset, so nothing
     * has to be cleared between wires; clearing would have put the cost straight back.
     */
    scratch: { best: Float64Array; cameFrom: Int32Array; stamp: Int32Array; generation: number };
}

/**
 * Builds the space once for the whole sheet.
 *
 * Everything static — where the symbols are, which hops they block — is computed here rather than per wire,
 * because it does not change while a sheet is being routed and recomputing it eight hundred times is eight
 * hundred times the work for the same answer.
 */
export function buildLattice(bodies: readonly LatticeBox[], points: readonly { x: number; y: number }[]): Lattice {
    const xs = [...bodies.flatMap((b) => [b.minX, b.maxX]), ...points.map((p) => p.x)];
    const ys = [...bodies.flatMap((b) => [b.minY, b.maxY]), ...points.map((p) => p.y)];
    const floorTo = (v: number): number => Math.floor(v / PIN_GRID) * PIN_GRID;
    const ceilTo = (v: number): number => Math.ceil(v / PIN_GRID) * PIN_GRID;

    const originX = floorTo(Math.min(...xs, 0)) - RING * PIN_GRID;
    const originY = floorTo(Math.min(...ys, 0)) - RING * PIN_GRID;
    const cols = (ceilTo(Math.max(...xs, 0)) - originX) / PIN_GRID + RING + 1;
    const rows = (ceilTo(Math.max(...ys, 0)) - originY) / PIN_GRID + RING + 1;

    const solid = new Uint8Array(cols * rows);
    const walled = new Uint8Array(cols * rows * 2);
    const grazing = new Uint8Array(cols * rows * 2);
    const heldBy = new Int32Array(cols * rows * 2);
    const terminal = new Int32Array(cols * rows);

    const iOf = (x: number): number => Math.round((x - originX) / PIN_GRID);
    const jOf = (y: number): number => Math.round((y - originY) / PIN_GRID);

    for (const b of bodies) {
        // Points strictly inside the symbol. The boundary stays open on purpose: terminals sit ON a
        // symbol's extent, so closing the boundary would seal every terminal inside its own part.
        for (let i = Math.max(0, iOf(b.minX)); i <= Math.min(cols - 1, iOf(b.maxX)); i++)
            for (let j = Math.max(0, jOf(b.minY)); j <= Math.min(rows - 1, jOf(b.maxY)); j++) {
                const [x, y] = [originX + i * PIN_GRID, originY + j * PIN_GRID];
                if (x > b.minX && x < b.maxX && y > b.minY && y < b.maxY) solid[j * cols + i] = 1;
            }

        // Hops that would pass through the symbol. A hop along an edge of the box does not — running a wire
        // down the side of a part is legible, and forbidding it would make narrow gaps impassable.
        for (let i = Math.max(0, iOf(b.minX) - 1); i <= Math.min(cols - 2, iOf(b.maxX)); i++)
            for (let j = Math.max(0, jOf(b.minY) - 1); j <= Math.min(rows - 1, jOf(b.maxY)); j++) {
                const [x, y] = [originX + i * PIN_GRID, originY + j * PIN_GRID];
                const spansX = x < b.maxX && x + PIN_GRID > b.minX;
                if (y > b.minY && y < b.maxY && spansX) walled[(j * cols + i) * 2] = 1;
                else if ((y === b.minY || y === b.maxY) && spansX) grazing[(j * cols + i) * 2] = 1;
            }
        for (let i = Math.max(0, iOf(b.minX)); i <= Math.min(cols - 1, iOf(b.maxX)); i++)
            for (let j = Math.max(0, jOf(b.minY) - 1); j <= Math.min(rows - 2, jOf(b.maxY)); j++) {
                const [x, y] = [originX + i * PIN_GRID, originY + j * PIN_GRID];
                const spansY = y < b.maxY && y + PIN_GRID > b.minY;
                if (x > b.minX && x < b.maxX && spansY) walled[(j * cols + i) * 2 + 1] = 1;
                else if ((x === b.minX || x === b.maxX) && spansY) grazing[(j * cols + i) * 2 + 1] = 1;
            }
    }

    return {
        originX,
        originY,
        cols,
        rows,
        nodeAt: (x, y) => {
            const [i, j] = [iOf(x), jOf(y)];
            return i < 0 || j < 0 || i >= cols || j >= rows ? -1 : j * cols + i;
        },
        xOf: (node) => originX + (node % cols) * PIN_GRID,
        yOf: (node) => originY + Math.floor(node / cols) * PIN_GRID,
        solid,
        walled,
        grazing,
        heldBy,
        terminal,
        scratch: {
            best: new Float64Array(cols * rows * 5),
            cameFrom: new Int32Array(cols * rows * 5),
            stamp: new Int32Array(cols * rows * 5),
            generation: 0,
        },
    };
}

/** Marks every hop a finished wire occupies, so the next net cannot draw along the same line. */
export function hold(lat: Lattice, path: readonly number[], net: number): void {
    for (let k = 1; k < path.length; k++) {
        const [a, b] = [path[k - 1]!, path[k]!];
        const step = b - a;
        const [from, axis] = step === 1 || step === -1 ? [Math.min(a, b), 0] : [Math.min(a, b), 1];
        lat.heldBy[from * 2 + axis] = net;
    }
}

/** A binary heap, because a sorted array turns the search quadratic on exactly the sheets that need it. */
function heap(): { push: (state: number, cost: number) => void; pop: () => number; size: () => number } {
    const items: number[] = [];
    const costs: number[] = [];
    // Swapped through temporaries rather than destructuring: `[a, b] = [b, a]` builds two arrays every
    // time, and this runs millions of times on a busy sheet.
    const swap = (i: number, j: number): void => {
        const item = items[i]!;
        const cost = costs[i]!;
        items[i] = items[j]!;
        costs[i] = costs[j]!;
        items[j] = item;
        costs[j] = cost;
    };
    return {
        size: () => items.length,
        push: (state, cost) => {
            items.push(state);
            costs.push(cost);
            for (let i = items.length - 1; i > 0; ) {
                const p = (i - 1) >> 1;
                if (costs[p]! <= costs[i]!) break;
                swap(p, i);
                i = p;
            }
        },
        pop: () => {
            const top = items[0]!;
            const last = items.pop()!;
            const lastCost = costs.pop()!;
            if (items.length > 0) {
                items[0] = last;
                costs[0] = lastCost;
                for (let i = 0; ; ) {
                    const [l, r] = [2 * i + 1, 2 * i + 2];
                    let small = i;
                    if (l < items.length && costs[l]! < costs[small]!) small = l;
                    if (r < items.length && costs[r]! < costs[small]!) small = r;
                    if (small === i) break;
                    swap(small, i);
                    i = small;
                }
            }
            return top;
        },
    };
}

/**
 * A way across the lattice from one node to another, or nothing.
 *
 * A* with the arrival direction carried in the state, because a corner is only visible to something that
 * remembers which way it came. The heuristic never overestimates — it is the remaining distance plus a
 * corner when one is unavoidable — so the first time the goal is taken off the queue, it is by a best path.
 */
export function findPath(lat: Lattice, from: number, to: number, net: number): number[] | null {
    if (from < 0 || to < 0 || from === to) return from >= 0 && from === to ? [from] : null;
    if (lat.solid[from] === 1 || lat.solid[to] === 1) return null;
    if (lat.terminal[from] !== 0 && lat.terminal[from] !== net) return null;
    if (lat.terminal[to] !== 0 && lat.terminal[to] !== net) return null;

    const { cols, rows } = lat;
    // The ladder that makes the comparison lexicographic instead of a trade. Each rung is set to one more
    // than the most its lower rungs can ever total, so a path with fewer corners beats any path with more,
    // whatever the lengths — and no weight was chosen by anybody.
    const GRAZE = cols * rows + 1;
    const TURN = GRAZE * (cols * rows + 1);

    for (const inflate of WINDOWS) {
        const { path, clipped } = search(lat, from, to, net, { TURN, GRAZE }, inflate);
        if (path) return path;
        // The window only matters if it actually cut something off. When the search already had the whole
        // sheet to work with and found nothing, there is nothing a wider window could reach, and running it
        // again is pure cost on exactly the wires that are already the slowest.
        if (!clipped) return null;
    }
    return null;
}

function search(
    lat: Lattice,
    from: number,
    to: number,
    net: number,
    cost: { TURN: number; GRAZE: number },
    inflate: number,
): { path: number[] | null; clipped: boolean } {
    const { TURN } = cost;
    const { cols, rows, solid, walled, grazing, heldBy, terminal } = lat;
    const [fi, fj] = [from % cols, Math.floor(from / cols)];
    const [ti, tj] = [to % cols, Math.floor(to / cols)];

    // The window: the two ends, opened out far enough to go around whatever is between them.
    const i0 = Math.max(0, Math.min(fi, ti) - inflate);
    const i1 = Math.min(cols - 1, Math.max(fi, ti) + inflate);
    const j0 = Math.max(0, Math.min(fj, tj) - inflate);
    const j1 = Math.min(rows - 1, Math.max(fj, tj) + inflate);
    const clipped = i0 > 0 || j0 > 0 || i1 < cols - 1 || j1 < rows - 1;

    const STATES = 5;
    const { best, cameFrom, stamp } = lat.scratch;
    const gen = ++lat.scratch.generation;
    const costOf = (state: number): number => (stamp[state] === gen ? best[state]! : Infinity);
    const queue = heap();

    /**
     * What is left to pay, never more than the truth.
     *
     * The remaining distance, plus one corner when one is unavoidable — off both axes, or already travelling
     * the wrong way along the only axis that matters. That corner term is what makes the search quick: a
     * corner outranks any length, so knowing one is still owed rules out whole regions before they are
     * explored. It stays a lower bound, so the first path taken off the queue is still a best one.
     */
    const heuristic = (node: number, dir: number): number => {
        const ni = node % cols;
        const nj = (node - ni) / cols;
        const di = ni < ti ? ti - ni : ni - ti;
        const dj = nj < tj ? tj - nj : nj - tj;
        let turns = 0;
        if (di !== 0 && dj !== 0) turns = 1;
        else if (di !== 0 || dj !== 0) {
            const along = di !== 0 ? (ni < ti ? 0 : 2) : nj < tj ? 1 : 3;
            if (dir !== 4 && dir !== along) turns = 1;
        }
        return di + dj + turns * TURN;
    };

    const startState = from * STATES + 4;
    best[startState] = 0;
    stamp[startState] = gen;
    cameFrom[startState] = -1;
    queue.push(startState, heuristic(from, 4));

    while (queue.size() > 0) {
        const state = queue.pop();
        const dir = state % STATES;
        const node = (state - dir) / STATES;
        const g = costOf(state);
        if (node === to) return { path: unwind(cameFrom, state, STATES), clipped };

        const ci = node % cols;
        const cj = (node - ci) / cols;
        for (let d = 0; d < 4; d++) {
            const di = DIRS[d]![0];
            const dj = DIRS[d]![1];
            const ni = ci + di;
            const nj = cj + dj;
            if (ni < i0 || ni > i1 || nj < j0 || nj > j1) continue;
            const next = nj * cols + ni;
            if (solid[next] === 1) continue;
            // Another net's terminal. Reaching it would draw a wire that ends on someone else's pin, which
            // on paper is a connection — the one thing this whole module exists to prevent.
            if (terminal[next] !== 0 && terminal[next] !== net) continue;

            const axis = di !== 0 ? 0 : 1;
            const edge = (di === 1 || dj === 1 ? node : next) * 2 + axis;
            if (walled[edge] === 1) continue;
            // Already drawn along by somebody else. Two wires on one line are one wire to a reader.
            if (heldBy[edge] !== 0 && heldBy[edge] !== net) continue;

            const step = g + 1 + (grazing[edge] === 1 ? cost.GRAZE : 0) + (dir !== 4 && dir !== d ? TURN : 0);
            const nextState = next * STATES + d;
            if (step >= costOf(nextState)) continue;
            best[nextState] = step;
            stamp[nextState] = gen;
            cameFrom[nextState] = state;
            queue.push(nextState, step + heuristic(next, d));
        }
    }
    return { path: null, clipped };
}

function unwind(cameFrom: Int32Array, state: number, STATES: number): number[] {
    const nodes: number[] = [];
    for (let s = state; s >= 0; s = cameFrom[s]!) nodes.push(Math.floor(s / STATES));
    return nodes.reverse();
}
