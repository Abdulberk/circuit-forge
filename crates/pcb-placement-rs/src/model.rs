use serde::{Deserialize, Serialize};
use std::fmt::{Display, Formatter};

fn default_starts() -> usize {
    4
}

fn default_force_steps() -> usize {
    180
}

fn default_refine_passes() -> usize {
    2
}

/// Optional, bounded tuning surface.  Defaults are part of algorithm `multistart-spatial-v1`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlacementOptions {
    /// Number of deterministic initial arrangements evaluated. Range: 1..=16.
    pub starts: usize,
    /// Force/barycentric optimization iterations per start. Range: 20..=1000.
    pub force_steps: usize,
    /// Discrete legal local-improvement passes. Range: 0..=8.
    pub refine_passes: usize,
}

impl Default for PlacementOptions {
    fn default() -> Self {
        Self {
            starts: default_starts(),
            force_steps: default_force_steps(),
            refine_passes: default_refine_passes(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PartRole {
    Part,
    Connector,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pad {
    pub x: f64,
    pub y: f64,
    pub net: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub id: String,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub pads: Vec<Pad>,
    pub role: PartRole,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraEdge {
    pub a: String,
    pub b: String,
    pub weight: f64,
}

/// JSON request. Field names intentionally match pcb-core's `PlacementInput`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacementInput {
    pub parts: Vec<Part>,
    #[serde(default)]
    pub net_weights: std::collections::BTreeMap<String, f64>,
    #[serde(default)]
    pub extra_edges: Vec<ExtraEdge>,
    pub board_w: f64,
    pub board_h: f64,
    pub grid_mm: f64,
    pub margin_mm: f64,
    pub spacing_mm: Option<f64>,
    #[serde(default)]
    pub options: PlacementOptions,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub x: f64,
    pub y: f64,
    pub rotation: u16,
}

/// Deterministic counters only: wall-clock timings are intentionally measured by the caller so
/// repeated identical requests produce identical JSON.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlacementStats {
    pub starts: usize,
    pub selected_start: usize,
    pub force_steps_per_start: usize,
    pub spatial_candidate_pairs: u64,
    pub legalizer_probes: u64,
    pub refinement_moves: u64,
}

/// JSON response. The first six fields are a strict superset of pcb-core's `PlacementOutput`.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlacementOutput {
    pub positions: std::collections::BTreeMap<String, Position>,
    pub board_w: f64,
    pub board_h: f64,
    pub hpwl: f64,
    pub notes: Vec<String>,
    pub ok: bool,
    pub weighted_hpwl: f64,
    pub protocol_version: u32,
    pub engine: &'static str,
    pub algorithm: &'static str,
    pub stats: PlacementStats,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaceError(pub String);

impl PlaceError {
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for PlaceError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PlaceError {}

