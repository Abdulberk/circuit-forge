# Simulation Playback Animation — Architecture

> Companion to `FRONTEND_BRIEF.md`. Specifies how the schematic editor animates a simulation
> (current-flow dots + node-voltage coloring) scrubbed over the transient timeline. Grounded in the
> **real** eda-core result contract — every claim below cites how the data actually arrives, and every
> gap is flagged honestly. Nothing here invents data the simulator does not produce.

---

## 0. Decisions (locked)

| # | Decision | Why |
|---|---|---|
| D1 | **Playback of a completed simulation, never a second in-browser solver.** | One source of truth = server ngspice. A browser solver would be a *second* truth that disagrees — the exact failure mode we refuse. |
| D2 | **Node-voltage coloring is the primary, always-available animation.** | Every node voltage is returned by default (≤64 nodes). Works for 100% of circuits today, zero backend change. |
| D3 | **Current-flow dots animate real, measured branch current — across active devices too.** | PROVEN by a real-ngspice spike (§4.2): `savecurrents` yields diode/BJT/MOSFET/JFET terminal currents (`@d1[id]`, `@q1[ic]`, `@m1[id]`…) in batch `tran`. The earlier "passives only" limit was **our generator's** allowlist, not the engine. We extend it (tested per device) so flow is real across the whole board. |
| D4 | **Only genuinely-opaque branches (deep subckt internals) are shown static/dim — never invented flow.** | Consistent with the project's core rule: real data or an honest blank, never a plausible lie. The opaque set is now small (op-amp macromodel internals), not "every active device". |
| D5 | **`tran` is the only true playback timeline.** | Its x-axis is time. `ac` (frequency), `dc` (sweep), `op` (point) are not time playback. |
| D6 | **Rendering: SVG schematic + a Canvas/WebGL overlay for flow particles.** | SVG for crisp, hit-testable symbols/wires; Canvas/WebGL for hundreds of moving dots at 60 fps without DOM churn. |

---

## 1. Core principle: replay, not re-simulate

The simulation is a **batch job**: the server runs ngspice once and returns the *entire* time history of
the circuit. The animation is a **DVR/replay** of that recording — press play and watch the recorded run;
pause, scrub to t = 3.7 ms, slow-mo. The moving dots and colors are **read from the recording**, not
recomputed live.

**Why this and not a live browser engine:** a client-side solver would produce a *second* result that can
disagree with the server's ngspice (different engine, different tolerances). Two verdicts on the same
circuit is the one outcome we will not ship. So: **one recording (server ngspice), one player (frontend).**
Visually it looks as alive as Falstad/Flux; underneath there is a single truth. (See `FRONTEND_BRIEF.md`
§ save-model and the "two sources of truth" note.)

---

## 2. What the animation shows

1. **Node-voltage field** — every wire/net tinted by its instantaneous voltage (a diverging color scale,
   e.g. negative → 0 → positive), updated as the playhead moves. This is the "heat map" of the board and
   is available for **every** circuit.
2. **Current-flow dots** — dots/dashes travelling along wires at a speed/density proportional to the
   branch current magnitude, in the direction of conventional current. Available on the branches we can
   measure (§4).
3. **Transport + scrubber** — play / pause / step, a speed control (0.1×–10× wall-clock, plus "fit to N
   seconds"), and a draggable timeline showing the transient span with the current playhead.
4. **Value readout** — hovering a node/branch shows its value at the playhead (reuses the same series the
   waveform viewer already plots — one data set, two views).

---

## 3. The data contract (grounded)

The client already receives everything below from `GET /simulations/:jobId/result`
(`apps/api/src/simulation/simulation.service.ts:436-446`): the response is
`{ id, status, result, metrics }` where `result` is the **full** `SimulationResult`, S3-hydrated.

### 3.1 Shape (`packages/eda-core/src/types/simulation.ts`)
```
SimulationResult = { meta: ResultMeta, series: DataSeries[], /* report-only extras */ }
ResultMeta       = { analysisType, xLabel, xUnit?, pointsCount, downsampledFrom?, simulationTime? }
DataSeries       = { name: string, unit?: string, points: DataPoint[] }
DataPoint        = { x: number, y: number }
```
- **Time is `point.x`** — there is no separate time vector. Build the shared timeline from
  `series[0].points[i].x` (all series share the same x grid for a given run).
- **Voltage vs current is encoded only in `name`** — `v(...)` = a node voltage; `i(...)` / `@dev[i]` = a
  branch current. There is no `kind` field. (`DataSeries.unit` is declared but not populated today — do
  **not** rely on it; classify by name.)
- Names are **lowercased sanitized tokens** (see § 3.3), e.g. net `out` → `v(x_out)`, net `n1` → `v(nn1)`;
  currents as `i(v1)` or `@r1[i]`.

### 3.2 Timeline resolution
- The persisted result is capped at **~20 000 points/series** (`WORKER_MAX_POINTS`,
  `apps/worker-sim/src/config.ts:48`), min-max-bucketed so peaks survive (`utils/downsample.ts`).
- `?maxPoints` on the result endpoint re-decimates on read (10..100000) — the animation can request a
  lighter set for very long transients.
- `meta.downsampledFrom` (when present) is the true pre-decimation count — show it if you surface fidelity.

### 3.3 Mapping a series back to the schematic
The transform between a `Net`/`Component` and a series name is **already implemented** in
`packages/eda-core/src/analysis/assertions.ts` — reuse it, don't reinvent:
- `netIdByRef(nets)` (`assertions.ts:76-81`) → `{ name→id, id→id }`.
- `nodeKey('v(' + netId + ')')` (`assertions.ts:63-68`) → the sanitized, lowercased node token to match
  against a `v(...)` series. (Sanitization: `netlist/sanitizer.ts` — reserved words like `out/in/gnd` get
  an `x_` prefix, leading digits get `n`, etc.)
- `currentKey('i(r1)' | '@r1[i]')` (`assertions.ts:95-102`) → the device designator (lowercased), matched
  against `Component.designator`.
- **Caveat:** the generator may prefix a device instance name (`spiceInstanceName`,
  `generator.ts:580-583`, e.g. `Z1`→`dz1`). A robust current match applies the same prefix rule
  (tracked in `designatorToInstance`, `generator.ts:243`).

**Voltage → wire:** resolve each net's node token; every `Component.pins[]` whose `netId` maps to that net
is on that wire → tint those wire segments.
**Current → component:** `currentKey(series.name)` → the component; the pins it flows between are
`Component.pins[]` in canonical `COMPONENT_PINS[type]` order (`types/circuit.ts:196-243`).

---

## 4. What's animatable today — and the honest current gap

### 4.1 Node voltages — FULL coverage (no backend change)
`generateDefaultProbes` (`generator.ts:966-984`) emits `v(node)` for **every non-ground net**, capped at
`MAX_DEFAULT_PROBES = 64`. So voltage coloring works for essentially every circuit out of the box. Circuits
with >64 nets: the first 64 are probed — surface a "voltage shown for N of M nets" note (rare in practice).

### 4.2 Branch currents — broadly available once the generator emits them (PROVEN)
Today `rewriteCurrentProbeVector` (`generator.ts:632-647`) only keeps **V/L/E/H** (native `i(dev)`) and
**R/C** (`@dev[i]` under `.options savecurrents`, `generator.ts:430`); diodes/transistors/subckts are
**dropped** (`generator.ts:646`). That was read as an engine limit — **it is not.** A real-ngspice spike
(diode + BJT + MOSFET, `.options savecurrents`, `.tran`, console build) returned live per-timestep terminal
currents:
```
@d1[id]  = 4.31 mA     @q1[ic] = 4.90 mA   @q1[ib] = 0.174 mA   @q1[ie]  (present)
@m1[id]  (present)     @m1[is] (present)
```
So batch ngspice **does** expose diode/BJT/MOSFET/JFET terminal currents. The fix is a **generator
extension**: broaden the current-probe allowlist to emit device-terminal vectors (`@d[id]`, `@q[ic|ib|ie]`,
`@m[id|is]`, JFET analogues) under `savecurrents`, gated — per project discipline — by a **real-ngspice
regression cell per device type** (the coverage-matrix pattern). This is a small backend addition on the
scale of the layout/working-copy changes, and it unlocks real current-flow across the circuits that matter.

**Still genuinely opaque:** the *internal* branches of a subckt macromodel (e.g. inside an op-amp `.subckt`)
— you see its pin nets, not its internals. And a device with no series element and no exposed vector. Those
fall to the tiers below. The classic EE escape hatch (a series **sense resistor**, `generator.ts:414-419`)
remains available where a user wants an explicit, guaranteed probe.

### 4.3 The decision: three honest tiers, never fake (D3/D4)
1. **Measured** — a real ngspice series exists for the branch (V/L/E/H/R/C today; **+ D/Q/M/J** after the
   §4.2 extension). Animate flow: speed/density ∝ |i|, direction from sign.
2. **KCL-inferred** — the branch current equals an exact arithmetic combination of measured neighbours
   (a device in series with a probed element; the sole unknown branch at a node). Deterministic on the
   returned series — *not* a second simulation, *not* a guess.
3. **Honest-blank** — genuinely unknowable (deep inside an opaque subckt) → shown **static/dim** with a
   tooltip "current not measured here — add a series sense resistor to probe it." No invented dots.

This keeps the core promise intact: real data or an honest blank, never a plausible lie. After the §4.2
extension, tier 3 shrinks to a small residue (mostly op-amp macromodel internals).

### 4.4 Current direction (sign)
ngspice current is signed by device pin order; `assertions.ts:236-246` deliberately takes *magnitudes* for
verdicts, so **no existing helper gives you signed/directional current.** Derive direction from the sign of
`point.y` combined with the canonical pin order (`COMPONENT_PINS[type]`) and ngspice's convention (current
into the first listed pin is positive for most two-terminals). This lives in the new mapping module (§8).

---

## 5. Getting the right data — the "animatable run" probe set

Node voltages come for free, but **currents must be requested** — `options.probes` replaces the defaults;
`options.extraProbes` unions with them (`generator.ts:386-390`). The plain version-sim endpoint sends only
the user's `probes`; it does **not** auto-union currents.

**Plan:** when the user opens the "animate" view for a version, submit (or reuse) a `tran` run whose probe
set is *defaults (all node voltages) ∪ branch currents for every probeable device (R/C/V/L/E/H)*. Build
that current list from the CircuitJson (walk components, keep the probeable device types, emit `i(desig)`).
This mirrors the existing `extraProbesForCriteria` pattern (`assertions.ts:124-126`) but is
"all probeable currents" rather than "currents named by acceptance criteria."

- If a suitable `tran` result **already exists** for the version, reuse it (don't re-run).
- The animatable run is a normal simulation job (queue, poll, S3-hydrate) — no new backend contract needed,
  just the probe set. (A small convenience endpoint/flag "run for animation" could be added later; not
  required for v1.)

---

## 6. Rendering architecture

Three stacked layers, bottom to top:

1. **Schematic layer (SVG).** Components as SVG symbols, wires as SVG paths. Crisp at any zoom,
   hit-testable (hover/select), reused by the static editor. Wire segments carry their net id as data so
   the voltage layer can tint them.
2. **Voltage layer.** Recolor wire strokes + optional node glows from the per-frame voltage map. Cheap:
   it's attribute updates on existing SVG paths (or a tint pass). A shared diverging color scale
   (colorblind-safe) maps voltage → color; the legend shows the scale + range for the current frame.
3. **Flow layer (Canvas/WebGL overlay), same coordinate space as the SVG.** Particles travel along
   precomputed wire polylines; per wire, spawn rate and speed ∝ |i|, direction from sign. Canvas/WebGL so
   hundreds of dots animate at 60 fps without creating/destroying DOM nodes. `prefers-reduced-motion` →
   dots freeze into static arrows at the playhead.

**Transport & frame model:**
- Precompute, once per result: the sorted **time grid** `T = [x0, x1, …]`, a `voltageByNet[frame][netId]`
  lookup, and a `currentByComponent[frame][designator]` lookup (built via the §8 mapping). This is O(points
  × series) once, then O(1) per frame.
- Playback uses `requestAnimationFrame`: map wall-clock → sim-time by the speed factor, find the bracketing
  samples, and **linearly interpolate** voltage (and dot phase) between them so motion is smooth even though
  samples are ~20k discrete points. Scrubbing sets sim-time directly.
- One playhead drives voltage tint, dot motion, and the waveform-viewer cursor together (single clock).

---

## 7. Performance & limits

- **Frame data ceiling ≈ 20k points/series** (§3.2). For N nets + M currents that's ≤ (64+M) × 20k numbers
  — a few MB, fine to hold in memory. For very long transients, request a lighter set via `?maxPoints`.
- **Interpolation, not per-sample frames:** 20k samples over a 5 s wall-clock playback ≈ 4k fps of data —
  far more than the display needs. Interpolate between the two samples bracketing the playhead; never
  render per-sample.
- **Flow particles:** cap total particles (e.g. ≤ ~1–2k) and scale per-wire density down when a board is
  dense; Canvas/WebGL keeps this off the DOM/React reconciler.
- **Downsampling preserves peaks** (min-max bucketing) — glitches/spikes remain visible in playback.
- **>64-net circuits:** voltage shown for the probed subset; state it, don't hide it.

---

## 8. The mapping module (to build)

A pure, deterministic module `result → frames` — the only genuinely new logic. It composes the existing
`assertions.ts` helpers (§3.3) and adds what they don't provide:
```
buildPlaybackModel(circuit: CircuitJson, result: SimulationResult) => {
  time: number[];                                  // shared x grid
  voltageByNet: Map<netId, number[]>;              // per-frame node voltage (from v(...) series)
  currentByComponent: Map<designator, {            // per-frame branch current, where measurable
    magnitude: number[]; direction: 1 | -1 | 0[];  // sign resolved via COMPONENT_PINS + ngspice convention
    source: 'measured' | 'inferred';               // KCL-inferred branches flagged, never faked
  }>;
  unmeasured: designator[];                         // branches shown static/dim (honest blank)
}
```
- Voltage: `netIdByRef` + `nodeKey` to match each net to its `v(...)` series.
- Current: `currentKey` (+ the `spiceInstanceName` prefix rule) to match each series to a component;
  KCL inference for series-path devices; sign from pin order.
- **Where it lives:** ideally a new file in `packages/eda-core/src/analysis/` (e.g. `playback.ts`) so the
  mapping is shared, unit-tested against real results, and versioned with the schema — *not* re-derived in
  the frontend. It is pure (no I/O), matching eda-core's design.

---

## 9. Analysis-type support

| Analysis | Playback? | x-axis | Use |
|---|---|---|---|
| **`tran`** | ✅ true timeline | time (s) | current-flow + voltage animation (the feature) |
| `dc` sweep | ⚠️ scrubbable, but x = swept source value, not time | V | "sweep scrubber" (nice-to-have, later) |
| `ac` | ❌ | frequency (Hz) | Bode plot in the waveform viewer, not board animation |
| `op` | ❌ single point | — | static voltage/current annotation on the board (no motion) |
| `noise`, `sens` | ❌ | — | report views only |

`op` is worth a **static** variant: label each node with its DC voltage and each measurable branch with
its DC current — the same mapping module, one frame.

---

## 10. Connection to versions / working copy

- Animation runs against a **saved version's** `tran` result (stable, shareable). The working copy (the
  live draft, see `FRONTEND_BRIEF.md`) is what the user edits; to animate, they save/run a version (or run
  an ad-hoc sim of the current draft) — the animation consumes whatever simulation result it's given.
- Because a layout/sim is now linkable to a version (`GET /simulations` by version, and the new
  `GET /layouts?versionId=`), the animate view can find "the latest tran result for this version" and reuse
  it instead of re-running.

---

## 11. What EXISTS vs what is MISSING

**EXISTS (backend, today):**
- Full `tran` result with all node voltages by default (≤64) + any requested branch currents, S3-hydrated
  via `GET /simulations/:jobId/result`.
- The name↔id/designator mapping helpers in `assertions.ts`.
- Decimation to a bounded, peak-preserving ≤20k-point series.

**MISSING (to build for the feature):**
- **Generator current-probe extension** (§4.2/§12) — emit D/Q/M/J terminal-current vectors under
  `savecurrents`, tested per device type. Small backend change; capability already proven.
- The `buildPlaybackModel` mapping module (§8) — including current-sign resolution and KCL inference (new).
- The "animatable run" probe-set builder (§5) — union all probeable device currents (new, small).
- The entire frontend: SVG schematic symbols + wire routing (shared with the editor), the voltage tint
  pass, the Canvas/WebGL flow layer, the transport/scrubber, and the frame interpolation loop.

**HONEST LIMIT (small, after the extension):**
- The *internal* branches of an opaque subckt (e.g. an op-amp macromodel) are not individually probeable;
  those show static/dim with a "add a sense resistor" hint. Everything with an exposed device vector
  (passives, sources, diodes, transistors) animates for real.

---

## 12. Backend extension — device-terminal currents (recommended, capability PROVEN)

Real current-flow across active devices is the difference between a flagship feature and one that stalls at
every transistor. A real-ngspice spike (§4.2) confirms batch mode exposes `@d[id]`, `@q[ic|ib|ie]`,
`@m[id|is]` (and JFET analogues) under `.options savecurrents`. So this is a **recommended backend
addition**, not a risky maybe:

- **Where:** the current-probe allowlist — `SAVECURRENTS_DEVICES` (`generator.ts:619`) and
  `rewriteCurrentProbeVector` (`generator.ts:632-647`). Emit the terminal vector for each supported device
  type (choose the animation-relevant terminal, e.g. BJT `ic`/MOSFET `id` for the main conduction path).
- **Discipline (non-negotiable):** one **real-ngspice regression cell per added device type** in the
  coverage matrix (`pnpm test:matrix`/`test:edge`), asserting the vector is emitted and finite — the same
  bar every other analysis crossed. A device/model that doesn't cleanly expose a current stays dropped
  (→ tier 2/3), never faked.
- **Scope:** sits alongside the layout-linkage / working-copy backend additions in size. Do it as its own
  branch + real e2e, like those.

Truly opaque internals (subckt macromodel guts) remain out — handled honestly by §4.3 tiers 2–3.
