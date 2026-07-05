/**
 * Lever 2 — connectivity-aware classical placement (PLACEMENT_PLAN.md).
 *
 * Pure, deterministic, dependency-free: parts + net weights in → {x, y, rotation} per part out.
 * Pipeline stages (plan §4): seed (hub/cluster) → damped force loop with interleaved rotation
 * sweeps → terminating grid legalization → shrink-to-fit board. Coordinates are BOARD-CENTER
 * origin, mm, y-down (tscircuit pcbX/pcbY convention).
 *
 * Determinism discipline (plan §12): only + - * / and Math.sqrt; rotations are exact integer
 * matrices (no trig); fixed iteration counts (never wall-clock); all orderings tie-broken by
 * part id. Same input → same output, across platforms.
 */

export interface PlaceablePad {
    /** Position relative to part center at rotation 0 (mm). */
    x: number;
    y: number;
    /** Emitted net name this pad belongs to ('' = unconnected). */
    net: string;
}

export interface PlaceablePart {
    /** Emitted (sanitized) designator — the key used everywhere. */
    id: string;
    /** Courtyard-ish footprint size at rotation 0 (mm). */
    w: number;
    h: number;
    pads: PlaceablePad[];
    /** Connectors (user-wired headers) get pulled toward the board edge. */
    role: 'part' | 'connector';
}

export interface PlacementInput {
    parts: PlaceablePart[];
    /** Emitted net name → attraction weight (GND≈0: it routes via the pour; signals 1). */
    netWeights: Record<string, number>;
    /** Derived edges the netlist doesn't carry as graph edges (decap→IC ownership, plan §4.2). */
    extraEdges?: Array<{ a: string; b: string; weight: number }>;
    boardW: number;
    boardH: number;
    gridMm: number;
    marginMm: number;
    /** Routing-channel width between courtyards (mm). Callers retry a ladder of these because
     *  freerouting's DRC-clean success is non-monotonic in it. Default 2.4. */
    spacingMm?: number;
}

export type Rotation = 0 | 90 | 180 | 270;

export interface PlacementOutput {
    positions: Record<string, { x: number; y: number; rotation: Rotation }>;
    boardW: number;
    boardH: number;
    /** Half-perimeter wirelength of the result (cheap routability proxy, plan §4.7). */
    hpwl: number;
    /** Human-readable decisions (board grown/shrunk, hubless fallback, ...) for diagnostics. */
    notes: string[];
    ok: boolean;
}

// Calibration constants (plan §5: measured on the sweep, committed with the report; same for every circuit).
const FORCE_STEPS = 200;
const RELAX_STEPS = 50;
const ROTATION_CHECKPOINTS = [80, 160];
const LEARN_START = 0.30;
const LEARN_END = 0.05;
// Default inter-courtyard breathing room used by repulsion + legalization. This is the ROUTING
// CHANNEL between parts: at the economy profile (0.2mm track + 0.2mm clearance) one escape lane
// costs ~0.6mm, so 2.4mm ≈ 4 lanes. Measured 5 Tem 2026: freerouting's DRC-clean success is
// NON-MONOTONIC in this value (1.0 routed boards 2.4 couldn't and vice versa) — so the caller
// retries a spacing LADDER (same philosophy as Lever-1's margin spread) via input.spacingMm.
const DEFAULT_SPACING_MM = 2.4;
const EDGE_PULL = 0.15; // connector-to-edge attraction relative to net pull
const UTIL_LIMIT = 0.75; // legalization pre-check (plan §4.6.1)
// Routability floor for shrink-to-fit: never hand the router a board denser than this — measured
// 5 Tem 2026: an unconstrained shrink packed chaser-4017 to 55×33.5mm and freerouting could not
// route it DRC-clean at the economy profile (vias 16→52, notary rejected every margin).
const ROUTE_UTIL = 0.45;
const MIN_BOARD_MM = 20;

// ---------------------------------------------------------------- exact integer rotation

/** Rotate a point by 0/90/180/270° with exact integer matrices — no trig (plan §12). */
export function rot(r: Rotation, x: number, y: number): [number, number] {
    switch (r) {
        case 0: return [x, y];
        case 90: return [-y, x];
        case 180: return [-x, -y];
        case 270: return [y, -x];
    }
}

/** Part AABB half-extents at a rotation (90/270 swap w/h). */
function halfExtents(p: PlaceablePart, r: Rotation): [number, number] {
    return r === 90 || r === 270 ? [p.h / 2, p.w / 2] : [p.w / 2, p.h / 2];
}

// ---------------------------------------------------------------- graph

interface Edge { a: number; b: number; weight: number }

/** Pairwise part-to-part edges: shared nets (weighted) + derived extra edges. */
function buildEdges(parts: PlaceablePart[], netWeights: Record<string, number>, extra: PlacementInput['extraEdges']): Edge[] {
    const idx = new Map(parts.map((p, i) => [p.id, i]));
    const acc = new Map<string, Edge>();
    const add = (a: number, b: number, weight: number) => {
        if (a === b || weight <= 0) return;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const e = acc.get(key);
        if (e) e.weight += weight;
        else acc.set(key, { a: Math.min(a, b), b: Math.max(a, b), weight });
    };
    // net star: connect every part pair sharing a net, weight split so big nets don't dominate
    const byNet = new Map<string, number[]>();
    for (let i = 0; i < parts.length; i++) {
        for (const pad of parts[i]!.pads) {
            if (!pad.net) continue;
            let arr = byNet.get(pad.net);
            if (!arr) byNet.set(pad.net, (arr = []));
            if (arr[arr.length - 1] !== i) arr.push(i);
        }
    }
    for (const [net, members] of byNet) {
        const w = netWeights[net] ?? 1;
        if (w <= 0 || members.length < 2) continue;
        const pair = w / (members.length - 1); // star normalization
        for (let i = 1; i < members.length; i++) add(members[0]!, members[i]!, pair);
        for (let i = 1; i < members.length - 1; i++) add(members[i]!, members[i + 1]!, pair / 2);
    }
    for (const e of extra ?? []) {
        const a = idx.get(e.a);
        const b = idx.get(e.b);
        if (a !== undefined && b !== undefined) add(a, b, e.weight);
    }
    return [...acc.values()].sort((x, y) => x.a - y.a || x.b - y.b); // deterministic order
}

// ---------------------------------------------------------------- seeding (plan §4.3)

interface State {
    x: number[];
    y: number[];
    r: Rotation[];
}

function median(nums: number[]): number {
    const s = [...nums].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)]! : 0;
}

/** Deterministic ring-seed around a center: quadrant from the strongest-connected hub pad side. */
function seed(parts: PlaceablePart[], edges: Edge[], boardW: number, boardH: number, notes: string[]): State {
    const n = parts.length;
    const degree = new Array<number>(n).fill(0);
    for (const e of edges) { degree[e.a]! += e.weight; degree[e.b]! += e.weight; }

    const med = median(degree);
    // hubs: clearly-above-median connectivity (plan: no hub → skip rings, grid seed)
    const hubIdx = parts
        .map((_, i) => i)
        .filter((i) => degree[i]! >= 2 * med && degree[i]! > 0)
        .sort((a, b) => degree[b]! - degree[a]! || parts[a]!.id.localeCompare(parts[b]!.id))
        .slice(0, 3);

    const st: State = { x: new Array(n).fill(0), y: new Array(n).fill(0), r: new Array(n).fill(0) };

    // base grid seed (also the hubless fallback), deterministic by id order
    const order = parts.map((_, i) => i).sort((a, b) => parts[a]!.id.localeCompare(parts[b]!.id));
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    const pitchX = boardW / (cols + 1);
    const pitchY = boardH / (Math.ceil(n / cols) + 1);
    order.forEach((pi, k) => {
        st.x[pi] = ((k % cols) - (cols - 1) / 2) * pitchX;
        st.y[pi] = (Math.floor(k / cols) - (Math.ceil(n / cols) - 1) / 2) * pitchY;
    });

    if (hubIdx.length === 0) {
        notes.push('seed: hubless/symmetric topology — grid seed, force phase does the work');
        return st;
    }

    // cluster assignment: each part joins the hub with the largest summed edge weight (ties: id)
    const hubWeight = new Map<number, Map<number, number>>(hubIdx.map((h) => [h, new Map()]));
    for (const e of edges) {
        for (const [h, other] of [[e.a, e.b], [e.b, e.a]] as const) {
            hubWeight.get(h)?.set(other, (hubWeight.get(h)?.get(other) ?? 0) + e.weight);
        }
    }
    const clusterOf = new Map<number, number>();
    for (let i = 0; i < n; i++) {
        if (hubIdx.includes(i)) { clusterOf.set(i, i); continue; }
        let best = -1;
        let bestW = 0;
        for (const h of hubIdx) {
            const w = hubWeight.get(h)?.get(i) ?? 0;
            if (w > bestW || (w === bestW && w > 0 && best !== -1 && parts[h]!.id < parts[best]!.id)) { best = h; bestW = w; }
        }
        clusterOf.set(i, best === -1 ? hubIdx[0]! : best);
    }

    // hub centers: 1 hub → origin; k hubs → spread on the long axis, heaviest first (super-node line)
    const centers = new Map<number, [number, number]>();
    const axisX = boardW >= boardH;
    hubIdx.forEach((h, k) => {
        const off = (k - (hubIdx.length - 1) / 2) * (axisX ? boardW : boardH) * 0.5;
        centers.set(h, axisX ? [off, 0] : [0, off]);
    });

    // ring-seed members around their hub center; quadrant by the SIDE of the hub's connected pads
    const perQuadrant = new Map<string, number>();
    for (const i of order) {
        const h = clusterOf.get(i)!;
        const [cx, cy] = centers.get(h)!;
        if (i === h) { st.x[i] = cx; st.y[i] = cy; continue; }
        const hub = parts[h]!;
        // which side of the hub does this part connect to? (no trig: pad-side buckets, plan §12)
        let sx = 0;
        let sy = 0;
        const nets = new Set(parts[i]!.pads.map((p) => p.net).filter(Boolean));
        for (const pad of hub.pads) if (nets.has(pad.net)) { sx += pad.x; sy += pad.y; }
        const qx = sx === 0 ? (i % 2 === 0 ? 1 : -1) : sx > 0 ? 1 : -1;
        const qy = sy === 0 ? (i % 2 === 0 ? 1 : -1) : sy > 0 ? 1 : -1;
        const key = `${h}:${qx}${qy}`;
        const k = perQuadrant.get(key) ?? 0;
        perQuadrant.set(key, k + 1);
        const ring = Math.floor(k / 3);
        const rad = hub.w / 2 + hub.h / 2 + 3 + ring * 4 + (k % 3) * 1.5;
        st.x[i] = cx + qx * rad * (0.6 + 0.2 * (k % 3));
        st.y[i] = cy + qy * rad * (0.6 + 0.2 * ((k + 1) % 3));
    }
    notes.push(`seed: ${hubIdx.length} hub(s) [${hubIdx.map((h) => parts[h]!.id).join(', ')}]`);
    return st;
}

// ---------------------------------------------------------------- force loop (plan §4.4)

function padWorld(st: State, i: number, pad: PlaceablePad): [number, number] {
    const [rx, ry] = rot(st.r[i]!, pad.x, pad.y);
    return [st.x[i]! + rx, st.y[i]! + ry];
}

/** One rotation sweep: hub-first deterministic order; score = Σ pad→net-centroid (own pads excluded). */
function rotationSweep(parts: PlaceablePart[], st: State, order: number[], netWeights: Record<string, number>): void {
    for (const i of order) {
        const p = parts[i]!;
        if (p.pads.length < 2) continue;
        let bestR = st.r[i]!;
        let bestScore = Infinity;
        for (const r of [0, 90, 180, 270] as Rotation[]) {
            let score = 0;
            for (const pad of p.pads) {
                if (!pad.net) continue;
                const w = netWeights[pad.net] ?? 1;
                if (w <= 0) continue;
                // net centroid EXCLUDING this part's own pads (plan: no self-reference)
                let cx = 0;
                let cy = 0;
                let cnt = 0;
                for (let j = 0; j < parts.length; j++) {
                    if (j === i) continue;
                    for (const q of parts[j]!.pads) {
                        if (q.net !== pad.net) continue;
                        const [qx, qy] = padWorld(st, j, q);
                        cx += qx; cy += qy; cnt++;
                    }
                }
                if (cnt === 0) continue;
                cx /= cnt; cy /= cnt;
                const [rx, ry] = rot(r, pad.x, pad.y);
                const dx = st.x[i]! + rx - cx;
                const dy = st.y[i]! + ry - cy;
                score += w * Math.sqrt(dx * dx + dy * dy);
            }
            if (score < bestScore - 1e-9) { bestScore = score; bestR = r; }
        }
        st.r[i] = bestR;
    }
}

function forceLoop(parts: PlaceablePart[], edges: Edge[], st: State, input: PlacementInput, rotOrder: number[]): void {
    const spacing = input.spacingMm ?? DEFAULT_SPACING_MM;
    const n = parts.length;
    const { netWeights } = input;
    const total = FORCE_STEPS + RELAX_STEPS;
    for (let step = 0; step < total; step++) {
        if (ROTATION_CHECKPOINTS.includes(step) || step === FORCE_STEPS) {
            rotationSweep(parts, st, rotOrder, netWeights);
        }
        const lr = LEARN_START + (LEARN_END - LEARN_START) * (step / total);
        const fx = new Array<number>(n).fill(0);
        const fy = new Array<number>(n).fill(0);

        // attraction along edges (spring toward each other, ∝ distance)
        for (const e of edges) {
            let dx = st.x[e.b]! - st.x[e.a]!;
            let dy = st.y[e.b]! - st.y[e.a]!;
            if (dx === 0 && dy === 0) { dx = e.a < e.b ? 0.01 : -0.01; dy = 0.01; } // ε-guard (plan §12)
            fx[e.a]! += dx * e.weight * 0.02;
            fy[e.a]! += dy * e.weight * 0.02;
            fx[e.b]! -= dx * e.weight * 0.02;
            fy[e.b]! -= dy * e.weight * 0.02;
        }

        // rect-aware repulsion: overlap of spacing-inflated AABBs pushes apart on min-penetration axis
        for (let i = 0; i < n; i++) {
            const [wi, hi] = halfExtents(parts[i]!, st.r[i]!);
            for (let j = i + 1; j < n; j++) {
                const [wj, hj] = halfExtents(parts[j]!, st.r[j]!);
                let dx = st.x[j]! - st.x[i]!;
                let dy = st.y[j]! - st.y[i]!;
                if (dx === 0 && dy === 0) { dx = 0.01; dy = -0.01; }
                const ox = wi + wj + spacing - (dx < 0 ? -dx : dx);
                const oy = hi + hj + spacing - (dy < 0 ? -dy : dy);
                if (ox <= 0 || oy <= 0) continue; // no overlap
                const push = 0.5 * Math.min(ox, oy);
                if (ox < oy) { const s = dx < 0 ? -1 : 1; fx[i]! -= s * push; fx[j]! += s * push; }
                else { const s = dy < 0 ? -1 : 1; fy[i]! -= s * push; fy[j]! += s * push; }
            }
        }

        // boundary + connector edge pull
        const bx = input.boardW / 2 - input.marginMm;
        const by = input.boardH / 2 - input.marginMm;
        for (let i = 0; i < n; i++) {
            const [wi, hi] = halfExtents(parts[i]!, st.r[i]!);
            const maxX = bx - wi;
            const maxY = by - hi;
            if (st.x[i]! > maxX) fx[i]! -= (st.x[i]! - maxX);
            if (st.x[i]! < -maxX) fx[i]! += (-maxX - st.x[i]!);
            if (st.y[i]! > maxY) fy[i]! -= (st.y[i]! - maxY);
            if (st.y[i]! < -maxY) fy[i]! += (-maxY - st.y[i]!);
            if (parts[i]!.role === 'connector') {
                // pull toward the nearest vertical edge (deterministic: sign of current x, ties → left)
                const targetX = st.x[i]! >= 0 ? maxX : -maxX;
                fx[i]! += (targetX - st.x[i]!) * EDGE_PULL;
            }
        }

        for (let i = 0; i < n; i++) {
            st.x[i]! += fx[i]! * lr;
            st.y[i]! += fy[i]! * lr;
        }
    }
}

// ---------------------------------------------------------------- legalization (plan §4.6 — provably terminating)

const snap = (v: number, g: number) => Math.round(v / g) * g;

function overlaps(
    spacing: number,
    x1: number, y1: number, w1: number, h1: number,
    x2: number, y2: number, w2: number, h2: number,
): boolean {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return (dx < 0 ? -dx : dx) < w1 + w2 + spacing - 1e-9 && (dy < 0 ? -dy : dy) < h1 + h2 + spacing - 1e-9;
}

/**
 * Tetris-style legalizer: parts sorted by area desc; each is placed at the nearest grid cell (spiral
 * ring search, deterministic order) that fits inside the board and overlaps nothing already placed.
 * Finite grid ⇒ guaranteed termination; no free cell ⇒ caller grows the board and retries once.
 */
function legalize(parts: PlaceablePart[], st: State, boardW: number, boardH: number, grid: number, margin: number, spacing: number): boolean {
    const order = parts
        .map((_, i) => i)
        .sort((a, b) => parts[b]!.w * parts[b]!.h - parts[a]!.w * parts[a]!.h || parts[a]!.id.localeCompare(parts[b]!.id));
    const placed: number[] = [];
    for (const i of order) {
        const [wi, hi] = halfExtents(parts[i]!, st.r[i]!);
        // clamp bounds FLOORED to the grid — a raw min/max clamp parks edge parts OFF-grid
        // (measured 5 Tem 2026: a connector landed at x=7.48 and broke the snap contract)
        const maxX = Math.floor((boardW / 2 - margin - wi) / grid) * grid;
        const maxY = Math.floor((boardH / 2 - margin - hi) / grid) * grid;
        if (maxX < 0 || maxY < 0) return false; // part alone doesn't fit — board must grow
        const cx = Math.min(maxX, Math.max(-maxX, snap(st.x[i]!, grid)));
        const cy = Math.min(maxY, Math.max(-maxY, snap(st.y[i]!, grid)));
        let done = false;
        const maxRing = Math.ceil(Math.max(boardW, boardH) / grid);
        for (let ring = 0; ring <= maxRing && !done; ring++) {
            // deterministic ring walk: top row → right col → bottom row → left col
            const cells: Array<[number, number]> = [];
            for (let dx = -ring; dx <= ring; dx++) cells.push([dx, -ring]);
            for (let dy = -ring + 1; dy <= ring; dy++) cells.push([ring, dy]);
            for (let dx = ring - 1; dx >= -ring; dx--) cells.push([dx, ring]);
            for (let dy = ring - 1; dy >= -ring + 1; dy--) cells.push([-ring, dy]);
            for (const [gx, gy] of ring === 0 ? ([[0, 0]] as Array<[number, number]>) : cells) {
                const px = cx + gx * grid;
                const py = cy + gy * grid;
                if (px > maxX || px < -maxX || py > maxY || py < -maxY) continue;
                let free = true;
                for (const j of placed) {
                    const [wj, hj] = halfExtents(parts[j]!, st.r[j]!);
                    if (overlaps(spacing, px, py, wi, hi, st.x[j]!, st.y[j]!, wj, hj)) { free = false; break; }
                }
                if (free) { st.x[i] = px; st.y[i] = py; done = true; break; }
            }
        }
        if (!done) return false; // no free cell on the whole board — grow & retry
        placed.push(i);
    }
    return true;
}

// ---------------------------------------------------------------- HPWL (plan §4.7)

export function computeHpwl(parts: PlaceablePart[], positions: Record<string, { x: number; y: number; rotation: Rotation }>): number {
    const box = new Map<string, [number, number, number, number]>();
    for (const p of parts) {
        const pos = positions[p.id];
        if (!pos) continue;
        for (const pad of p.pads) {
            if (!pad.net) continue;
            const [rx, ry] = rot(pos.rotation, pad.x, pad.y);
            const x = pos.x + rx;
            const y = pos.y + ry;
            const b = box.get(pad.net);
            if (!b) box.set(pad.net, [x, x, y, y]);
            else {
                if (x < b[0]) b[0] = x;
                if (x > b[1]) b[1] = x;
                if (y < b[2]) b[2] = y;
                if (y > b[3]) b[3] = y;
            }
        }
    }
    let sum = 0;
    for (const b of box.values()) sum += b[1] - b[0] + b[3] - b[2];
    return sum;
}

// ---------------------------------------------------------------- entry

export function placeParts(input: PlacementInput): PlacementOutput {
    const notes: string[] = [];
    const parts = [...input.parts].sort((a, b) => a.id.localeCompare(b.id)); // canonical order
    const grid = input.gridMm > 0 ? input.gridMm : 0.5;
    const margin = input.marginMm > 0 ? input.marginMm : 4;
    const spacing = input.spacingMm ?? DEFAULT_SPACING_MM;

    // utilization pre-check (plan §4.6.1): grow the board up front rather than fight a tight box
    let boardW = Math.max(MIN_BOARD_MM, input.boardW);
    let boardH = Math.max(MIN_BOARD_MM, input.boardH);
    const area = parts.reduce((s, p) => s + (p.w + spacing) * (p.h + spacing), 0);
    const usable = () => (boardW - 2 * margin) * (boardH - 2 * margin);
    if (usable() > 0 && area / usable() > UTIL_LIMIT) {
        const k = Math.sqrt(area / (UTIL_LIMIT * usable()));
        boardW = snap(boardW * k + grid, grid);
        boardH = snap(boardH * k + grid, grid);
        notes.push(`board grown to ${boardW}×${boardH}mm (utilization pre-check)`);
    }

    const edges = buildEdges(parts, input.netWeights, input.extraEdges);
    const st = seed(parts, edges, boardW, boardH, notes);

    // rotation sweep order: hubs first, then descending weighted degree (deterministic)
    const degree = new Array<number>(parts.length).fill(0);
    for (const e of edges) { degree[e.a]! += e.weight; degree[e.b]! += e.weight; }
    const rotOrder = parts.map((_, i) => i).sort((a, b) => degree[b]! - degree[a]! || parts[a]!.id.localeCompare(parts[b]!.id));

    forceLoop(parts, edges, st, { ...input, boardW, boardH }, rotOrder);

    // legalize; if the finite search finds no room, grow once and re-legalize (plan §4.6.2)
    if (!legalize(parts, st, boardW, boardH, grid, margin, spacing)) {
        boardW = snap(boardW * 1.4, grid);
        boardH = snap(boardH * 1.4, grid);
        notes.push(`legalization needed more room — board grown to ${boardW}×${boardH}mm`);
        if (!legalize(parts, st, boardW, boardH, grid, margin, spacing)) {
            notes.push('legalization FAILED even after growth — caller must fall back to grid placement');
            return { positions: {}, boardW, boardH, hpwl: Infinity, notes, ok: false };
        }
    }

    // shrink-to-fit (plan §4.6.3): board = courtyard bbox + margin, re-centered, snapped, floored
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    parts.forEach((p, i) => {
        const [wi, hi] = halfExtents(p, st.r[i]!);
        if (st.x[i]! - wi < minX) minX = st.x[i]! - wi;
        if (st.x[i]! + wi > maxX) maxX = st.x[i]! + wi;
        if (st.y[i]! - hi < minY) minY = st.y[i]! - hi;
        if (st.y[i]! + hi > maxY) maxY = st.y[i]! + hi;
    });
    const cx = snap((minX + maxX) / 2, grid);
    const cy = snap((minY + maxY) / 2, grid);
    let fitW = Math.max(MIN_BOARD_MM, snap(maxX - minX + 2 * margin + grid, grid));
    let fitH = Math.max(MIN_BOARD_MM, snap(maxY - minY + 2 * margin + grid, grid));
    // routability floor: keep courtyard utilization ≤ ROUTE_UTIL so freerouting has escape room
    const fitUsable = (fitW - 2 * margin) * (fitH - 2 * margin);
    if (fitUsable > 0 && area / fitUsable > ROUTE_UTIL) {
        const k = Math.sqrt(area / (ROUTE_UTIL * fitUsable));
        fitW = snap(fitW * k + grid, grid);
        fitH = snap(fitH * k + grid, grid);
        notes.push(`shrink limited for routing headroom (util ≤ ${ROUTE_UTIL})`);
    }
    if (fitW < boardW || fitH < boardH) {
        notes.push(`board shrunk to fit: ${Math.min(boardW, fitW)}×${Math.min(boardH, fitH)}mm`);
    }
    boardW = Math.min(boardW, fitW);
    boardH = Math.min(boardH, fitH);

    const positions: PlacementOutput['positions'] = {};
    parts.forEach((p, i) => {
        positions[p.id] = { x: round2(st.x[i]! - cx), y: round2(st.y[i]! - cy), rotation: st.r[i]! };
    });

    return { positions, boardW, boardH, hpwl: computeHpwl(parts, positions), notes, ok: true };
}

function round2(n: number): number {
    const r = Math.round(n * 100) / 100;
    return Object.is(r, -0) ? 0 : r;
}
