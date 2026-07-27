//! The JSON wire contract between `cf-pcb-place` and the TypeScript worker — the one thing neither side
//! could previously check.
//!
//! Why this file exists. The worker validates the placer's output in `apps/pcb-worker/src/runners/
//! rust-placement.ts` (`parseOutput`), but its spec mocks `node:child_process`, so that validator only ever
//! sees JSON the test itself wrote. On this side, the in-`src` unit tests assert on Rust values, which
//! survive any `#[serde(rename)]` untouched. So a renamed field, a retyped `rotation`, or a new rotation
//! angle compiled clean, passed every test, and shipped — after which `parseOutput` threw for EVERY
//! `placer:'rust'` job. pcb-core swallows that as a warning and keeps the grid board, so the paid feature
//! would be 100% dead with nothing in any log, row, or API response saying so.
//!
//! These tests run the REAL binary (`env!("CARGO_BIN_EXE_…")`, built automatically for integration tests)
//! and assert on the JSON TEXT, so they fail on exactly the changes the Rust-value tests cannot see. They
//! encode the same rules `parseOutput` enforces — kept deliberately as literal strings, because a constant
//! shared with the serializer would rename itself alongside the bug.

use std::process::Command;

use serde_json::Value;

/// Two parts on one net — enough to exercise positions, HPWL and the rotation encoding.
const INPUT: &str = r#"{
    "parts": [
        {"id": "R1", "w": 2.0, "h": 1.0, "role": "part", "pads": [{"x": 0.0, "y": 0.0, "net": "N1"}]},
        {"id": "U1", "w": 4.0, "h": 4.0, "role": "part", "pads": [{"x": 1.0, "y": 0.0, "net": "N1"}]}
    ],
    "netWeights": {"N1": 1.0},
    "boardW": 40.0,
    "boardH": 30.0,
    "gridMm": 0.5,
    "marginMm": 4.0
}"#;

/// Run the real binary over `INPUT` and return its parsed output JSON.
///
/// `tag` MUST be unique per test: cargo runs the tests in this binary CONCURRENTLY on threads of one
/// process, so a directory named from the pid alone is shared by all of them — and each test removes it
/// on the way out, deleting the files another test is still reading.
fn run_placer(tag: &str) -> Value {
    let dir = std::env::temp_dir().join(format!("cf-wire-abi-{}-{tag}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let input_path = dir.join("in.json");
    let output_path = dir.join("out.json");
    std::fs::write(&input_path, INPUT).expect("write input");

    let status = Command::new(env!("CARGO_BIN_EXE_cf-pcb-place"))
        .arg(&input_path)
        .arg(&output_path)
        .status()
        .expect("spawn cf-pcb-place");
    assert!(status.success(), "cf-pcb-place exited with {status:?}");

    let raw = std::fs::read_to_string(&output_path).expect("read output");
    let _ = std::fs::remove_dir_all(&dir);
    serde_json::from_str(&raw).expect("output is valid JSON")
}

#[test]
fn emits_exactly_the_keys_the_typescript_bridge_expects() {
    let out = run_placer("keys");
    let obj = out.as_object().expect("output is a JSON object");

    // Written out rather than derived: the point is to break when a field is renamed, and a list built
    // from the struct would rename itself in lockstep with the bug.
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "algorithm",
            "boardH",
            "boardW",
            "engine",
            "hpwl",
            "notes",
            "ok",
            "positions",
            "protocolVersion",
            "stats",
            "weightedHpwl",
        ],
        "the wire shape changed — apps/pcb-worker/src/runners/rust-placement.ts parses these names"
    );
}

#[test]
fn the_six_fields_the_bridge_validates_carry_the_types_it_requires() {
    let out = run_placer("types");
    assert!(out["ok"].is_boolean(), "`ok` must be a JSON boolean");
    assert!(out["boardW"].as_f64().is_some_and(|v| v > 0.0), "`boardW` must be a positive number");
    assert!(out["boardH"].as_f64().is_some_and(|v| v > 0.0), "`boardH` must be a positive number");
    assert!(out["hpwl"].as_f64().is_some_and(|v| v >= 0.0), "`hpwl` must be a non-negative number");
    assert!(
        out["notes"].as_array().is_some_and(|a| a.iter().all(Value::is_string)),
        "`notes` must be an array of strings"
    );
    assert!(out["positions"].is_object(), "`positions` must be an object keyed by part id");
}

#[test]
fn positions_are_keyed_by_the_input_part_ids_and_nothing_else() {
    let out = run_placer("ids");
    let positions = out["positions"].as_object().expect("positions object");
    let mut ids: Vec<&str> = positions.keys().map(String::as_str).collect();
    ids.sort_unstable();
    // parseOutput rejects an unknown id outright, and requires every input id when ok=true.
    assert_eq!(ids, vec!["R1", "U1"], "positions must be keyed by the ids the caller sent");
}

#[test]
fn every_position_carries_finite_x_y_and_a_rotation_the_bridge_accepts() {
    let out = run_placer("rotation");
    for (id, position) in out["positions"].as_object().expect("positions object") {
        assert!(position["x"].as_f64().is_some_and(f64::is_finite), "{id}: x must be a finite number");
        assert!(position["y"].as_f64().is_some_and(f64::is_finite), "{id}: y must be a finite number");
        // parseOutput compares rotation against the literals 0/90/180/270 — so it must arrive as a JSON
        // NUMBER in that set. A string, a float like 90.0, or a 45° angle all throw on the other side.
        let rotation = position["rotation"].as_u64().unwrap_or_else(|| {
            panic!("{id}: rotation must be a JSON integer, got {}", position["rotation"])
        });
        assert!(
            matches!(rotation, 0 | 90 | 180 | 270),
            "{id}: rotation {rotation} is outside the set the TypeScript bridge accepts"
        );
    }
}

#[test]
fn a_malformed_request_fails_loudly_instead_of_emitting_a_half_output() {
    // The worker treats a non-zero exit as "fall back to grid". Silently writing a partial output would
    // instead hand the bridge something to misparse.
    let dir = std::env::temp_dir().join(format!("cf-wire-abi-{}-malformed", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let input_path = dir.join("in.json");
    let output_path = dir.join("out.json");
    std::fs::write(&input_path, "{ not json").expect("write input");

    let status = Command::new(env!("CARGO_BIN_EXE_cf-pcb-place"))
        .arg(&input_path)
        .arg(&output_path)
        .status()
        .expect("spawn cf-pcb-place");
    assert!(!status.success(), "a malformed input must exit non-zero");
    assert!(!output_path.exists(), "no output file may be written for a rejected input");
    let _ = std::fs::remove_dir_all(&dir);
}
