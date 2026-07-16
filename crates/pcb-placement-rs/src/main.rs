//! `cf-pcb-place <input.json> <output.json>` — the process-isolated placement binary.
//!
//! Contract (kept deliberately tiny + version-independent, mirrored by apps/pcb-worker's
//! rust-placement.ts bridge): read a pcb-core `PlacementInput` JSON from the first path, run the
//! kernel, write a `PlacementOutput` JSON to the second path. All diagnostics go to stderr; a non-zero
//! exit code signals failure so the worker can fall back to the proven grid placement. Running in a
//! child process means a panic here can never take the BullMQ worker down.

use std::process::ExitCode;

use pcb_placement_rs::{place, PlacementInput};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: cf-pcb-place <input.json> <output.json>");
        return ExitCode::from(2);
    }
    let input_path = &args[1];
    let output_path = &args[2];

    let raw = match std::fs::read_to_string(input_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("failed to read input {input_path}: {e}");
            return ExitCode::from(3);
        }
    };

    let input: PlacementInput = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("invalid PlacementInput JSON: {e}");
            return ExitCode::from(4);
        }
    };

    let output = match place(&input) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("placement failed: {e}");
            return ExitCode::from(5);
        }
    };

    let json = match serde_json::to_string(&output) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("failed to serialize PlacementOutput JSON: {e}");
            return ExitCode::from(6);
        }
    };

    // Write atomically-ish: a full write then rely on the caller reading only after exit 0.
    if let Err(e) = std::fs::write(output_path, json) {
        eprintln!("failed to write output {output_path}: {e}");
        return ExitCode::from(7);
    }

    ExitCode::SUCCESS
}
