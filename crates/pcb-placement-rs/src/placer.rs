//! `multistart-spatial-v1` — an independent, deterministic force-directed placer built for SCALE.
//!
//! It mirrors `packages/pcb-core/src/placement.ts` in ABI and quality intent (connectivity-aware force
//! loop → interleaved rotation sweeps → terminating grid legalization → shrink-to-fit), but replaces the
//! TS kernel's two O(n²) hot spots — all-pairs repulsion every step, and all-placed overlap tests during
//! legalization — with spatial-hash near-neighbour queries, and reuses every hot-path buffer so the force
//! loop is allocation-free. A bounded multistart evaluates a few deterministic seeds and keeps the best by
//! weighted HPWL. Net centroids are cached per rotation sweep.
//!
//! Determinism: only + - * / and sqrt; rotations are exact integer matrices; fixed iteration counts; every
//! ordering is tie-broken by part id or visited in index order with sorted neighbour lists; output maps are
//! BTreeMap. Same input → identical output on repeated runs.

use crate::model::{
    Part, PartRole, PlaceError, PlacementInput, PlacementOptions, PlacementOutput, PlacementStats,
    Position,
};
use crate::spatial::{Grid, Rect};
use std::collections::BTreeMap;

// Calibration constants — identical to placement.ts so per-start quality tracks the TS kernel.
const LEARN_START: f64 = 0.30;
const LEARN_END: f64 = 0.05;
const DEFAULT_SPACING_MM: f64 = 2.4;
const EDGE_PULL: f64 = 0.15;
const UTIL_LIMIT: f64 = 0.75;
const ROUTE_UTIL: f64 = 0.45;
const MIN_BOARD_MM: f64 = 20.0;
const PROTOCOL_VERSION: u32 = 1;
const ENGINE: &str = "pcb-placement-rs";
const ALGORITHM: &str = "multistart-spatial-v1";

// Option clamps (documented ranges in model.rs).
const STARTS_MIN: usize = 1;
const STARTS_MAX: usize = 16;
const FORCE_MIN: usize = 20;
const FORCE_MAX: usize = 1000;
const REFINE_MAX: usize = 8;

// Input-domain bounds. Boards beyond 10 m or weights beyond 1e12 are not electronics — they are caller
// bugs, and letting them through produced real failures under probing (a 10 000 mm board once hung the
// force loop; a 1e300 net weight overflowed positions to non-finite yet still emitted ok=true). Reject
// loudly at the boundary instead: the worker's grid fallback handles a clean error far better than a hang.
const MAX_BOARD_MM: f64 = 10_000.0;
const MAX_WEIGHT: f64 = 1e12;

#[derive(Clone, Copy)]
struct Edge {
    a: usize,
    b: usize,
    weight: f64,
}

#[derive(Clone)]
struct State {
    x: Vec<f64>,
    y: Vec<f64>,
    r: Vec<u16>,
}

#[inline]
fn rot(r: u16, x: f64, y: f64) -> (f64, f64) {
    match r {
        90 => (-y, x),
        180 => (-x, -y),
        270 => (y, -x),
        _ => (x, y),
    }
}

#[inline]
fn half_extents(p: &Part, r: u16) -> (f64, f64) {
    if r == 90 || r == 270 {
        (p.h / 2.0, p.w / 2.0)
    } else {
        (p.w / 2.0, p.h / 2.0)
    }
}

#[inline]
fn snap(v: f64, g: f64) -> f64 {
    (v / g).round() * g
}

#[inline]
fn round2(n: f64) -> f64 {
    let r = (n * 100.0).round() / 100.0;
    if r == 0.0 { 0.0 } else { r } // normalize -0.0 → 0.0
}

#[inline]
fn inflated_rect(x: f64, y: f64, hw: f64, hh: f64, pad: f64) -> Rect {
    Rect { min_x: x - hw - pad, max_x: x + hw + pad, min_y: y - hh - pad, max_y: y + hh + pad }
}

#[inline]
fn overlaps(spacing: f64, x1: f64, y1: f64, w1: f64, h1: f64, x2: f64, y2: f64, w2: f64, h2: f64) -> bool {
    (x2 - x1).abs() < w1 + w2 + spacing - 1e-9 && (y2 - y1).abs() < h1 + h2 + spacing - 1e-9
}

/// Pairwise part-to-part edges: shared nets (star-normalized) + derived extra edges. Deterministic order.
fn build_edges(parts: &[Part], input: &PlacementInput) -> Vec<Edge> {
    let n = parts.len();
    let idx: BTreeMap<&str, usize> = parts.iter().enumerate().map(|(i, p)| (p.id.as_str(), i)).collect();
    let mut acc: BTreeMap<(usize, usize), f64> = BTreeMap::new();
    fn add(acc: &mut BTreeMap<(usize, usize), f64>, a: usize, b: usize, w: f64) {
        if a == b || w <= 0.0 {
            return;
        }
        let key = if a < b { (a, b) } else { (b, a) };
        *acc.entry(key).or_insert(0.0) += w;
    }

    let mut by_net: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for i in 0..n {
        for pad in &parts[i].pads {
            if pad.net.is_empty() {
                continue;
            }
            let arr = by_net.entry(pad.net.as_str()).or_default();
            if arr.last() != Some(&i) {
                arr.push(i);
            }
        }
    }
    for (net, members) in &by_net {
        let w = *input.net_weights.get(*net).unwrap_or(&1.0);
        if w <= 0.0 || members.len() < 2 {
            continue;
        }
        let pair = w / (members.len() as f64 - 1.0);
        for k in 1..members.len() {
            add(&mut acc, members[0], members[k], pair);
        }
        for k in 1..members.len().saturating_sub(1) {
            add(&mut acc, members[k], members[k + 1], pair / 2.0);
        }
    }
    for e in &input.extra_edges {
        if let (Some(&a), Some(&b)) = (idx.get(e.a.as_str()), idx.get(e.b.as_str())) {
            add(&mut acc, a, b, e.weight);
        }
    }
    acc.into_iter().map(|((a, b), weight)| Edge { a, b, weight }).collect()
}

fn weighted_degree(parts: &[Part], edges: &[Edge]) -> Vec<f64> {
    let mut d = vec![0.0; parts.len()];
    for e in edges {
        d[e.a] += e.weight;
        d[e.b] += e.weight;
    }
    d
}

fn degree_order(parts: &[Part], degree: &[f64]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..parts.len()).collect();
    order.sort_by(|&a, &b| {
        degree[b]
            .partial_cmp(&degree[a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| parts[a].id.cmp(&parts[b].id))
    });
    order
}

fn id_order(parts: &[Part]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..parts.len()).collect();
    order.sort_by(|&a, &b| parts[a].id.cmp(&parts[b].id));
    order
}

/// Deterministic seed for a given start index — diverse basins without any RNG. Start 0 is heaviest-first
/// (hubs near the centre columns, closest to the TS hub seed); higher starts are distinct grid arrangements
/// (order rotation / transpose / axis flip).
fn seed(parts: &[Part], degree: &[f64], board_w: f64, board_h: f64, start: usize) -> State {
    let n = parts.len();
    let mut st = State { x: vec![0.0; n], y: vec![0.0; n], r: vec![0; n] };
    if n <= 1 {
        return st;
    }
    let base = id_order(parts);
    let order: Vec<usize> = match start % 4 {
        0 => degree_order(parts, degree),
        1 => base.clone(),
        2 => base.iter().rev().copied().collect(),
        _ => {
            let shift = n / 3 + start;
            (0..n).map(|k| base[(k + shift) % n]).collect()
        }
    };

    let transpose = start % 2 == 1;
    let mut cols = ((n as f64).sqrt().ceil() as usize).max(1);
    let mut rows = n.div_ceil(cols);
    if transpose {
        std::mem::swap(&mut cols, &mut rows);
    }
    let pitch_x = board_w / (cols as f64 + 1.0);
    let pitch_y = board_h / (rows as f64 + 1.0);
    let flip: f64 = if start % 4 == 3 { -1.0 } else { 1.0 };

    for (k, &pi) in order.iter().enumerate() {
        let col = (k % cols) as f64;
        let row = (k / cols) as f64;
        st.x[pi] = flip * (col - (cols as f64 - 1.0) / 2.0) * pitch_x;
        st.y[pi] = (row - (rows as f64 - 1.0) / 2.0) * pitch_y;
    }
    st
}

/// Spatial-hash cell size ≈ typical inflated part pitch. `all_pairs`/neighbour correctness is independent
/// of this (overlapping AABBs always share a cell); it only tunes bucket occupancy.
fn hash_cell(parts: &[Part], spacing: f64, grid: f64) -> f64 {
    if parts.is_empty() {
        return grid.max(1.0);
    }
    let mut sum = 0.0;
    for p in parts {
        sum += p.w.max(p.h) + spacing;
    }
    (sum / parts.len() as f64).max(grid).max(1e-3)
}

/// One rotation sweep. Score = Σ weighted pad→net-centroid distance (own pads excluded). Net centroids are
/// cached once per sweep from the current layout — O(total pads), vs the TS per-part recompute.
fn rotation_sweep(parts: &[Part], st: &mut State, order: &[usize], net_weights: &BTreeMap<String, f64>) {
    let mut sum_x: BTreeMap<&str, f64> = BTreeMap::new();
    let mut sum_y: BTreeMap<&str, f64> = BTreeMap::new();
    let mut cnt: BTreeMap<&str, f64> = BTreeMap::new();
    for i in 0..parts.len() {
        for pad in &parts[i].pads {
            if pad.net.is_empty() {
                continue;
            }
            let (rx, ry) = rot(st.r[i], pad.x, pad.y);
            *sum_x.entry(pad.net.as_str()).or_insert(0.0) += st.x[i] + rx;
            *sum_y.entry(pad.net.as_str()).or_insert(0.0) += st.y[i] + ry;
            *cnt.entry(pad.net.as_str()).or_insert(0.0) += 1.0;
        }
    }
    for &i in order {
        let p = &parts[i];
        if p.pads.len() < 2 {
            continue;
        }
        let mut best_r = st.r[i];
        let mut best_score = f64::INFINITY;
        for &r in &[0u16, 90, 180, 270] {
            let mut score = 0.0;
            for pad in &p.pads {
                if pad.net.is_empty() {
                    continue;
                }
                let w = *net_weights.get(&pad.net).unwrap_or(&1.0);
                if w <= 0.0 {
                    continue;
                }
                let net = pad.net.as_str();
                let total = cnt.get(net).copied().unwrap_or(0.0);
                let others = total - 1.0;
                if others <= 0.0 {
                    continue;
                }
                let (crx, cry) = rot(st.r[i], pad.x, pad.y);
                let own_x = st.x[i] + crx;
                let own_y = st.y[i] + cry;
                let cx = (sum_x.get(net).copied().unwrap_or(0.0) - own_x) / others;
                let cy = (sum_y.get(net).copied().unwrap_or(0.0) - own_y) / others;
                let (rx, ry) = rot(r, pad.x, pad.y);
                let dx = st.x[i] + rx - cx;
                let dy = st.y[i] + ry - cy;
                score += w * (dx * dx + dy * dy).sqrt();
            }
            if score < best_score - 1e-9 {
                best_score = score;
                best_r = r;
            }
        }
        st.r[i] = best_r;
    }
}

/// Damped force loop with interleaved rotation sweeps and spatial-hash repulsion. All buffers are allocated
/// once and reused across steps; repulsion visits parts in index order and each part's SORTED neighbour list
/// so force accumulation is deterministic.
#[allow(clippy::too_many_arguments)]
fn force_loop(
    parts: &[Part],
    edges: &[Edge],
    st: &mut State,
    input: &PlacementInput,
    board_w: f64,
    board_h: f64,
    rot_order: &[usize],
    force_steps: usize,
    cell: f64,
    spacing: f64,
    margin: f64,
    candidate_pairs: &mut u64,
) {
    let n = parts.len();
    let net_weights = &input.net_weights;
    let relax = (force_steps / 4).max(1);
    let total = force_steps + relax;
    let cp1 = (force_steps * 2) / 5;
    let cp2 = (force_steps * 4) / 5;

    let mut fx = vec![0.0f64; n];
    let mut fy = vec![0.0f64; n];
    let mut hw = vec![(0.0f64, 0.0f64); n];
    let mut rects = vec![Rect { min_x: 0.0, max_x: 0.0, min_y: 0.0, max_y: 0.0 }; n];
    let mut grid = Grid::new(cell, board_w, board_h);
    let mut neigh: Vec<usize> = Vec::new();

    for step in 0..total {
        if step == cp1 || step == cp2 || step == force_steps {
            rotation_sweep(parts, st, rot_order, net_weights);
        }
        let lr = LEARN_START + (LEARN_END - LEARN_START) * (step as f64 / total as f64);
        fx.iter_mut().for_each(|v| *v = 0.0);
        fy.iter_mut().for_each(|v| *v = 0.0);

        // attraction along edges
        for e in edges {
            let mut dx = st.x[e.b] - st.x[e.a];
            let mut dy = st.y[e.b] - st.y[e.a];
            if dx == 0.0 && dy == 0.0 {
                dx = if e.a < e.b { 0.01 } else { -0.01 };
                dy = 0.01;
            }
            fx[e.a] += dx * e.weight * 0.02;
            fy[e.a] += dy * e.weight * 0.02;
            fx[e.b] -= dx * e.weight * 0.02;
            fy[e.b] -= dy * e.weight * 0.02;
        }

        // rebuild the grid over spacing-inflated AABBs (buffers reused)
        grid.clear();
        for i in 0..n {
            let (wi, hi) = half_extents(&parts[i], st.r[i]);
            hw[i] = (wi, hi);
            rects[i] = inflated_rect(st.x[i], st.y[i], wi, hi, spacing / 2.0);
            grid.insert(i, rects[i]);
        }

        // near-neighbour repulsion (each unordered pair processed once, j > i)
        for i in 0..n {
            neigh.clear();
            grid.neighbors(rects[i], &mut neigh);
            neigh.sort_unstable();
            neigh.dedup();
            let (wi, hi) = hw[i];
            for &j in &neigh {
                if j <= i {
                    continue;
                }
                *candidate_pairs += 1;
                let (wj, hj) = hw[j];
                let mut dx = st.x[j] - st.x[i];
                let mut dy = st.y[j] - st.y[i];
                if dx == 0.0 && dy == 0.0 {
                    dx = 0.01;
                    dy = -0.01;
                }
                let ox = wi + wj + spacing - dx.abs();
                let oy = hi + hj + spacing - dy.abs();
                if ox <= 0.0 || oy <= 0.0 {
                    continue;
                }
                let push = 0.5 * ox.min(oy);
                if ox < oy {
                    let s = if dx < 0.0 { -1.0 } else { 1.0 };
                    fx[i] -= s * push;
                    fx[j] += s * push;
                } else {
                    let s = if dy < 0.0 { -1.0 } else { 1.0 };
                    fy[i] -= s * push;
                    fy[j] += s * push;
                }
            }
        }

        // boundary + connector edge pull
        let bx = board_w / 2.0 - margin;
        let by = board_h / 2.0 - margin;
        for i in 0..n {
            let (wi, hi) = hw[i];
            let max_x = bx - wi;
            let max_y = by - hi;
            if st.x[i] > max_x {
                fx[i] -= st.x[i] - max_x;
            }
            if st.x[i] < -max_x {
                fx[i] += -max_x - st.x[i];
            }
            if st.y[i] > max_y {
                fy[i] -= st.y[i] - max_y;
            }
            if st.y[i] < -max_y {
                fy[i] += -max_y - st.y[i];
            }
            if parts[i].role == PartRole::Connector {
                let target_x = if st.x[i] >= 0.0 { max_x } else { -max_x };
                fx[i] += (target_x - st.x[i]) * EDGE_PULL;
            }
        }

        for i in 0..n {
            st.x[i] += fx[i] * lr;
            st.y[i] += fy[i] * lr;
        }
    }
}

/// Tetris-style legalizer with a spatial hash over already-placed parts: parts by area desc, each snaps to
/// the nearest legal grid cell (deterministic spiral). Finite grid ⇒ guaranteed termination; false ⇒ a part
/// could not fit (caller grows the board and retries once).
#[allow(clippy::too_many_arguments)]
fn legalize(
    parts: &[Part],
    st: &mut State,
    board_w: f64,
    board_h: f64,
    grid_mm: f64,
    margin: f64,
    spacing: f64,
    cell: f64,
    probes: &mut u64,
) -> bool {
    let n = parts.len();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        let area_a = parts[a].w * parts[a].h;
        let area_b = parts[b].w * parts[b].h;
        area_b
            .partial_cmp(&area_a)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| parts[a].id.cmp(&parts[b].id))
    });

    let mut grid = Grid::new(cell, board_w, board_h);
    let mut prect: Vec<(f64, f64, f64, f64)> = vec![(0.0, 0.0, 0.0, 0.0); n];
    let mut placed = vec![false; n];
    let mut neigh: Vec<usize> = Vec::new();

    // The spiral SEARCH steps by a coarse increment (≈ one clearance channel, a multiple of the fine grid)
    // rather than one fine cell: parts spend most of their spiral crossing already-packed regions to reach
    // free space, and a clearance-sized step still lands legal courtyards without fine-cell waste. Positions
    // stay grid-aligned because `step_mm` is a grid multiple and the spiral centre is grid-snapped.
    let step_mm = {
        let s = snap(spacing, grid_mm);
        if s > grid_mm { s } else { grid_mm }
    };

    for &i in &order {
        let (wi, hi) = half_extents(&parts[i], st.r[i]);
        let max_x = ((board_w / 2.0 - margin - wi) / grid_mm).floor() * grid_mm;
        let max_y = ((board_h / 2.0 - margin - hi) / grid_mm).floor() * grid_mm;
        if max_x < 0.0 || max_y < 0.0 {
            return false;
        }
        let cx = snap(st.x[i], grid_mm).clamp(-max_x, max_x);
        let cy = snap(st.y[i], grid_mm).clamp(-max_y, max_y);
        let mut done = false;
        let max_ring = (board_w.max(board_h) / step_mm).ceil() as i64;

        let mut ring = 0i64;
        while ring <= max_ring && !done {
            let mut visit = |gx: i64, gy: i64, st: &mut State| -> bool {
                let px = cx + gx as f64 * step_mm;
                let py = cy + gy as f64 * step_mm;
                if px > max_x || px < -max_x || py > max_y || py < -max_y {
                    return false;
                }
                *probes += 1;
                neigh.clear();
                grid.neighbors(inflated_rect(px, py, wi, hi, spacing / 2.0), &mut neigh);
                neigh.sort_unstable();
                neigh.dedup();
                for &j in &neigh {
                    if !placed[j] {
                        continue;
                    }
                    let (jx, jy, jw, jh) = prect[j];
                    if overlaps(spacing, px, py, wi, hi, jx, jy, jw, jh) {
                        return false;
                    }
                }
                st.x[i] = px;
                st.y[i] = py;
                true
            };

            if ring == 0 {
                done = visit(0, 0, st);
            } else {
                // deterministic ring walk: top row → right col → bottom row → left col
                let mut gx = -ring;
                while gx <= ring && !done {
                    done = visit(gx, -ring, st);
                    gx += 1;
                }
                let mut gy = -ring + 1;
                while gy <= ring && !done {
                    done = visit(ring, gy, st);
                    gy += 1;
                }
                let mut gx = ring - 1;
                while gx >= -ring && !done {
                    done = visit(gx, ring, st);
                    gx -= 1;
                }
                let mut gy = ring - 1;
                while gy >= -ring + 1 && !done {
                    done = visit(-ring, gy, st);
                    gy -= 1;
                }
            }
            ring += 1;
        }
        if !done {
            return false;
        }
        grid.insert(i, inflated_rect(st.x[i], st.y[i], wi, hi, spacing / 2.0));
        prect[i] = (st.x[i], st.y[i], wi, hi);
        placed[i] = true;
    }
    true
}

/// HPWL from FINAL (rounded) positions — identical formula to placement.ts `computeHpwl`, so the
/// benchmark's recompute cross-check holds. `weight_by_net` = the multistart selection metric.
fn compute_hpwl(
    parts: &[Part],
    positions: &BTreeMap<String, Position>,
    net_weights: &BTreeMap<String, f64>,
    weight_by_net: bool,
) -> f64 {
    let mut boxes: BTreeMap<&str, [f64; 4]> = BTreeMap::new();
    for p in parts {
        let Some(pos) = positions.get(&p.id) else { continue };
        for pad in &p.pads {
            if pad.net.is_empty() {
                continue;
            }
            let (rx, ry) = rot(pos.rotation, pad.x, pad.y);
            let x = pos.x + rx;
            let y = pos.y + ry;
            boxes
                .entry(pad.net.as_str())
                .and_modify(|b| {
                    if x < b[0] {
                        b[0] = x;
                    }
                    if x > b[1] {
                        b[1] = x;
                    }
                    if y < b[2] {
                        b[2] = y;
                    }
                    if y > b[3] {
                        b[3] = y;
                    }
                })
                .or_insert([x, x, y, y]);
        }
    }
    let mut sum = 0.0;
    for (net, b) in &boxes {
        let hp = (b[1] - b[0]) + (b[3] - b[2]);
        let w = if weight_by_net { *net_weights.get(*net).unwrap_or(&1.0) } else { 1.0 };
        sum += hp * w;
    }
    sum
}

fn make_positions(parts: &[Part], st: &State, cx: f64, cy: f64) -> BTreeMap<String, Position> {
    let mut positions = BTreeMap::new();
    for (i, p) in parts.iter().enumerate() {
        positions.insert(
            p.id.clone(),
            Position { x: round2(st.x[i] - cx), y: round2(st.y[i] - cy), rotation: st.r[i] },
        );
    }
    positions
}

/// One attempt from a seed: force loop → legalize (grow once). None if legalization fails even after growth.
#[allow(clippy::too_many_arguments)]
fn attempt(
    parts: &[Part],
    edges: &[Edge],
    input: &PlacementInput,
    degree: &[f64],
    rot_order: &[usize],
    start: usize,
    force_steps: usize,
    board_w0: f64,
    board_h0: f64,
    grid: f64,
    margin: f64,
    spacing: f64,
    cell: f64,
    stats: &mut PlacementStats,
) -> Option<(State, f64, f64)> {
    let mut st = seed(parts, degree, board_w0, board_h0, start);
    force_loop(parts, edges, &mut st, input, board_w0, board_h0, rot_order, force_steps, cell, spacing, margin, &mut stats.spatial_candidate_pairs);

    let mut board_w = board_w0;
    let mut board_h = board_h0;
    if !legalize(parts, &mut st, board_w, board_h, grid, margin, spacing, cell, &mut stats.legalizer_probes) {
        board_w = snap(board_w * 1.4, grid).min(MAX_BOARD_MM);
        board_h = snap(board_h * 1.4, grid).min(MAX_BOARD_MM);
        if !legalize(parts, &mut st, board_w, board_h, grid, margin, spacing, cell, &mut stats.legalizer_probes) {
            return None;
        }
    }
    Some((st, board_w, board_h))
}

pub fn place(input: &PlacementInput) -> Result<PlacementOutput, PlaceError> {
    if !input.board_w.is_finite() || !input.board_h.is_finite() {
        return Err(PlaceError::invalid("boardW/boardH must be finite"));
    }
    if input.board_w > MAX_BOARD_MM || input.board_h > MAX_BOARD_MM {
        return Err(PlaceError::invalid(format!("boardW/boardH exceed the {MAX_BOARD_MM}mm maximum")));
    }
    let mut parts: Vec<Part> = input.parts.clone();
    parts.sort_by(|a, b| a.id.cmp(&b.id)); // canonical order
    for w in parts.windows(2) {
        if w[0].id == w[1].id {
            // Two physical parts sharing an id would silently collapse into ONE output position (the id is
            // the positions-map key) — the caller would stack two components. Reject instead.
            return Err(PlaceError::invalid(format!("duplicate part id \"{}\"", w[0].id)));
        }
    }
    for p in &parts {
        if !p.w.is_finite() || !p.h.is_finite() || p.w < 0.0 || p.h < 0.0 || p.w > MAX_BOARD_MM || p.h > MAX_BOARD_MM {
            return Err(PlaceError::invalid(format!("part {} has invalid w/h", p.id)));
        }
        for pad in &p.pads {
            if !pad.x.is_finite() || !pad.y.is_finite() {
                return Err(PlaceError::invalid(format!("part {} has a non-finite pad", p.id)));
            }
        }
    }
    // Weight sanity: a huge finite weight (1e300) overflows force accumulation to non-finite positions.
    for (net, w) in &input.net_weights {
        if !w.is_finite() || w.abs() > MAX_WEIGHT {
            return Err(PlaceError::invalid(format!("net weight for \"{net}\" is not finite / exceeds {MAX_WEIGHT:e}")));
        }
    }
    for e in &input.extra_edges {
        if !e.weight.is_finite() || e.weight.abs() > MAX_WEIGHT {
            return Err(PlaceError::invalid(format!("extra edge {}-{} weight is not finite / exceeds {MAX_WEIGHT:e}", e.a, e.b)));
        }
    }

    let opts: &PlacementOptions = &input.options;
    let mut starts = opts.starts.clamp(STARTS_MIN, STARTS_MAX);
    let force_steps = opts.force_steps.clamp(FORCE_MIN, FORCE_MAX);
    let refine_passes = opts.refine_passes.min(REFINE_MAX);

    let grid = if input.grid_mm > 0.0 && input.grid_mm.is_finite() { input.grid_mm } else { 0.5 };
    let margin = if input.margin_mm > 0.0 && input.margin_mm.is_finite() { input.margin_mm } else { 4.0 };
    // A negative spacing would let courtyards overlap "legally" — clamp to 0 (touching, never overlapping).
    let spacing = input.spacing_mm.unwrap_or(DEFAULT_SPACING_MM).max(0.0);
    let spacing = if spacing.is_finite() { spacing } else { DEFAULT_SPACING_MM };

    let n = parts.len();

    // Adaptive multistart: on large boards a single well-seeded force pass already dominates the grid, and
    // extra starts cost a full pipeline each — so cap starts as n grows (unless the caller asked for fewer).
    // This keeps latency low at scale while preserving multistart quality on the small boards where it is
    // cheap. The cap only ever LOWERS the requested count.
    let start_cap = if n <= 150 {
        16
    } else if n <= 350 {
        3
    } else {
        2
    };
    starts = starts.min(start_cap);

    let mut notes: Vec<String> = Vec::new();
    let mut stats = PlacementStats {
        starts,
        selected_start: 0,
        force_steps_per_start: force_steps,
        spatial_candidate_pairs: 0,
        legalizer_probes: 0,
        refinement_moves: 0,
    };

    if n == 0 {
        return Ok(PlacementOutput {
            positions: BTreeMap::new(),
            board_w: input.board_w.max(MIN_BOARD_MM),
            board_h: input.board_h.max(MIN_BOARD_MM),
            hpwl: 0.0,
            weighted_hpwl: 0.0,
            notes: vec!["no parts to place".into()],
            ok: true,
            protocol_version: PROTOCOL_VERSION,
            engine: ENGINE,
            algorithm: ALGORITHM,
            stats,
        });
    }

    // board utilization pre-check (grow up front, like the TS kernel)
    let mut board_w = input.board_w.max(MIN_BOARD_MM);
    let mut board_h = input.board_h.max(MIN_BOARD_MM);
    let area: f64 = parts.iter().map(|p| (p.w + spacing) * (p.h + spacing)).sum();
    let usable = |bw: f64, bh: f64| (bw - 2.0 * margin) * (bh - 2.0 * margin);
    if usable(board_w, board_h) > 0.0 && area / usable(board_w, board_h) > UTIL_LIMIT {
        let k = (area / (UTIL_LIMIT * usable(board_w, board_h))).sqrt();
        board_w = snap(board_w * k + grid, grid).min(MAX_BOARD_MM);
        board_h = snap(board_h * k + grid, grid).min(MAX_BOARD_MM);
        notes.push(format!("board grown to {board_w}×{board_h}mm (utilization pre-check)"));
    }

    let edges = build_edges(&parts, input);
    let degree = weighted_degree(&parts, &edges);
    let rot_order = degree_order(&parts, &degree);
    let cell = hash_cell(&parts, spacing, grid);

    // multistart: keep the best legal attempt by weighted HPWL (ties → lower raw HPWL, then lower start)
    let mut best: Option<(State, f64, f64, f64, usize)> = None;
    for start in 0..starts {
        let Some((st, bw, bh)) =
            attempt(&parts, &edges, input, &degree, &rot_order, start, force_steps, board_w, board_h, grid, margin, spacing, cell, &mut stats)
        else {
            continue;
        };
        let positions = make_positions(&parts, &st, 0.0, 0.0);
        let whpwl = compute_hpwl(&parts, &positions, &input.net_weights, true);
        let better = match &best {
            None => true,
            Some((_, _, _, best_w, _)) => whpwl < best_w - 1e-9,
        };
        if better {
            best = Some((st, bw, bh, whpwl, start));
        }
    }

    let Some((mut st, mut board_w, mut board_h, _, selected)) = best else {
        notes.push("legalization FAILED for every start even after growth".into());
        return Ok(PlacementOutput {
            positions: BTreeMap::new(),
            board_w,
            board_h,
            hpwl: 0.0,
            weighted_hpwl: 0.0,
            notes,
            ok: false,
            protocol_version: PROTOCOL_VERSION,
            engine: ENGINE,
            algorithm: ALGORITHM,
            stats,
        });
    };
    stats.selected_start = selected;
    notes.push(format!("multistart: {starts} start(s), selected #{selected}"));

    // refine: bounded, monotonic, legality-checked local improvement on the winner
    for _ in 0..refine_passes {
        let snapshot = st.clone();
        let moved = refine_pass(&parts, &snapshot, &mut st, board_w, board_h, grid, margin, spacing, cell, &input.net_weights, &mut stats);
        if moved == 0 {
            break;
        }
    }

    // shrink-to-fit with routability floor (identical policy to the TS kernel)
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for i in 0..n {
        let (hw, hh) = half_extents(&parts[i], st.r[i]);
        min_x = min_x.min(st.x[i] - hw);
        max_x = max_x.max(st.x[i] + hw);
        min_y = min_y.min(st.y[i] - hh);
        max_y = max_y.max(st.y[i] + hh);
    }
    let cx = snap((min_x + max_x) / 2.0, grid);
    let cy = snap((min_y + max_y) / 2.0, grid);
    let mut fit_w = snap(max_x - min_x + 2.0 * margin + grid, grid).max(MIN_BOARD_MM);
    let mut fit_h = snap(max_y - min_y + 2.0 * margin + grid, grid).max(MIN_BOARD_MM);
    let fit_usable = (fit_w - 2.0 * margin) * (fit_h - 2.0 * margin);
    if fit_usable > 0.0 && area / fit_usable > ROUTE_UTIL {
        let k = (area / (ROUTE_UTIL * fit_usable)).sqrt();
        fit_w = snap(fit_w * k + grid, grid);
        fit_h = snap(fit_h * k + grid, grid);
        notes.push(format!("shrink limited for routing headroom (util ≤ {ROUTE_UTIL})"));
    }
    if fit_w < board_w || fit_h < board_h {
        notes.push(format!("board shrunk to fit: {}×{}mm", board_w.min(fit_w), board_h.min(fit_h)));
    }
    board_w = board_w.min(fit_w);
    board_h = board_h.min(fit_h);

    let positions = make_positions(&parts, &st, cx, cy);
    // Contract guard: NEVER emit ok=true with a non-finite coordinate (serde_json would serialize it as
    // null and the caller would see a malformed board). Input validation should make this unreachable —
    // this is the defense-in-depth backstop.
    if positions.values().any(|p| !p.x.is_finite() || !p.y.is_finite()) {
        return Err(PlaceError::invalid("solver produced non-finite coordinates (numeric overflow)"));
    }
    let hpwl = compute_hpwl(&parts, &positions, &input.net_weights, false);
    let weighted_hpwl = compute_hpwl(&parts, &positions, &input.net_weights, true);

    Ok(PlacementOutput {
        positions,
        board_w,
        board_h,
        hpwl,
        weighted_hpwl,
        notes,
        ok: true,
        protocol_version: PROTOCOL_VERSION,
        engine: ENGINE,
        algorithm: ALGORITHM,
        stats,
    })
}

/// One refinement pass: each part (id order) may snap toward the grid cell that most reduces its own
/// weighted pad→net-centroid distance, accepting ONLY a strictly-improving, legal move. Monotonic and
/// legality-checked ⇒ can never overlap or worsen the layout. Centroids come from `snapshot` (the pre-pass
/// layout) so a pass is order-independent and deterministic. Returns moves applied.
#[allow(clippy::too_many_arguments)]
fn refine_pass(
    parts: &[Part],
    snapshot: &State,
    st: &mut State,
    board_w: f64,
    board_h: f64,
    grid_mm: f64,
    margin: f64,
    spacing: f64,
    cell: f64,
    net_weights: &BTreeMap<String, f64>,
    stats: &mut PlacementStats,
) -> u64 {
    let n = parts.len();
    let mut sum_x: BTreeMap<&str, f64> = BTreeMap::new();
    let mut sum_y: BTreeMap<&str, f64> = BTreeMap::new();
    let mut cnt: BTreeMap<&str, f64> = BTreeMap::new();
    for i in 0..n {
        for pad in &parts[i].pads {
            if pad.net.is_empty() {
                continue;
            }
            let (rx, ry) = rot(snapshot.r[i], pad.x, pad.y);
            *sum_x.entry(pad.net.as_str()).or_insert(0.0) += snapshot.x[i] + rx;
            *sum_y.entry(pad.net.as_str()).or_insert(0.0) += snapshot.y[i] + ry;
            *cnt.entry(pad.net.as_str()).or_insert(0.0) += 1.0;
        }
    }

    let mut grid = Grid::new(cell, board_w, board_h);
    let mut rects: Vec<(f64, f64, f64, f64)> = vec![(0.0, 0.0, 0.0, 0.0); n];
    for i in 0..n {
        let (hw, hh) = half_extents(&parts[i], st.r[i]);
        grid.insert(i, inflated_rect(st.x[i], st.y[i], hw, hh, spacing / 2.0));
        rects[i] = (st.x[i], st.y[i], hw, hh);
    }

    let cost_at = |i: usize, px: f64, py: f64, r: u16| -> f64 {
        let mut c = 0.0;
        for pad in &parts[i].pads {
            if pad.net.is_empty() {
                continue;
            }
            let w = *net_weights.get(&pad.net).unwrap_or(&1.0);
            if w <= 0.0 {
                continue;
            }
            let net = pad.net.as_str();
            let total = cnt.get(net).copied().unwrap_or(0.0);
            let others = total - 1.0;
            if others <= 0.0 {
                continue;
            }
            let (orx, ory) = rot(snapshot.r[i], pad.x, pad.y);
            let own_x = snapshot.x[i] + orx;
            let own_y = snapshot.y[i] + ory;
            let ncx = (sum_x.get(net).copied().unwrap_or(0.0) - own_x) / others;
            let ncy = (sum_y.get(net).copied().unwrap_or(0.0) - own_y) / others;
            let (rx, ry) = rot(r, pad.x, pad.y);
            let dx = px + rx - ncx;
            let dy = py + ry - ncy;
            c += w * (dx * dx + dy * dy).sqrt();
        }
        c
    };

    let order = id_order(parts);
    let mut neigh: Vec<usize> = Vec::new();
    let mut moves = 0u64;
    const OFFS: [(f64, f64); 12] = [
        (1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0),
        (1.0, 1.0), (1.0, -1.0), (-1.0, 1.0), (-1.0, -1.0),
        (2.0, 0.0), (-2.0, 0.0), (0.0, 2.0), (0.0, -2.0),
    ];

    for &i in &order {
        if parts[i].pads.len() < 2 {
            continue;
        }
        let (hw, hh) = half_extents(&parts[i], st.r[i]);
        let max_x = ((board_w / 2.0 - margin - hw) / grid_mm).floor() * grid_mm;
        let max_y = ((board_h / 2.0 - margin - hh) / grid_mm).floor() * grid_mm;
        if max_x < 0.0 || max_y < 0.0 {
            continue;
        }
        let mut best_cost = cost_at(i, st.x[i], st.y[i], st.r[i]);
        let mut best_pos: Option<(f64, f64)> = None;
        for (ox, oy) in OFFS {
            let px = (st.x[i] + ox * grid_mm).clamp(-max_x, max_x);
            let py = (st.y[i] + oy * grid_mm).clamp(-max_y, max_y);
            if px == st.x[i] && py == st.y[i] {
                continue;
            }
            let c = cost_at(i, px, py, st.r[i]);
            if c < best_cost - 1e-9 {
                neigh.clear();
                grid.neighbors(inflated_rect(px, py, hw, hh, spacing / 2.0), &mut neigh);
                neigh.sort_unstable();
                neigh.dedup();
                let mut legal = true;
                for &j in &neigh {
                    if j == i {
                        continue;
                    }
                    let (jx, jy, jw, jh) = rects[j];
                    if overlaps(spacing, px, py, hw, hh, jx, jy, jw, jh) {
                        legal = false;
                        break;
                    }
                }
                if legal {
                    best_cost = c;
                    best_pos = Some((px, py));
                }
            }
        }
        if let Some((px, py)) = best_pos {
            grid.remove(i, inflated_rect(st.x[i], st.y[i], hw, hh, spacing / 2.0));
            st.x[i] = px;
            st.y[i] = py;
            grid.insert(i, inflated_rect(px, py, hw, hh, spacing / 2.0));
            rects[i] = (px, py, hw, hh);
            moves += 1;
        }
    }
    stats.refinement_moves += moves;
    moves
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Pad, PartRole};

    fn part(id: &str, w: f64, h: f64, nets: &[&str]) -> Part {
        Part {
            id: id.into(),
            w,
            h,
            role: PartRole::Part,
            pads: nets.iter().map(|net| Pad { x: 0.0, y: 0.0, net: (*net).into() }).collect(),
        }
    }

    fn base_input(parts: Vec<Part>) -> PlacementInput {
        PlacementInput {
            parts,
            net_weights: BTreeMap::new(),
            extra_edges: Vec::new(),
            board_w: 40.0,
            board_h: 30.0,
            grid_mm: 0.5,
            margin_mm: 4.0,
            spacing_mm: Some(2.0),
            options: PlacementOptions::default(),
        }
    }

    fn sorted_parts(parts: &[Part]) -> Vec<Part> {
        let mut p = parts.to_vec();
        p.sort_by(|a, b| a.id.cmp(&b.id));
        p
    }

    fn no_overlap(parts: &[Part], out: &PlacementOutput, spacing: f64) -> bool {
        let s = sorted_parts(parts);
        for i in 0..s.len() {
            let pi = &out.positions[&s[i].id];
            let (aw, ah) = half_extents(&s[i], pi.rotation);
            for j in (i + 1)..s.len() {
                let pj = &out.positions[&s[j].id];
                let (bw, bh) = half_extents(&s[j], pj.rotation);
                let sep_x = (pj.x - pi.x).abs() + 0.011 >= aw + bw + spacing;
                let sep_y = (pj.y - pi.y).abs() + 0.011 >= ah + bh + spacing;
                if !sep_x && !sep_y {
                    return false;
                }
            }
        }
        true
    }

    #[test]
    fn places_two_connected_parts_legally() {
        let input = base_input(vec![part("R1", 2.0, 1.0, &["N1"]), part("U1", 4.0, 4.0, &["N1"])]);
        let out = place(&input).unwrap();
        assert!(out.ok);
        assert_eq!(out.positions.len(), 2);
        assert!(out.board_w > 0.0 && out.board_h > 0.0);
        assert!(out.hpwl.is_finite() && out.hpwl >= 0.0);
        assert!(no_overlap(&input.parts, &out, 2.0));
        for pos in out.positions.values() {
            assert!([0, 90, 180, 270].contains(&pos.rotation));
            assert!((pos.x / 0.5 - (pos.x / 0.5).round()).abs() < 1e-6);
            assert!((pos.y / 0.5 - (pos.y / 0.5).round()).abs() < 1e-6);
        }
    }

    #[test]
    fn reported_hpwl_matches_a_recompute() {
        let input = base_input(vec![
            part("A", 2.0, 2.0, &["N1", "N2"]),
            part("B", 2.0, 2.0, &["N1"]),
            part("C", 2.0, 2.0, &["N2"]),
        ]);
        let out = place(&input).unwrap();
        let recomputed = compute_hpwl(&sorted_parts(&input.parts), &out.positions, &input.net_weights, false);
        assert!((recomputed - out.hpwl).abs() < 1e-6, "reported {} vs recomputed {}", out.hpwl, recomputed);
    }

    #[test]
    fn is_deterministic() {
        let mk = || base_input(vec![
            part("R1", 2.0, 1.0, &["N1"]),
            part("R2", 1.6, 0.8, &["N1", "N2"]),
            part("U1", 5.0, 5.0, &["N1", "N2", "N3"]),
            part("C1", 1.0, 0.5, &["N3"]),
        ]);
        let a = place(&mk()).unwrap();
        let b = place(&mk()).unwrap();
        assert_eq!(serde_json::to_string(&a).unwrap(), serde_json::to_string(&b).unwrap());
    }

    #[test]
    fn no_courtyard_overlap_on_a_denser_board() {
        let mut parts = Vec::new();
        for i in 0..60 {
            let net = format!("N{}", i % 9);
            parts.push(part(&format!("P{i:03}"), 1.6, 0.8, &[net.as_str(), "GND"]));
        }
        let input = base_input(parts);
        let out = place(&input).unwrap();
        assert!(out.ok);
        assert!(no_overlap(&input.parts, &out, 2.0));
    }

    // ---- input-domain hardening (each pins a probe that previously misbehaved) ----

    #[test]
    fn duplicate_part_ids_are_rejected_not_collapsed() {
        // Previously: two parts sharing an id collapsed into ONE position and still reported ok=true.
        let input = base_input(vec![part("R1", 2.0, 1.0, &["N1"]), part("R1", 4.0, 4.0, &["N1"])]);
        let err = place(&input).unwrap_err();
        assert!(err.to_string().contains("duplicate part id"));
    }

    #[test]
    fn absurd_board_dimensions_are_rejected_cleanly() {
        // Previously: 10 000mm hung the force loop (O(total buckets) clears); 1e6mm aborted on a 4.9TB alloc.
        let mut input = base_input(vec![part("A", 2.0, 1.0, &["N1"]), part("B", 2.0, 1.0, &["N1"])]);
        input.board_w = 1_000_000.0;
        assert!(place(&input).unwrap_err().to_string().contains("maximum"));
    }

    #[test]
    fn max_size_board_completes_instead_of_hanging() {
        // 10 000mm is the accepted ceiling — with dirty-list clears it must complete, not hang.
        let mut input = base_input(vec![part("A", 2.0, 1.0, &["N1"]), part("B", 2.0, 1.0, &["N1"])]);
        input.board_w = MAX_BOARD_MM;
        input.board_h = MAX_BOARD_MM;
        let out = place(&input).unwrap();
        assert!(out.ok);
    }

    #[test]
    fn huge_net_weight_is_rejected_never_a_non_finite_output() {
        // Previously: a 1e300 weight overflowed positions to non-finite yet the output said ok=true
        // (serde_json serializes non-finite as null → malformed board for the caller).
        let mut input = base_input(vec![part("A", 2.0, 1.0, &["N1"]), part("B", 2.0, 1.0, &["N1"])]);
        input.net_weights.insert("N1".into(), 1e300);
        assert!(place(&input).unwrap_err().to_string().contains("net weight"));
    }

    #[test]
    fn negative_spacing_is_clamped_so_courtyards_never_overlap() {
        let mut input = base_input(vec![part("A", 4.0, 4.0, &["N1"]), part("B", 4.0, 4.0, &["N1"])]);
        input.spacing_mm = Some(-5.0);
        let out = place(&input).unwrap();
        assert!(out.ok);
        assert!(no_overlap(&input.parts, &out, 0.0)); // clamped to 0: touching allowed, overlap never
    }

    #[test]
    fn non_finite_pad_is_rejected() {
        // Unreachable via strict JSON, but the lib is WASM-portable — direct callers must be safe too.
        let mut p = part("A", 2.0, 1.0, &["N1"]);
        p.pads[0].x = f64::NAN;
        let input = base_input(vec![p, part("B", 2.0, 1.0, &["N1"])]);
        assert!(place(&input).unwrap_err().to_string().contains("non-finite pad"));
    }
}
