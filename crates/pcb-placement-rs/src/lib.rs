//! Circuit Forge's standalone Rust PCB placement kernel.
//!
//! The public ABI deliberately mirrors `packages/pcb-core/src/placement.ts`: millimetres in,
//! millimetres out, camelCase JSON at the process boundary.  The implementation is independent of
//! the TypeScript placer so both engines can be benchmarked and deployed side-by-side.

mod model;
mod placer;
mod spatial;

pub use model::{
    ExtraEdge, Pad, Part, PartRole, PlaceError, PlacementInput, PlacementOptions, PlacementOutput,
    PlacementStats, Position,
};
pub use placer::place;

