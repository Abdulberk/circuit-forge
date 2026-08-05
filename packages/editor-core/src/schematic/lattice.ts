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
 * So the lanes are not enumerated, they are SEARCHED. Every point where wires may run is a node, every hop
 * between neighbouring points is an edge, and a wire is a path. What the drawing may not say becomes simply
 * what the path may not use:
 *
 *   - a point inside a symbol is not a place a wire can be
 *   - a point holding another net's terminal is not one either, because a wire that reaches it states a
 *     connection the netlist does not have
 *   - a hop another net has drawn along is taken, because two wires on one line are drawn as one wire
 *   - a point another net's wire TURNS at or ENDS at is taken, and one it merely passes through is open to
 *     a wire crossing the other way — the X a reader knows means "these pass without meeting"
 *
 * That last rule was missing at first and it mattered more than any of the others. With only hops guarded,
 * two nets could meet at one node and carry on in the same direction: no hop shared, and the drawing shows
 * ONE unbroken line joining terminals that are not one node. On this module's own generated sheets that
 * happened seven hundred and twelve times across a hundred and ninety-five sheets of three hundred, with
 * nothing refused and nothing reported. The same gap let a wire STOP on another net's wire, which is a T,
 * and a T is the plainest connection the notation has.
 *
 * THE COST HAS NO TUNING CONSTANT. A reader wants few corners first, then short wires, and — only between
 * two wires that are equal in both — the one that does not run along a symbol's edge. That order is exact
 * rather than a trade, so the cost is a ladder: each rung is set past anything the rungs below it can total,
 * which makes the comparison lexicographic by construction. Nobody picks a weight.
 *
 * THE ORDER OF THE LOWER TWO RUNGS IS NOT A DETAIL. Ranking grazing ABOVE length says a wire should take a
 * detour of any length rather than pass along one symbol's edge, and a search told that will go looking for
 * one: a single grazing hop then costs more than the longest route on the sheet, so A* explores everything
 * cheaper than that before it will accept it. On a four-hundred-part sheet it made routing eleven times
 * slower and changed not one wire. Grazing belongs where it can only settle a tie — which is the case it was
 * put there for, two elbows between the same pair of terminals, identical in corners and in length.
 *
 * THE WHOLE WIRE IS SEARCHED, terminal to terminal. It used to run between the ESCAPE points, with the two
 * short stubs from each terminal attached afterwards — which put the first and last corner of every wire
 * outside the cost model. Eighteen percent of wires were then drawn with more corners than were available,
 * and two hundred of fourteen hundred doubled back over their own terminal, because a reversal at an
 * unscored corner costs nothing. The escape is now the FIRST STEP of the path rather than a prefix to it.
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
 * The largest lattice this module will build, in nodes.
 *
 * A HARD CEILING, because the alternative is a crash inside a render. Stored positions are ordinary user
 * data — a part dragged a long way, or a document written by something else — and the lattice spans
 * whatever it is given, at about a hundred bytes a node. A position of forty thousand produced a four
 * thousand square lattice and one and a half gigabytes; sixty thousand threw `RangeError: Array buffer
 * allocation failed` from inside the component, and since the position is persisted, it threw again on
 * every reopen. Four million nodes is roughly four hundred megabytes and far past any real schematic; past
 * it, `buildLattice` returns null and every wire falls back to a diagonal and SAYS so.
 */
const MAX_NODES = 4_000_000;

/**
 * How far a search may look.
 *
 * A BOUND ON WORK, and — said plainly, because the first version of this comment denied it — A BOUND ON
 * QUALITY TOO. A window that clips the sheet can hide the route with fewest corners behind its edge, and
 * when the narrow pass finds a route, that route is taken. So a wire is occasionally drawn with a corner or
 * two more than the sheet actually allowed.
 *
 * That is a deliberate trade with a measured price on both sides. Closing it — running the wider search
 * whenever the narrow window was clipped and keeping the better answer — cost ELEVEN TIMES the routing time
 * on a four-hundred-part sheet and changed not one wire on it. Across three hundred generated sheets it
 * improved three wires of about seven thousand, from five corners to three, and on the circuits this product
 * actually draws it improved none. The wires are still legible and still truthful; they are, rarely, not the
 * tidiest available.
 *
 * When the narrow pass finds NOTHING the wider one runs, because the difference there is between a wire and
 * no wire. And an UNCLIPPED window ends the matter either way: there was nothing outside it to miss.
 */
const WINDOWS = [24, 120];

/** What a wire did at a node: passed straight across, straight up and down, or turned/ended there. */
export const Mode = {
    Free: 0,
    Across: 1,
    UpDown: 2,
    /** Turned or ended — no second conductor could be told apart here, so the node is closed to everyone. */
    Closed: 3,
} as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

export interface Lattice {
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
     * Legible — a wire down the side of a part reads correctly — but a wire that appears to be touching a
     * symbol it has nothing to do with is a worse drawing than one that keeps clear. Allowed and preferred
     * against, which is why it is a cost and not a wall: forbidding it would make narrow gaps impassable.
     */
    grazing: Uint8Array;
    /** Which net holds each hop, or 0 for free. Net numbers start at 1 so that 0 can mean nobody. */
    heldBy: Int32Array;
    /** Which net's wire touches each node, and `nodeMode` says what it did there. */
    nodeNet: Int32Array;
    nodeMode: Uint8Array;
    /** Which net's terminal sits on each node, or 0. A node held by another net is closed to this one. */
    terminal: Int32Array;
    /**
     * The search's own workspace, allocated ONCE for the sheet rather than once per wire.
     *
     * Five entries per node: a wire arriving from each of four directions, plus the start, which has come
     * from nowhere. Allocated inside the search, a twelve-part sheet cost a hundred and seventy kilobytes
     * per wire, and a sheet is thousands of wires — handing the same buffers back is most of the difference
     * between a schematic that redraws while you drag and one that stutters.
     *
     * `stamp` is what makes reuse safe. A slot whose stamp is not the current search's is unset, so nothing
     * has to be cleared between wires; clearing would have put the cost straight back.
     */
    scratch: { best: Float64Array; cameFrom: Int32Array; stamp: Int32Array; generation: number };
}

/**
 * Builds the space once for the whole sheet, or nothing if the sheet is too large to hold.
 *
 * Everything static — where the symbols are, which hops they block — is computed here rather than per wire,
 * because it does not change while a sheet is being routed and recomputing it eight hundred times is eight
 * hundred times the work for the same answer.
 *
 * THE SPAN COMES FROM THE CONTENT, not from the origin. It used to be forced to include (0, 0), so a
 * drawing that happened to sit far from the origin allocated a lattice proportional to that distance
 * squared: the same hundred-unit drawing took 361 nodes at the origin and 1,038,361 nodes at ten thousand —
 * 2876 times the memory for an identical picture.
 */
export function buildLattice(
    bodies: readonly LatticeBox[],
    points: readonly { x: number; y: number }[],
): Lattice | null {
    if (bodies.length === 0 && points.length === 0) return null;

    const xs = [...bodies.flatMap((b) => [b.minX, b.maxX]), ...points.map((p) => p.x)];
    const ys = [...bodies.flatMap((b) => [b.minY, b.maxY]), ...points.map((p) => p.y)];
    if (!xs.every(Number.isFinite) || !ys.every(Number.isFinite)) return null;

    const floorTo = (v: number): number => Math.floor(v / PIN_GRID) * PIN_GRID;
    const ceilTo = (v: number): number => Math.ceil(v / PIN_GRID) * PIN_GRID;

    const originX = floorTo(Math.min(...xs)) - RING * PIN_GRID;
    const originY = floorTo(Math.min(...ys)) - RING * PIN_GRID;
    const cols = (ceilTo(Math.max(...xs)) - originX) / PIN_GRID + RING + 1;
    const rows = (ceilTo(Math.max(...ys)) - originY) / PIN_GRID + RING + 1;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols * rows > MAX_NODES) return null;

    const solid = new Uint8Array(cols * rows);
    const walled = new Uint8Array(cols * rows * 2);
    const grazing = new Uint8Array(cols * rows * 2);
    const heldBy = new Int32Array(cols * rows * 2);
    const nodeNet = new Int32Array(cols * rows);
    const nodeMode = new Uint8Array(cols * rows);
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

        // Hops that would pass through the symbol, and hops that run along its edge.
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
        nodeNet,
        nodeMode,
        terminal,
        scratch: {
            best: new Float64Array(cols * rows * 5),
            cameFrom: new Int32Array(cols * rows * 5),
            stamp: new Int32Array(cols * rows * 5),
            generation: 0,
        },
    };
}

/** Which way a hop between two adjacent nodes runs: 0 across, 1 up and down. */
const axisOf = (a: number, b: number): 0 | 1 => (b - a === 1 || b - a === -1 ? 0 : 1);

/**
 * Records what a finished wire occupies: the hops it drew along, and what it did at every node it touched.
 *
 * The node half is what stops the next net abutting against this one or stopping on top of it. A node this
 * wire merely passed straight through stays open to a wire crossing the other way; a node where it turned or
 * ended is closed, because there is no second conductor a reader could tell apart there.
 *
 * Takes the DRAWN path rather than the searched one, so a wire that fell back to a diagonal still occupies
 * whatever of it lies on the lattice. Missing that let a later net be told "no orthogonal route exists" when
 * the truth was that this wire had taken the lane and never said so.
 */
export function hold(lat: Lattice, path: readonly number[], net: number): void {
    const mark = (node: number, mode: Mode): void => {
        if (lat.nodeNet[node] === 0) {
            lat.nodeNet[node] = net;
            lat.nodeMode[node] = mode;
            return;
        }
        // Anything beyond a single straight pass — the same net back again on the other axis, or a second
        // net crossing — leaves no axis free, so the node closes.
        if (lat.nodeNet[node] !== net || lat.nodeMode[node] !== mode) lat.nodeMode[node] = Mode.Closed;
    };

    for (let k = 1; k < path.length; k++) {
        const [a, b] = [path[k - 1]!, path[k]!];
        if (Math.abs(b - a) !== 1 && Math.abs(b - a) !== lat.cols) continue; // not a single hop: not ours to hold
        const axis = axisOf(a, b);
        lat.heldBy[Math.min(a, b) * 2 + axis] = net;

        const before = k > 1 ? axisOf(path[k - 2]!, a) : null;
        if (k === 1)
            mark(a, Mode.Closed); // a conductor stops here
        else mark(a, before === axis ? (axis === 0 ? Mode.Across : Mode.UpDown) : Mode.Closed);
        if (k === path.length - 1) mark(b, Mode.Closed);
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

/** Where a wire starts and stops, and which way it must leave and arrive. */
export interface Anchor {
    node: number;
    /** Index into DIRS: the direction the wire must travel on its first (or last) step. */
    dir: number;
}

export const dirIndex = (dx: number, dy: number): number =>
    DIRS.findIndex(([ax, ay]) => ax === Math.sign(dx) && ay === Math.sign(dy));

/**
 * A way across the lattice from one terminal to another, or nothing.
 *
 * A* with the arrival direction carried in the state, because a corner is only visible to something that
 * remembers which way it came. The heuristic never overestimates — the remaining distance, plus a corner
 * when one is unavoidable — so the first time the goal state is taken off the queue, it is by a best path.
 *
 * The whole wire is inside the search, including the step out of each terminal: the start is charged as one
 * step in the terminal's own direction, and only a path ARRIVING at the far terminal along that terminal's
 * own direction counts as done. Both stubs are therefore scored like any other part of the wire.
 */
export function findPath(lat: Lattice, from: Anchor, to: Anchor, net: number): number[] | null {
    if (from.node < 0 || to.node < 0 || from.dir < 0 || to.dir < 0) return null;
    if (from.node === to.node) return null;
    if (lat.solid[from.node] === 1 || lat.solid[to.node] === 1) return null;
    for (const end of [from.node, to.node]) {
        if (lat.terminal[end] !== 0 && lat.terminal[end] !== net) return null;
        // A wire STOPS at its terminals, so those nodes must be free of anyone else however they pass.
        if (lat.nodeNet[end] !== 0 && lat.nodeNet[end] !== net) return null;
    }

    // The ladder. A grazing hop counts one; a step counts more than every hop of the longest path could
    // graze; a corner counts more than the longest path could cost in steps. Lexicographic by construction.
    //
    // The length bound is the state count — a best path never revisits a (node, direction) pair, so it
    // cannot be longer than that — which keeps every cost an exact integer well inside what a double holds.
    const LIMIT = boundOn(lat, from, to);
    const STEP = LIMIT + 1;
    const TURN = STEP * (LIMIT + 1);

    let bestPath: number[] | null = null;
    let bestCost = Infinity;
    for (const inflate of WINDOWS) {
        const found = search(lat, from, to, net, { TURN, STEP }, inflate);
        if (found.path && found.cost < bestCost) {
            bestPath = found.path;
            bestCost = found.cost;
        }
        // An UNCLIPPED window saw the whole sheet: whatever it concluded is final, found or not.
        if (!found.clipped) break;
        // A route was found. It may not be the tidiest one on the sheet — see the note on WINDOWS above,
        // where that trade is measured on both sides — but it is legible and true, and looking for a better
        // one costs eleven times the routing for changes measured in single wires per thousand.
        if (found.path) break;
    }
    return bestPath;
}

function search(
    lat: Lattice,
    from: Anchor,
    to: Anchor,
    net: number,
    cost: { TURN: number; STEP: number },
    inflate: number,
): { path: number[] | null; cost: number; ideal: number; clipped: boolean } {
    const { TURN } = cost;
    const { cols, rows, solid, walled, grazing, heldBy, terminal, nodeNet, nodeMode } = lat;
    const [fi, fj] = [from.node % cols, Math.floor(from.node / cols)];
    const [ti, tj] = [to.node % cols, Math.floor(to.node / cols)];

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
     * the wrong way along the only axis that matters, or lined up but facing the wrong way to arrive as the
     * far terminal requires. That corner term is what makes the search quick: a corner outranks any length,
     * so knowing one is still owed rules out whole regions before they are explored.
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
            if (dir !== along) turns = 1;
            else if (along !== to.dir) turns = 1; // lined up, but not the way the far terminal must be met
        }
        return (di + dj) * cost.STEP + turns * TURN;
    };

    // The FIRST STEP is the wire leaving its terminal, charged like any other step rather than bolted on
    // afterwards. Nothing is seeded at the terminal itself: the wire cannot leave any other way.
    const [sdx, sdy] = DIRS[from.dir]!;
    const firstNode = from.node + sdx + sdy * cols;
    const fni = firstNode % cols;
    const fnj = (firstNode - fni) / cols;
    if (fni < i0 || fni > i1 || fnj < j0 || fnj > j1) return { path: null, cost: Infinity, ideal: 0, clipped };
    if (solid[firstNode] === 1) return { path: null, cost: Infinity, ideal: 0, clipped };
    if (terminal[firstNode] !== 0 && terminal[firstNode] !== net)
        return { path: null, cost: Infinity, ideal: 0, clipped };
    const firstEdge = (from.dir === 0 || from.dir === 1 ? from.node : firstNode) * 2 + (from.dir % 2 === 0 ? 0 : 1);
    if (walled[firstEdge] === 1) return { path: null, cost: Infinity, ideal: 0, clipped };
    if (heldBy[firstEdge] !== 0 && heldBy[firstEdge] !== net) return { path: null, cost: Infinity, ideal: 0, clipped };

    // The goal state: at the far terminal, having arrived the way that terminal requires.
    const goalState = to.node * STATES + to.dir;

    const startState = firstNode * STATES + from.dir;
    best[startState] = cost.STEP + (grazing[firstEdge] === 1 ? 1 : 0);
    stamp[startState] = gen;
    cameFrom[startState] = from.node * STATES + 4;
    best[from.node * STATES + 4] = 0;
    stamp[from.node * STATES + 4] = gen;
    cameFrom[from.node * STATES + 4] = -1;
    // The least any route between these two terminals could possibly cost: one step out of the terminal
    // plus a heuristic that never overestimates. A path that matches it is provably best.
    const ideal = cost.STEP + heuristic(firstNode, from.dir);
    queue.push(startState, best[startState]! + heuristic(firstNode, from.dir));

    while (queue.size() > 0) {
        const state = queue.pop();
        if (state === goalState) return { path: unwind(cameFrom, state, STATES), cost: costOf(state), ideal, clipped };
        const dir = state % STATES;
        const node = (state - dir) / STATES;
        const g = costOf(state);
        // A terminal is where a wire STOPS. Passing through the destination and carrying on would draw a
        // spur beyond it — a stub of conductor belonging to no net, which where it lands on another wire
        // reads as a T. Seven percent of wires had one before the search knew its terminals.
        if (node === to.node) continue;

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
            if (terminal[next] !== 0 && terminal[next] !== net) continue;
            // A wire STOPS at BOTH its terminals. Re-entering the one it started from draws the same spur
            // as running past the one it is heading for, only mirrored.
            if (next === from.node) continue;
            // MAY THIS WIRE TRAVEL THROUGH THE NODE IT IS LEAVING? Free nodes and its own always. Somebody
            // else's only by going straight across on the axis they left open — the one crossing a reader
            // will not misread. Written out here rather than called, because it runs on every edge of every
            // expansion and the indirection showed up in the measurement.
            const owner = nodeNet[node]!;
            if (owner !== 0 && owner !== net) {
                if (dir !== d) continue; // turning here would draw a corner on somebody else's wire
                if (nodeMode[node] !== (d === 0 || d === 2 ? Mode.UpDown : Mode.Across)) continue;
            }

            const axis = di !== 0 ? 0 : 1;
            const edge = (di === 1 || dj === 1 ? node : next) * 2 + axis;
            if (walled[edge] === 1) continue;
            if (heldBy[edge] !== 0 && heldBy[edge] !== net) continue;

            const step = g + cost.STEP + (grazing[edge] === 1 ? 1 : 0) + (dir !== d ? TURN : 0);
            const nextState = next * STATES + d;
            if (step >= costOf(nextState)) continue;
            best[nextState] = step;
            stamp[nextState] = gen;
            cameFrom[nextState] = state;
            queue.push(nextState, step + heuristic(next, d));
        }
    }
    return { path: null, cost: Infinity, ideal, clipped };
}

function unwind(cameFrom: Int32Array, state: number, STATES: number): number[] {
    const nodes: number[] = [];
    for (let s = state; s >= 0; s = cameFrom[s]!) nodes.push(Math.floor(s / STATES));
    return nodes.reverse();
}

/**
 * An upper bound on how long a best path between these two terminals can be, in steps.
 *
 * A best path never returns to a (node, direction) it has already been in — doing so would be a strictly
 * more expensive way of reaching the same state — so its length is bounded by the number of such states.
 * That is what keeps the cost ladder exact: every rung is derived from this, so the whole cost stays a whole
 * number a double represents exactly, and no comparison ever comes down to rounding.
 */
function boundOn(lat: Lattice, from: Anchor, to: Anchor): number {
    void from;
    void to;
    return lat.cols * lat.rows * 4;
}
