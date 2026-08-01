/**
 * How much current is in each piece of copper, and which way it is going.
 *
 * WHY THIS IS NOT A GUESS. A net's voltage is one number for the whole net — colouring copper by it says
 * nothing about flow. Current is different: it is per BRANCH, it has a direction, and on a real board it
 * divides at every junction. Showing "flow" by animating every trace at the same speed would be an
 * illustration, not a measurement, and this product's whole claim is the difference between those.
 *
 * THE PHYSICS WE ACTUALLY USE. Kirchhoff's current law: at any point, current in equals current out. If
 * the copper of one net forms a TREE (no loops — which is what a router produces, since a loop is wasted
 * copper), then cutting any single edge splits the net in two, and the current in that edge is exactly the
 * sum of the pad currents on one side. No resistances needed, no approximation. That is an identity, not a
 * model.
 *
 * WHERE IT STOPS, OUT LOUD:
 *   • ngspice has no branch-current vector for a diode, BJT, MOSFET or subckt. Those pads inject an
 *     UNKNOWN current, so every edge whose split depends on one is marked unresolved and drawn without
 *     flow — never with a plausible-looking zero.
 *   • If a net's copper contains a loop, the division between the parallel paths depends on the copper's
 *     own resistance, which the simulation never modelled. Also unresolved.
 *
 * PURE — no three.js, no React. Returns plain typed arrays.
 */

export interface Pad {
    componentId: string;
    /** tscircuit's own pad name (`pin1`) — NOT the join key; see `sourcePin`. */
    pin: string | null;
    /** OUR authored pinId (`'1'`, `'+'`, `'anode'`), delivered by pcb-core. Null on an NC footprint pad
     *  that no pin was ever connected to, which is an honest null rather than a guess. */
    sourcePin: string | null;
    net: string;
    x: number;
    y: number;
}

export interface FlowSegment {
    layer: string;
    widthMm: number;
    points: Array<{ x: number; y: number }>;
}
export interface FlowTrace {
    net: string | null;
    segments: FlowSegment[];
}

/** What the simulator could tell us about one device's current, from `sim.json`'s `branchCurrents`. */
export interface BranchCurrent {
    /** The series name in the result (`i(v1)` or `@r1[i]`). */
    series: string;
    /** SPICE's positive direction enters this pin of the device and leaves `outOfPin`. Both are OUR
     *  authored pinIds, matching the `sourcePin` every pad carries. */
    intoPin: string;
    outOfPin: string;
}

export interface FlowTable {
    /** frames × edges, row-major. Amps, signed: positive means "along the edge's own point order". */
    values: Float32Array;
    edges: number;
    /** Largest |current| anywhere, for scaling the display. 0 when nothing resolved. */
    peak: number;
    /** Edge index per QUAD emitted by the copper mesh, in the same order it emits them. −1 = unresolved. */
    edgeOfQuad: Int32Array;
    /** Distance along its own trace, in mm, at the START of each quad — the phase the dash pattern rides. */
    distOfQuad: Float32Array;
    /** Run-wide peak |current| per edge, in amps. The TIER is derived from this and is STATIC for the
     *  whole run: tiering on the instantaneous value makes hue and head size strobe as an AC waveform
     *  sweeps decades, and a trace momentarily at 0 A should still advertise the class of current it
     *  carries at other times. */
    peakOfEdge: Float32Array;
    /**
     * frames × edges. Signed accumulated TOKEN COUNT — the integral of (rate × sign) over displayed time.
     *
     * Dimensionless and therefore camera-independent, so it is baked here once instead of integrated in
     * the frame loop where a dropped frame would desynchronise the pattern permanently. A pulse's position
     * is `fract(dist/period − phi)`, so this is the only thing that moves.
     */
    phase: Float32Array;
    /**
     * frames × edges. Comet↔disc morph, 0 = a stationary symmetric disc, 1 = a directional comet.
     *
     * A directional glyph at near-zero velocity has an ill-defined orientation and jitters, so Jobard et
     * al. morph arrows to discs. The window has to be WIDE: on our displayed cycle a mantissa below 0.15
     * spans about 48 ms, under the ~200 ms a viewer needs to read something as a transition, so it would
     * flicker. `smoothstep(0.02, 0.60, m)` spans about 190 ms. A measured zero must still look MEASURED —
     * it keeps its tier hue and halo — because the only thing distinguishing it from an unmeasured branch
     * would otherwise be that both are motionless.
     */
    morph: Float32Array;
    /** Components whose current the simulator cannot report, so their pads inject an unknown. */
    unresolvedBy: string[];
    /** Nets whose copper could not be solved, with why. Disclosed, never silently still. */
    unresolvedNets: Array<{ net: string; reason: 'loop' | 'unknown-pad-current' | 'no-pads' }>;
}

const key = (x: number, y: number): string => `${x.toFixed(3)},${y.toFixed(3)}`;

/**
 * Decade boundaries in ABSOLUTE amps — never the board's own min/max.
 *
 * Normalising to the board's peak is the standard mistake and it has a name: van Wijk reports it "gives
 * poor results", and Altium's PDN scale is documented as percentage-of-max, which is exactly why a healthy
 * board and a failing one render identically there. On our own rectifier it would map a 20 µA branch to
 * visually zero next to a 215 mA one. Absolute anchors also make two different boards comparable.
 */
export const DECADE_FLOORS = [1e-5, 1e-4, 1e-3, 1e-2, 1e-1] as const; // 10 µA … 100 mA, tiers 1..5

/** Tier from a run-wide peak, 0 = below 10 µA, 5 = 100 mA and above. */
export function tierOf(peakAbs: number): number {
    let t = 0;
    for (let i = 0; i < DECADE_FLOORS.length; i++) if (peakAbs >= DECADE_FLOORS[i]!) t = i + 1;
    return t;
}

/**
 * Flux rate in tokens per second of DISPLAYED time.
 *
 * `0.4 · mantissa` makes one decade of mantissa map to exactly one decade of rate, so flux is proportional
 * to current EXACTLY within a tier rather than approximately. The 4 Hz ceiling is 40% of the ~10 Hz
 * continuous wagon-wheel peak, so the highest-current trace can never read as flowing backwards. The clamp
 * is a guard only: a mantissa is < 10 by construction, so it cannot silently saturate inside 10 µA…1 A.
 */
export const fluxRate = (amps: number, floor: number): number =>
    Math.min(4, Math.max(0, 0.4 * (Math.abs(amps) / floor)));

/** GLSL's smoothstep, so the baked morph and any shader-side use agree exactly. */
const smoothstep = (a: number, b: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-9)));
    return t * t * (3 - 2 * t);
};

/**
 * Current flowing from a component INTO the net's copper at one pad.
 *
 * SPICE reports a two-terminal device's current as flowing INTO its first node — so at pin 1 the device
 * REMOVES that current from the copper, and at pin 2 it returns it. Getting this sign backwards would draw
 * every arrow the wrong way while looking entirely convincing, so it is stated once, here.
 */
function padSign(pad: Pad, branch: BranchCurrent): number | null {
    if (pad.sourcePin === null) return null; // an NC pad, or one pcb-core could not identify
    if (pad.sourcePin === branch.intoPin) return -1;
    if (pad.sourcePin === branch.outOfPin) return +1;
    // A pad whose pin is neither terminal of a two-terminal device: the two sides disagree about the part.
    // Refuse rather than pick one — a wrong sign draws every arrow backwards, convincingly.
    return null;
}

interface Edge {
    a: number; // node index at the segment's first point
    b: number; // node index at the second
    quad: number; // which emitted quad this is
}

/**
 * Solve one net's copper.
 *
 * Nodes are geometric points (pads and every polyline vertex, snapped to a micron). Edges are the
 * consecutive point pairs — the same pairs the mesh builder turns into quads, so an edge index and a quad
 * index line up by construction.
 */
function solveNet(
    edges: Edge[],
    nodeCount: number,
    padCurrentByNode: Map<number, number[] | null>,
    frames: number,
): { perEdge: Array<Float32Array | null>; reason: 'loop' | 'unknown-pad-current' | null } {
    // A tree over n nodes has exactly n−1 edges. More means a loop, and the division between parallel
    // paths depends on copper resistance nobody simulated.
    if (edges.length > nodeCount - 1) return { perEdge: edges.map(() => null), reason: 'loop' };
    for (const v of padCurrentByNode.values()) {
        if (v === null) return { perEdge: edges.map(() => null), reason: 'unknown-pad-current' };
    }

    const adj: Array<Array<{ to: number; edge: number; forward: boolean }>> = Array.from({ length: nodeCount }, () => []);
    edges.forEach((e, i) => {
        adj[e.a]!.push({ to: e.b, edge: i, forward: true });
        adj[e.b]!.push({ to: e.a, edge: i, forward: false });
    });

    const perEdge: Array<Float32Array | null> = edges.map(() => null);
    const seen = new Uint8Array(nodeCount);
    const parentOf = new Int32Array(nodeCount).fill(-1);
    const parentEdgeOf = new Int32Array(nodeCount).fill(-1);
    // Did the traversal walk this edge along its own point order? The current a node hands up flows toward
    // its parent, i.e. AGAINST that direction — one sign, decided once.
    const parentForward = new Uint8Array(nodeCount);
    const acc: Array<Float32Array | null> = new Array(nodeCount).fill(null);

    // Post-order accumulation: the current in the edge above a node is the sum of every pad current in that
    // node's subtree. Iterative, because a routed trace is a long chain and recursion would blow the stack
    // on a real board.
    for (let root = 0; root < nodeCount; root++) {
        if (seen[root] || adj[root]!.length === 0) continue;
        const order: number[] = [];
        const stack = [root];
        seen[root] = 1;
        while (stack.length) {
            const node = stack.pop()!;
            order.push(node);
            for (const nb of adj[node]!) {
                if (seen[nb.to]) continue;
                seen[nb.to] = 1;
                parentOf[nb.to] = node;
                parentEdgeOf[nb.to] = nb.edge;
                parentForward[nb.to] = nb.forward ? 1 : 0;
                stack.push(nb.to);
            }
        }
        for (let i = order.length - 1; i >= 0; i--) {
            const node = order[i]!;
            const sum = acc[node] ?? new Float32Array(frames);
            const own = padCurrentByNode.get(node);
            if (own) for (let f = 0; f < frames; f++) sum[f]! += own[f]!;
            acc[node] = sum;
            const pe = parentEdgeOf[node]!;
            if (pe < 0) continue;
            const signed = new Float32Array(frames);
            // Walking parent→node was `forward` along the edge; the flow node→parent is the opposite.
            const s = parentForward[node] ? -1 : 1;
            for (let f = 0; f < frames; f++) signed[f] = s * sum[f]!;
            perEdge[pe] = signed;
            const p = parentOf[node]!;
            const pacc = acc[p] ?? new Float32Array(frames);
            for (let f = 0; f < frames; f++) pacc[f]! += sum[f]!;
            acc[p] = pacc;
        }
    }
    return { perEdge, reason: null };
}

/**
 * Build the per-edge current table for a whole board.
 *
 * `padCurrent(designator, frame)` returns the device's branch current at that frame, or null when the
 * simulator has no vector for it.
 */
export function buildFlow(
    pads: Pad[],
    traces: FlowTrace[],
    netIndexByName: Map<string, number>,
    branchCurrents: Record<string, BranchCurrent>,
    seriesAt: (series: string) => Float32Array | null,
    componentDesignatorById: Map<string, string>,
    frames: number,
    /** Wall-clock seconds one pass over the run takes — the timebase the flux rate and the morph's 200 ms
     *  slew are expressed in, since both are about what a VIEWER perceives, not about simulated time. */
    displaySeconds: number,
): FlowTable {
    // Quads are emitted in exactly the order the mesh builder walks: trace, segment, point pair — and the
    // same net filter. Any divergence here silently paints the wrong current on the wrong copper, so the
    // two walks are kept identical and this comment is the contract between them.
    const edgeOfQuad: number[] = [];
    const distOfQuad: number[] = [];
    const unresolvedBy = new Set<string>();
    const unresolvedNets: FlowTable['unresolvedNets'] = [];

    const nodeIdOf = new Map<string, number>();
    const nodeId = (x: number, y: number): number => {
        const k = key(x, y);
        let id = nodeIdOf.get(k);
        if (id === undefined) {
            id = nodeIdOf.size;
            nodeIdOf.set(k, id);
        }
        return id;
    };

    // Pad currents, per net, as full frame arrays (null = the simulator has no vector for that device).
    const padSeriesByNode = new Map<number, number[] | null>();
    for (const pad of pads) {
        const designator = componentDesignatorById.get(pad.componentId);
        const branch = designator ? branchCurrents[designator] : undefined;
        const node = nodeId(pad.x, pad.y);
        if (!designator || !branch) {
            if (designator) unresolvedBy.add(designator);
            padSeriesByNode.set(node, null);
            continue;
        }
        const data = seriesAt(branch.series);
        const sign = padSign(pad, branch);
        if (!data || sign === null) {
            unresolvedBy.add(designator);
            padSeriesByNode.set(node, null);
            continue;
        }
        const prev = padSeriesByNode.get(node);
        if (prev === null) continue; // already poisoned by an unknown pad on the same point
        const arr = prev ?? new Array<number>(frames).fill(0);
        for (let f = 0; f < frames; f++) arr[f]! += sign * data[f]!;
        padSeriesByNode.set(node, arr);
    }

    // Group edges by net so each net is solved on its own copper.
    const byNet = new Map<string, Edge[]>();
    const edgeLength: number[] = [];
    let quad = 0;
    for (const trace of traces) {
        if (!trace.net || !netIndexByName.has(trace.net)) continue; // mirrors the mesh builder's skip
        for (const seg of trace.segments) {
            for (let i = 0; i < seg.points.length - 1; i++) {
                const a = seg.points[i]!;
                const b = seg.points[i + 1]!;
                const len = Math.hypot(b.x - a.x, b.y - a.y);
                if (len === 0) continue; // the mesh builder skips these too
                const list = byNet.get(trace.net) ?? [];
                list.push({ a: nodeId(a.x, a.y), b: nodeId(b.x, b.y), quad });
                byNet.set(trace.net, list);
                edgeOfQuad.push(-1); // filled in after the solve
                distOfQuad.push(0); // real value comes from the tree walk below
                edgeLength.push(len);
                quad++;
            }
        }
    }

    /**
     * Distance along the CONDUCTOR, measured from each net's tree root.
     *
     * This used to reset to zero at the start of every segment, which is where the animation's phase comes
     * from — so a routed path that changed layer, or that the router emitted as several trace objects,
     * restarted its pulses mid-copper. The pattern jumped at a point where nothing electrical happens.
     *
     * Walking the same tree the current solve already builds fixes it for the whole NET at once, not just
     * within a trace: two trace objects that meet at a junction share one continuous phase. A junction is
     * still a discontinuity in the SPACING of pulses — which is correct, because that is where the current
     * divides — but not in their position.
     */
    function assignDistances(edges: Edge[], adjacency: Map<number, Array<{ to: number; edge: number }>>): void {
        const seen = new Set<number>();
        const distOfNode = new Map<number, number>();
        for (const seed of adjacency.keys()) {
            if (seen.has(seed)) continue;
            seen.add(seed);
            distOfNode.set(seed, 0);
            const stack = [seed];
            while (stack.length) {
                const node = stack.pop()!;
                for (const nb of adjacency.get(node) ?? []) {
                    if (seen.has(nb.to)) continue;
                    seen.add(nb.to);
                    const e = edges[nb.edge]!;
                    const d = (distOfNode.get(node) ?? 0) + edgeLength[e.quad]!;
                    distOfNode.set(nb.to, d);
                    // The quad's phase origin is its own start point, whichever end the walk entered from.
                    distOfQuad[e.quad] = e.a === node ? (distOfNode.get(node) ?? 0) : d;
                    stack.push(nb.to);
                }
            }
        }
    }

    const values: number[][] = [];
    for (const [net, edges] of byNet) {
        const nodes = new Set<number>();
        for (const e of edges) {
            nodes.add(e.a);
            nodes.add(e.b);
        }
        // Phase distance is assigned for EVERY net, solved or not: an unmeasured net draws no tokens but
        // still carries the static hatch, and a net whose solve fails must not fall back to a phase of 0
        // everywhere (which would look like a perfectly synchronised board).
        const adjacency = new Map<number, Array<{ to: number; edge: number }>>();
        edges.forEach((e, i) => {
            (adjacency.get(e.a) ?? adjacency.set(e.a, []).get(e.a)!).push({ to: e.b, edge: i });
            (adjacency.get(e.b) ?? adjacency.set(e.b, []).get(e.b)!).push({ to: e.a, edge: i });
        });
        assignDistances(edges, adjacency);

        // Re-index this net's nodes densely, and carry over only its own pad currents.
        const local = new Map<number, number>();
        for (const n of nodes) local.set(n, local.size);
        const localPads = new Map<number, number[] | null>();
        for (const n of nodes) {
            if (padSeriesByNode.has(n)) localPads.set(local.get(n)!, padSeriesByNode.get(n)!);
        }
        if (localPads.size === 0) {
            unresolvedNets.push({ net, reason: 'no-pads' });
            continue;
        }
        const { perEdge, reason } = solveNet(
            edges.map((e) => ({ a: local.get(e.a)!, b: local.get(e.b)!, quad: e.quad })),
            local.size,
            localPads,
            frames,
        );
        if (reason) {
            unresolvedNets.push({ net, reason });
            continue;
        }
        edges.forEach((e, i) => {
            const row = perEdge[i];
            if (!row) return;
            edgeOfQuad[e.quad] = values.length;
            values.push(Array.from(row));
        });
    }

    const edgeCount = values.length;
    const table = new Float32Array(frames * Math.max(edgeCount, 1));
    const peakOfEdge = new Float32Array(Math.max(edgeCount, 1));
    let peak = 0;
    for (let e = 0; e < edgeCount; e++) {
        const row = values[e]!;
        for (let f = 0; f < frames; f++) {
            const v = row[f]!;
            table[f * edgeCount + e] = v;
            const a = Math.abs(v);
            if (!Number.isFinite(a)) continue;
            if (a > peak) peak = a;
            if (a > peakOfEdge[e]!) peakOfEdge[e] = a;
        }
    }

    // ---- bake the two per-frame quantities the shader cannot derive.
    //
    // Phase is an INTEGRAL, so deriving it in the frame loop would let a dropped frame desynchronise the
    // pattern for the rest of the run. The morph needs 200 ms of history for its slew limiter, which a
    // stateless shader has no way to see at all.
    const phase = new Float32Array(frames * Math.max(edgeCount, 1));
    const morph = new Float32Array(frames * Math.max(edgeCount, 1));
    const dt = displaySeconds / Math.max(frames - 1, 1);
    // A 200 ms slew on the morph, expressed in frames of DISPLAYED time.
    const slewFrames = Math.max(1, Math.round(0.2 / Math.max(dt, 1e-6)));
    for (let e = 0; e < edgeCount; e++) {
        const floor = DECADE_FLOORS[Math.max(tierOf(peakOfEdge[e]!) - 1, 0)]!;
        let acc = 0;
        let m = 0;
        for (let f = 0; f < frames; f++) {
            const i = table[f * edgeCount + e]!;
            const rate = fluxRate(i, floor);
            acc += Math.sign(i) * rate * dt;
            phase[f * edgeCount + e] = acc;
            const target = smoothstep(0.02, 0.6, Math.abs(i) / floor);
            // Rate-limited toward the target so the glyph never snaps between comet and disc.
            m += Math.max(-1 / slewFrames, Math.min(1 / slewFrames, target - m));
            morph[f * edgeCount + e] = m;
        }
    }

    return {
        values: table,
        edges: edgeCount,
        peak,
        peakOfEdge,
        phase,
        morph,
        edgeOfQuad: Int32Array.from(edgeOfQuad),
        distOfQuad: Float32Array.from(distOfQuad),
        unresolvedBy: [...unresolvedBy].sort(),
        unresolvedNets,
    };
}
