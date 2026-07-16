//! Dense uniform spatial grid for near-neighbour queries — no hashing on the hot path.
//!
//! A `HashMap`-backed hash would pay SipHash on every cell touch; the placer does millions of cell
//! touches per solve, so instead we bucket into a flat `Vec<Vec<usize>>` addressed by integer cell
//! coordinates over a bounded window `[-span, +span]`. Coordinates outside the window are CLAMPED to the
//! border cells — that only ever OVER-groups parts (adds false candidates the caller's precise clearance
//! test rejects), so it can never miss a real overlap. Buckets are reused across rebuilds (`clear` keeps
//! their capacity), keeping the force loop allocation-free.
//!
//! Determinism is the CALLER's responsibility: it visits parts in index order and sorts each neighbour
//! list. Any two AABBs that overlap always share at least one cell (each is rasterised into every cell it
//! touches), so a neighbour query is a complete superset of the true overlaps.

#[derive(Clone, Copy)]
pub(crate) struct Rect {
    pub min_x: f64,
    pub max_x: f64,
    pub min_y: f64,
    pub max_y: f64,
}

pub(crate) struct Grid {
    cell: f64,
    origin_x: f64,
    origin_y: f64,
    cols: i64,
    rows: i64,
    buckets: Vec<Vec<usize>>,
}

impl Grid {
    /// Cover `[-span_x, span_x] × [-span_y, span_y]` at `cell` resolution. `span_*` should comfortably
    /// contain every coordinate the caller will insert/query (border clamping keeps it correct if not).
    pub(crate) fn new(cell: f64, span_x: f64, span_y: f64) -> Self {
        let cell = cell.max(1e-6);
        let cols = ((2.0 * span_x.max(cell)) / cell).ceil() as i64 + 1;
        let rows = ((2.0 * span_y.max(cell)) / cell).ceil() as i64 + 1;
        let cols = cols.max(1);
        let rows = rows.max(1);
        Grid {
            cell,
            origin_x: -span_x.max(cell),
            origin_y: -span_y.max(cell),
            cols,
            rows,
            buckets: vec![Vec::new(); (cols * rows) as usize],
        }
    }

    pub(crate) fn clear(&mut self) {
        for bucket in &mut self.buckets {
            bucket.clear();
        }
    }

    #[inline]
    fn col(&self, x: f64) -> i64 {
        (((x - self.origin_x) / self.cell).floor() as i64).clamp(0, self.cols - 1)
    }
    #[inline]
    fn row(&self, y: f64) -> i64 {
        (((y - self.origin_y) / self.cell).floor() as i64).clamp(0, self.rows - 1)
    }
    #[inline]
    fn idx(&self, c: i64, r: i64) -> usize {
        (r * self.cols + c) as usize
    }

    pub(crate) fn insert(&mut self, index: usize, rect: Rect) {
        let c0 = self.col(rect.min_x);
        let c1 = self.col(rect.max_x);
        let r0 = self.row(rect.min_y);
        let r1 = self.row(rect.max_y);
        for r in r0..=r1 {
            for c in c0..=c1 {
                let i = self.idx(c, r);
                self.buckets[i].push(index);
            }
        }
    }

    pub(crate) fn remove(&mut self, index: usize, rect: Rect) {
        let c0 = self.col(rect.min_x);
        let c1 = self.col(rect.max_x);
        let r0 = self.row(rect.min_y);
        let r1 = self.row(rect.max_y);
        for r in r0..=r1 {
            for c in c0..=c1 {
                let i = self.idx(c, r);
                let bucket = &mut self.buckets[i];
                if let Some(pos) = bucket.iter().position(|&v| v == index) {
                    bucket.swap_remove(pos);
                }
            }
        }
    }

    /// Append every index stored in a cell the rect touches (may contain duplicates and `index` itself);
    /// the caller sorts / dedups / filters. Grows `out` in place — no per-call allocation.
    pub(crate) fn neighbors(&self, rect: Rect, out: &mut Vec<usize>) {
        let c0 = self.col(rect.min_x);
        let c1 = self.col(rect.max_x);
        let r0 = self.row(rect.min_y);
        let r1 = self.row(rect.max_y);
        for r in r0..=r1 {
            for c in c0..=c1 {
                let i = self.idx(c, r);
                out.extend_from_slice(&self.buckets[i]);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neighbours_include_overlapping_and_exclude_far() {
        let mut g = Grid::new(2.0, 30.0, 30.0);
        g.insert(2, Rect { min_x: 0.0, max_x: 3.0, min_y: 0.0, max_y: 3.0 });
        g.insert(0, Rect { min_x: 1.0, max_x: 4.0, min_y: 1.0, max_y: 4.0 });
        g.insert(1, Rect { min_x: 20.0, max_x: 21.0, min_y: 20.0, max_y: 21.0 });
        let mut out = Vec::new();
        g.neighbors(Rect { min_x: 0.0, max_x: 3.0, min_y: 0.0, max_y: 3.0 }, &mut out);
        out.sort_unstable();
        out.dedup();
        assert!(out.contains(&0) && out.contains(&2));
        assert!(!out.contains(&1));
    }

    #[test]
    fn remove_then_query_drops_the_index() {
        let mut g = Grid::new(2.0, 30.0, 30.0);
        let r = Rect { min_x: 0.0, max_x: 1.0, min_y: 0.0, max_y: 1.0 };
        g.insert(5, r);
        g.remove(5, r);
        let mut out = Vec::new();
        g.neighbors(r, &mut out);
        assert!(!out.contains(&5));
    }

    #[test]
    fn out_of_window_coordinates_clamp_without_panicking() {
        let mut g = Grid::new(2.0, 10.0, 10.0);
        let far = Rect { min_x: 1e6, max_x: 1e6 + 1.0, min_y: -1e6, max_y: -1e6 + 1.0 };
        g.insert(7, far);
        let mut out = Vec::new();
        g.neighbors(far, &mut out); // clamps to a border cell, no panic
        assert!(out.contains(&7));
    }
}
