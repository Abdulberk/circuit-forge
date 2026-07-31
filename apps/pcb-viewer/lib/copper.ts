/**
 * Copper geometry for the simulation overlay: every trace on the board as ONE mesh, with each vertex
 * carrying the index of the net it belongs to.
 *
 * WHY BUILD IT AT ALL. The exported GLB has copper as a single merged mesh per layer — there is no per-net
 * object to colour, and splitting the GLB by net is not possible from the outside. But `LayoutGeometry`
 * carries the exact polylines and widths, and (since the net-identity fix) the net each one belongs to. So
 * the overlay is drawn from the contract rather than reverse-engineered from the render.
 *
 * WHY ONE MESH. The value that changes every frame is per-NET, not per-vertex, so it belongs in a texture
 * the shader samples by net index — not in a per-object uniform. That makes the whole board one draw call
 * and one small texture upload per frame, whatever the net count: a 25-net board and a 5000-net board cost
 * the same in structure, and the frame loop allocates nothing.
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
    /** Net index per vertex — the shader's lookup into the per-net value texture. */
    netIndex: Float32Array;
    /** Triangle indices. */
    indices: Uint32Array;
    /** How many quads were emitted, for a sanity read at the call site. */
    quads: number;
}

/** Layer z-offsets in mm, so the two sides do not z-fight when both are drawn. */
const LAYER_Z: Record<string, number> = { top: 0.02, bottom: -0.02 };

/**
 * Ribbon a polyline: each consecutive pair of points becomes a quad of the trace's width.
 *
 * Deliberately NOT mitred at the corners. A mitre needs the turn angle and degenerates on a reversal, and
 * the overlay's job is to say WHICH NET this copper is and what it is doing — a hairline notch on the
 * outside of a corner does not change that answer. Getting corners wrong quietly would; getting them
 * simple visibly does not.
 */
export function buildCopperMesh(traces: Trace[], netIndexByName: Map<string, number>): CopperMesh {
    const pos: number[] = [];
    const idx: number[] = [];
    const net: number[] = [];
    let quads = 0;

    for (const trace of traces) {
        if (!trace.net) continue; // no net: nothing honest to colour it with
        const n = netIndexByName.get(trace.net);
        if (n === undefined) continue; // no simulation signal for this net — the caller discloses it
        for (const seg of trace.segments) {
            const z = LAYER_Z[seg.layer] ?? 0;
            const half = Math.max(seg.widthMm, 0.05) / 2;
            for (let i = 0; i < seg.points.length - 1; i++) {
                const a = seg.points[i]!;
                const b = seg.points[i + 1]!;
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const len = Math.hypot(dx, dy);
                if (len === 0) continue; // a repeated point has no direction to offset along
                const nx = (-dy / len) * half;
                const ny = (dx / len) * half;

                const base = pos.length / 3;
                pos.push(a.x + nx, a.y + ny, z, a.x - nx, a.y - ny, z, b.x - nx, b.y - ny, z, b.x + nx, b.y + ny, z);
                net.push(n, n, n, n);
                idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
                quads++;
            }
        }
    }

    return {
        positions: new Float32Array(pos),
        netIndex: new Float32Array(net),
        indices: new Uint32Array(idx),
        quads,
    };
}
