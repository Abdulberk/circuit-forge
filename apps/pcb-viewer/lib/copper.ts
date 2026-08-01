/**
 * Copper geometry for the simulation overlay: every trace on the board as ONE mesh, with each vertex
 * carrying what the shader needs to answer two questions — what voltage is this net at, and what current
 * is in THIS piece of copper.
 *
 * WHY BUILD IT AT ALL. The exported GLB has copper as a single merged mesh per layer — there is no per-net
 * object to colour, and splitting the GLB by net is not possible from the outside. But `LayoutGeometry`
 * carries the exact polylines and widths, and the net each one belongs to. So the overlay is drawn from
 * the contract rather than reverse-engineered from the render.
 *
 * WHY ONE MESH. The values that change every frame are per-NET and per-EDGE, not per-vertex, so they
 * belong in textures the shader samples by index — not in per-object uniforms. That makes the whole board
 * one draw call whatever the net count, and the frame loop allocates nothing.
 *
 * PURE — no three.js. Returns plain typed arrays the renderer feeds into a BufferGeometry.
 */

export interface TraceSegment {
    layer: string;
    widthMm: number;
    points: Array<{ x: number; y: number }>;
}
export interface Trace {
    net: string | null;
    segments: TraceSegment[];
}

export interface CopperMesh {
    /** xyz per vertex, in BOARD millimetres (x right, y up-the-board, z = layer offset). */
    positions: Float32Array;
    /** Net index per vertex — the shader's lookup into the per-net voltage texture. */
    netIndex: Float32Array;
    /** Flow-table edge index per vertex, or −1 where the current was never measured. */
    edgeIndex: Float32Array;
    /** Millimetres along the CONDUCTOR at this vertex — the phase the pulse pattern rides. Continuous
     *  across segments and across the trace objects the router split one path into. */
    dist: Float32Array;
    /** −1/+1 across the ribbon, so the shader can shade the width without extra geometry. */
    side: Float32Array;
    /** Half the trace's real width, mm — the shader widens from this and floors it in screen pixels. */
    halfMm: Float32Array;
    /** Run-wide peak |current| on this edge, amps. −1 marks copper whose current is UNMEASURED, which is
     *  a categorically different state from zero and is drawn differently. */
    peakAbs: Float32Array;
    /** Unit transverse normal in board mm, for screen-space widening in the vertex stage. */
    normal: Float32Array;
    /** Triangle indices. */
    indices: Uint32Array;
    /** How many quads were emitted, for a sanity read at the call site. */
    quads: number;
}

/** Layer z-offsets in mm, so the two sides do not z-fight when both are drawn. */
const LAYER_Z: Record<string, number> = { top: 0.02, bottom: -0.02 };

/** The per-quad facts `buildFlow` produced, joined here by emission order. */
export interface CopperFlow {
    edgeOfQuad: Int32Array;
    distOfQuad: Float32Array;
    peakOfEdge: Float32Array;
}

/**
 * Ribbon a polyline: each consecutive pair of points becomes a quad of the trace's width.
 *
 * The walk here MUST match `buildFlow`'s exactly — same trace order, same segment order, the same skip of
 * zero-length pairs and of nets with no signal — because quad N here is edge N there. A divergence would
 * paint one trace's current onto another's copper, convincingly. The two loops are kept identical and this
 * comment is the contract between them.
 *
 * Deliberately NOT mitred at the corners. A mitre needs the turn angle and degenerates on a reversal, and
 * the overlay's job is to say which net this copper is and what is moving through it — a hairline notch on
 * the outside of a corner does not change that answer.
 */
export function buildCopperMesh(
    traces: Trace[],
    netIndexByName: Map<string, number>,
    flow?: CopperFlow,
): CopperMesh {
    const pos: number[] = [];
    const idx: number[] = [];
    const net: number[] = [];
    const edge: number[] = [];
    const dist: number[] = [];
    const side: number[] = [];
    const half: number[] = [];
    const peak: number[] = [];
    const norm: number[] = [];
    let quads = 0;

    for (const trace of traces) {
        if (!trace.net) continue; // no net: nothing honest to colour it with
        const n = netIndexByName.get(trace.net);
        if (n === undefined) continue; // no simulation signal for this net — the caller discloses it
        for (const seg of trace.segments) {
            const z = LAYER_Z[seg.layer] ?? 0;
            const halfMm = Math.max(seg.widthMm, 0.05) / 2;
            for (let i = 0; i < seg.points.length - 1; i++) {
                const a = seg.points[i]!;
                const b = seg.points[i + 1]!;
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const len = Math.hypot(dx, dy);
                if (len === 0) continue; // a repeated point has no direction to offset along
                const nx = -dy / len;
                const ny = dx / len;

                const e = flow ? (flow.edgeOfQuad[quads] ?? -1) : -1;
                // −1 is the UNMEASURED sentinel and it must survive as a distinct value rather than
                // collapsing to "0 A": a branch nobody could measure and a branch measured at zero are
                // different facts, and the shader draws them differently.
                const pk = e >= 0 && flow ? (flow.peakOfEdge[e] ?? -1) : -1;
                const d0 = flow ? (flow.distOfQuad[quads] ?? 0) : 0;

                const base = pos.length / 3;
                pos.push(
                    a.x + nx * halfMm, a.y + ny * halfMm, z,
                    a.x - nx * halfMm, a.y - ny * halfMm, z,
                    b.x - nx * halfMm, b.y - ny * halfMm, z,
                    b.x + nx * halfMm, b.y + ny * halfMm, z,
                );
                for (let k = 0; k < 4; k++) {
                    net.push(n);
                    edge.push(e);
                    half.push(halfMm);
                    peak.push(pk);
                    norm.push(nx, ny);
                }
                // Distance runs ALONG the quad: the two vertices at `a` share d0 and the two at `b` share
                // d0 + len, so the fragment stage gets a linear phase across the quad for free.
                dist.push(d0, d0, d0 + len, d0 + len);
                side.push(1, -1, -1, 1);
                idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
                quads++;
            }
        }
    }

    return {
        positions: new Float32Array(pos),
        netIndex: new Float32Array(net),
        edgeIndex: new Float32Array(edge),
        dist: new Float32Array(dist),
        side: new Float32Array(side),
        halfMm: new Float32Array(half),
        peakAbs: new Float32Array(peak),
        normal: new Float32Array(norm),
        indices: new Uint32Array(idx),
        quads,
    };
}
