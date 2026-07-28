# Circuit Forge — PCB Editor Frontend Brief

> **Extends `FRONTEND_BRIEF.md`.** That brief (2700 lines) already covers auth, orgs, projects/versions,
> the schematic editor, simulation, AI generation, assets, and the shared `CircuitJson` / `AnalysisConfig`
> / `SimulationResult` data model. It has **zero** coverage of the PCB layer. This document adds exactly
> that: the Flux.ai-style **PCB editor** — the `/layouts` long-running job, the `LayoutGeometry` render
> contract, DRC review, ratsnest airwires, the 3D GLB, and manufacturing outputs — plus how they slot into
> the existing editor. Read `FRONTEND_BRIEF.md` first; this is the PCB extension, not a replacement.

Every contract below was read from the live backend (`apps/api/src/layout`, `apps/pcb-worker`,
`packages/pcb-core`) on 8 Jul 2026. Field names and types are exact. Where a capability does **not** exist
yet, it is called out — do not design UI that assumes it.

---

## 0. Corrections to `FRONTEND_BRIEF.md` (drift since 1 Jul)

The old brief's §6 predates recent `eda-core` additions. Fix these when you build the shared types:

1. **`ComponentType` is 32 values, not 28.** Added: `jkff`, `tff`, `dlatch`, `tristate` (digital logic).
   Source of truth: `COMPONENT_TYPES` const tuple in `packages/eda-core/src/types/circuit.ts`.
2. **`AnalysisConfig` is a 6-member union, not 4.** Added: `noise` and `sens`. Full set: `tran`, `ac`,
   `dc`, `op`, `noise`, `sens`.
3. **`SimulationResult` carries 5 extra optional, report-only blocks** beyond `meta` + `series`:
   `fourier?`, `measurements?`, `transferFunction?`, `noise?`, `sensitivity?`. They do **not** gate
   pass/fail, but the results viewer should model and display them.

Always import the types from `@circuit-forge/eda-core` (connectivity/sim) and `@circuit-forge/pcb-core`
(PCB geometry) rather than hand-copying — see §7.

---

## 1. The three-layer data model (the single source of truth)

The whole app rests on **three separate models**. Keeping them separate is the architectural contract that
guarantees the frontend and backend never disagree.

| Layer | Type | Package | Who authors it | What it is |
|-------|------|---------|----------------|------------|
| **1. Connectivity** | `CircuitJson` | `eda-core` | the user (schematic editor / AI) | Electrical truth: `components[]`, `nets[]`, `models[]`. Two pins are connected **iff** they share a `netId`. No node list. |
| **2. Schematic view** | `UiJson` | `eda-core` | the user (schematic editor) | Render state of the *schematic*: `viewport`, `positions` (keyed by `Component.id`), `wires` (keyed by `Net.id`). Never affects electrical truth. |
| **3. PCB physical** | `LayoutGeometry` | `pcb-core` | **the backend only** | The physical board: placed components, pads, copper traces, vias. The frontend **renders** it; it never authors it. |

**The load-bearing rule:** the frontend POSTs Layer 1 (`CircuitJson`) to `/layouts` and **renders whatever
the worker returns**. Placement and routing are 100% backend. This is why FE and BE can never drift on the
board — there is exactly one shaper (`shapeLayoutResult`) and one engine (`layoutCircuit`), both server-side.

**Cross-probe keys** (how the three layers reference each other — critical for hover/select sync):
- `LayoutComponent.id` → `CircuitJson` `Component.id` (via the worker's `namesById` map). **Guard:** when a
  component has no resolvable geometry the id *falls back to the emitted (sanitized) name* — so treat
  `LayoutComponent.designator` as the stable human key for cross-probe, not `.id`.
- `LayoutComponent.designator` === `Component.designator` (e.g. `R1`, `U3`) — the reliable join.
- `LayoutPad.net` / `LayoutTrace.net` / `LayoutVia.net` = the **emitted, sanitized net NAME** (derived from
  `Net.name`), **never** `Net.id`. To color/label by net, match on sanitized names.
- `LayoutPad.pin` = best-effort schematic pin ref (`PinConnection.pinId`); may be `null`.

---

## 2. The Flux.ai-style editor shell

The reference is the Flux.ai PCB editor screenshot: **Files / Schematic / PCB** tabs, a **2D / 3D / Layer**
toolbar, a **Reviews** panel (Airwires • Overlapping Copper • Dangling Traces), and **Objects / Rules /
Library** side panels. Here is how each maps to Circuit Forge's backend.

```
┌ Tabs ───────────────────────────────────────────────────────────────────────┐
│ Files          Schematic            PCB  ◄── this brief                       │
├───────────────────────────────────────────────────────────────────────────────┤
│ [2D] [3D] [Layers▾]                                            Reviews  ▸      │
│                                                                                │
│   ┌ canvas ─────────────────────────────────┐   ┌ Reviews ──────────────────┐ │
│   │  board outline, components (courtyards), │   │ Airwires • N              │ │
│   │  pads, traces, vias, ratsnest airwires   │   │ Clearance • N             │ │
│   │  — OR — three.js GLB (3D mode)           │   │ Via/Drill • N ...         │ │
│   └─────────────────────────────────────────┘   └───────────────────────────┘ │
│   ┌ Objects ──────┐ ┌ Rules ────────┐ ┌ Library ───────────────────────────┐  │
│   │ components +  │ │ fabProfile +  │ │ parts catalog (GET /parts/*)       │  │
│   │ nets tree     │ │ netCurrentsA  │ │                                    │  │
│   └───────────────┘ └───────────────┘ └────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘
```

| Editor element | Backed by |
|----------------|-----------|
| **Files / Schematic tabs** | `FRONTEND_BRIEF.md` §2.3–§2.6 (projects/versions + schematic editor + sim) |
| **PCB tab** | this brief — `/layouts` LRO → `LayoutGeometry` |
| **2D canvas** | `result.layout` (board/components/pads/traces/vias) rendered as SVG/Canvas/WebGL |
| **3D view** | the presigned `glbUrl` (a `.glb`), rendered with three.js — see `apps/pcb-viewer` (§10) |
| **Layers toggle** | `result.layout.layers[]` (`top`/`bottom`) + `pad.layers` / `trace.segments[].layer` |
| **Reviews panel** | `result.checks[]` (DRC violations) + `result.airwires[]` (ratsnest) + `result.drcClean` |
| **Objects panel** | `result.layout.components[]` + the source `CircuitJson.nets[]` |
| **Rules panel** | the `fabProfile` + `netCurrentsA` inputs you send on POST /layouts (§4, §12) |
| **Library panel** | parts catalog — `GET /parts/*` (`FRONTEND_BRIEF.md` route map) |

---

## 3. The PCB workflow, end to end

```
(schematic editor / AI)                      (this brief)
  author CircuitJson  ──save──►  ProjectVersion.circuitJson
        │                              │
        │ simulate (optional)          │ open PCB tab
        ▼                              ▼
  SimulationResult              POST /layouts { circuit: <that CircuitJson>, placer?, fabProfile?, netCurrentsA? }
  (waveforms)                          │  ← 202 { jobId, status:'QUEUED' }
                                       ▼
                            poll GET /layouts/:jobId  (every few seconds)
                                       │
                    QUEUED → RUNNING → SUCCEEDED
                                       ▼
             render result.layout (2D) ─┬─ download glbUrl (3D)
                        │               └─ download gerbersUrl (manufacturing bundle)
                        ▼
             Reviews: result.checks + result.airwires + result.drcClean
```

Two important framing points:

1. **The PCB is generated from a saved `CircuitJson`, not authored on the board.** The typical entry is:
   user is on a project version → clicks the **PCB** tab → the FE POSTs that version's `circuitJson` to
   `/layouts` → shows a progress state → renders the returned board. There is no "blank PCB you draw on";
   the board is derived from connectivity.
2. **It is a long-running job (10–120 s).** Freerouting + KiCad DRC run in the `pcb-worker`. Show a
   determinate-ish progress UX (QUEUED → RUNNING → done); do not block the tab.

---

## 4. Backend contract — `/layouts` (exact)

No global route prefix (routes are root-relative). Both endpoints require `Authorization: Bearer
<accessToken>` (see `FRONTEND_BRIEF.md` §4.2 for the token strategy). The job's org is resolved in three
ordered ways: (1) from `versionId`'s project when you send one — authoritative, membership checked, and a
conflicting `orgId` alongside it is a **400**; (2) from an explicit `orgId`, membership checked; (3) failing
both, the user's **first membership**, which is their personal workspace — a guess.

Because (3) is a guess, **the resolved org is echoed back in the 202** and present on every layout response.
Send `versionId` or `orgId` whenever the board belongs to a team: a layout filed into the wrong org is
invisible to the org that wanted it, charged to the wrong quota, and downloadable by whoever shares that
personal workspace. A user with no org at all gets `404 'No organization found for user'`.

### 4.1 `POST /layouts` — start a layout job

- Guard: `JwtAuthGuard`. Throttle: **5 requests / 60 s** (heavy job).
- Body — `CreateLayoutDto`:

```ts
{
  circuit: CircuitJson,                    // REQUIRED. OUR CircuitJson (components + nets). @IsObject only —
                                           //   NOT deep-validated at the DTO; validate client-side first (§4.3).
  versionId?: string,                      // uuid. Tags the layout to a saved version: sets the job's
                                           //   org + project, and is what makes GET /layouts?versionId= work
                                           //   after a page reload.
  orgId?: string,                          // uuid. Ad-hoc layouts only (no versionId). Membership is
                                           //   verified; sending BOTH with different orgs is a 400.
  placer?: 'grid' | 'auto' | 'rust',       // 'grid' = deterministic (default), 'auto' = connectivity-aware,
                                           //   'rust' = out-of-process engine (~100x on dense boards).
  fabProfile?: FabProfileDto,              // CLOSED shape — see below. An unknown key is a 400.
  netCurrentsA?: Record<string, number>,   // RMS amps per EMITTED net name → IPC-2221 width (§12).
                                           //   EVERY value must be a positive finite number: "2A" or -1 is
                                           //   a 400 naming the offending net.
}

// fabProfile is no longer free-form:
{
  tier?: 'economy' | 'standard' | 'advanced',   // the fab's published limits to judge overrides against
  minTraceWidthMm?, minClearanceMm?, viaDrillMm?, viaAnnularMm?,   // positive numbers
  copperOz?, deltaTC?, placementGridMm?, placementMarginMm?,      // positive numbers
  gndPour?: boolean,
}
```

- Response — **HTTP 202**:

```ts
{ jobId: string /* uuid */, status: 'QUEUED' }
```

- On enqueue failure the row is flipped to `FAILED` (guarded) and the API returns **503** — treat as
  "couldn't start, retry".

### 4.2 `GET /layouts/:id` — poll status + result

- Guard: `JwtAuthGuard`; `:id` is `ParseUUIDPipe` (400 on non-UUID); org membership enforced (`404 'Layout
  job not found'` if missing / not yours).
- Response:

```ts
{
  id: string,
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED',
  result: LayoutResultBlob | null,   // null until SUCCEEDED (see §5). On FAILED it is EITHER
                                     //   { diagnostics: LayoutDiagnostic[] } OR null (with errorMessage set).
  errorMessage: string | null,       // set on thrown-exception failures (≤500 chars)
  glbUrl?: string,                   // presigned S3 GET url for the 3D GLB — see gotcha below
  gerbersUrl?: string,               // presigned S3 GET url for the manufacturing bundle (JSON)
  createdAt: string, startedAt: string | null, finishedAt: string | null,
}
```

- **Poll** until `status ∈ {SUCCEEDED, FAILED, CANCELED}`. No push channel (no WebSocket/SSE) — poll every
  few seconds (freerouting is 10–120 s; a 2–3 s interval is fine). Reuse the TanStack Query polling pattern
  from `FRONTEND_BRIEF.md` §5.8.
- **Presigned-URL gotchas (important):**
  - `glbUrl` / `gerbersUrl` point at **`S3_ENDPOINT`** (dev: `http://localhost:9000`, MinIO), **NOT the API
    host**. Fetch the GLB and manufacturing JSON directly from that host.
  - They **expire in 3600 s** and are **re-presigned on every GET** — if a link is stale, just re-poll
    `GET /layouts/:id` for fresh URLs.
  - They are **absent** (`undefined`) until the job produced the artifact — **and they stay absent on a
`SUCCEEDED` job whose board is not manufacturable.** `SUCCEEDED` means the analysis completed, not that the
board passed: when the final KiCad DRC is not clean the worker deliberately withholds the fab bundle and
skips the 3D render, so there is nothing manufacturable to download. Badge on `result.manufacturable`, never
on `status`.
  - Do **not** use `result.render.glbKey` / `result.manufacturing.gerbersKey` (raw S3 keys) directly —
    always download via the presigned `glbUrl` / `gerbersUrl`.

---

## 5. The `LayoutGeometry` render contract (the core of the 2D editor)

On `SUCCEEDED`, `result` is (assembled in `apps/pcb-worker/src/layout/processor.ts`):

```ts
type LayoutResultBlob = {
  // ---- the verdict. Badge on THIS, not on drcClean or on status ----------------------------------
  manufacturable: boolean,
  notManufacturableReason: string | null,   // null exactly when manufacturable is true
  drcClean: boolean,                        // true = 0 violations AND 0 unconnected

  // ---- what to draw ------------------------------------------------------------------------------
  layout: LayoutGeometry,
  checks: DrcCheck[],            // DRC VIOLATIONS only (unconnected → airwires, not here)
  airwires: Airwire[],           // ratsnest lines
  diagnostics: LayoutDiagnostic[],  // everything the pipeline had to SAY (see below)

  // ---- how the board was made --------------------------------------------------------------------
  fab: {
    tier: 'economy' | 'standard' | 'advanced',
    profile: { minTraceWidthMm, minClearanceMm, viaDrillMm, viaAnnularMm, gndPour, ... },
  },
  delivery: {
    routing:   { tier: 'quality' | 'local', drcCertified: boolean, marginMm?: number, degradedReason?: string },
    placement: { engine: 'grid'|'auto'|'rust', requested: 'grid'|'auto'|'rust', degradedReason?: string },
  },

  stats: { traces: number, vias: number, errors: number, durationMs: number },
  parity: { ok: boolean, checkedPins: number, expectedPins: number, diagnostics: LayoutDiagnostic[] },
  completeness: 'full' | 'partial',
  scope: ScopeManifest,          // which checks ran — and which did NOT

  // ---- artifacts. NULL on a board that was not certified -----------------------------------------
  bodies: { injected: number, unmatched: string[] } | null,
  render: { glbKey: string } | null,          // raw S3 key — use the presigned glbUrl instead
  manufacturing: { gerbersKey: string, gndPlane: boolean } | null,
}
```

### 5.1 `LayoutGeometry` (all coords in **mm**, one **board-centered** frame, rounded to 3 decimals)

```ts
type Pt = { x: number, y: number }

type LayoutGeometry = {
  board: { widthMm: number, heightMm: number, outline: Pt[] },   // rect boards synthesize a 4-pt outline
  layers: { name: string }[],                                    // [{name:'top'},{name:'bottom'}] or [{name:'top'}]
  components: LayoutComponent[],
  pads: LayoutPad[],
  traces: LayoutTrace[],
  vias: LayoutVia[],
}

type LayoutComponent = {
  id: string,             // OUR Component.id when cross-probeable, else emitted name (use designator as stable key)
  designator: string,     // R1, U3, ...
  x: number, y: number,   // center, mm
  rotation: number,       // degrees
  footprint: string | null,   // tscircuit footprinter string, e.g. 'soic8'
  bodyWmm: number, bodyHmm: number,   // BODY box (NOT the courtyard)
  heightMm: number | null,            // 3D body height (from cad_component z); null if unknown
  courtyard: Pt[],        // polygon — use THIS for collision/selection/drag hit-testing, not the body box
  layer: string,          // 'top' | 'bottom'
}

type LayoutPad = {
  id: string,
  componentId: string,    // → LayoutComponent.id
  pin: string | null,     // schematic pin cross-probe ref; may be null
  net: string | null,     // EMITTED net NAME; null = unconnected / single-pin
  x: number, y: number,
  layers: string[],       // ['top'] for SMD; ['top','bottom'] for a plated through-hole
  shape: string,          // e.g. 'rect'
  wMm: number, hMm: number,
  drillMm: number | null, // present = THT drill; null = SMD
}

type LayoutTrace = {
  id: string,
  net: string | null,     // USUALLY null on the quality (freerouting) board — see gotcha
  segments: { layer: string, widthMm: number, points: Pt[] }[],   // copper polylines, split per layer at vias
}

type LayoutVia = {
  id: string, x: number, y: number,
  drillMm: number, outerMm: number,
  fromLayer: string, toLayer: string,
  net: string | null,
}
```

**Rendering notes:**
- Draw order (bottom→top): board outline → bottom copper (traces/pads on `bottom`) → top copper → vias →
  component courtyards/bodies → silkscreen labels (designators) → airwires (ratsnest overlay).
- Filter traces/pads by `layer` for the **Layers** toggle. A trace with a via has its polyline broken into
  per-layer `segments`; render each segment on its own layer.
- Use `courtyard` (polygon) for hit-testing/selection, not `bodyWmm/bodyHmm`.
- `LayoutTrace.net` and `LayoutVia.net` are **frequently `null`** on the shipped quality board (freerouting's
  SES splice drops per-connection names). Traces still render; just don't rely on per-trace net coloring for
  the quality router. (Pads keep their `net`, so you can still net-highlight by pad.)
- Rect boards have no real outline — `board.outline` is synthesized as 4 corners from center ± size/2.

---

## 6. The Reviews panel — DRC checks + airwires

Flux shows "Airwires • 62 / Overlapping Copper • 9 / Dangling Traces". Circuit Forge gives you:

```ts
type DrcCheck = {           // result.checks[] — VIOLATIONS only
  category: string,         // coarse group for the Reviews list: 'clearance' | 'via_drill' | 'copper' |
                            //   'placement' | 'silk' | 'footprint' | 'dangling' | 'unconnected' | 'other'
  type: string,             // KiCad's exact DRC type
  severity: string,
  message: string,
  location: { x: number, y: number } | null,   // ⚠ KiCad PAGE frame — NOT the geometry frame (see gotcha)
  refs: string[],           // component designators involved → cross-probe/highlight these
}

type Airwire = { net: string, from: Pt, to: Pt }   // result.airwires[]
```

- **Group `checks` by `category`** for the Reviews list (each row = category + count, like Flux). Clicking a
  finding should highlight its `refs` (designators) in the canvas.
- **`result.drcClean`** is the headline: `true` = 0 violations AND 0 unconnected → "manufacturable" badge.
- **Airwires are the ratsnest.** They are derived from the KiCad DRC's `unconnected_items`, drawn between
  **OUR** shaped pad coordinates (matched by designator + net) — render `result.airwires` directly as the
  ratsnest overlay. Do **not** try to infer unrouted nets from traces. On a fully-routed clean board
  `airwires` is empty.
- **`DrcCheck.location` is in a DIFFERENT coordinate frame** (KiCad page space, offset from the geometry's
  board-centered frame). Use it only as a coarse "jump near here" hint — do **not** overlay it directly on
  the geometry. For precise highlighting, use `refs` → find the component/pad in `layout`.
- Also surface `parity.ok === false` (electrically wrong board — should never ship) and
  `completeness === 'partial'` (some load-bearing components were excluded) as prominent warnings.

---

## 7. Shared types — import, don't copy

- Connectivity + sim: `@circuit-forge/eda-core` — `CircuitJson`, `Component`, `Net`, `PinConnection`,
  `ModelDef`, `UiJson`, `AnalysisConfig`, `SimulationResult`, `ErcResult`, plus `safeValidateCircuitJson`,
  `COMPONENT_TYPES`, `COMPONENT_PINS`.
- PCB geometry: `@circuit-forge/pcb-core` re-exports (from `packages/pcb-core/src/index.ts`):
  `LayoutGeometry`, `LayoutComponent`, `LayoutPad`, `LayoutTrace`, `LayoutVia`, `Pt`, `DrcCheck`, `Airwire`,
  `ParsedDrc`, `LayoutStats`, `ParityResult`, `LayoutDiagnostic`.

If the frontend can consume the workspace packages directly, do so (guaranteed FE=BE). Otherwise generate
TS types from these files as part of the build. **Note:** `pcb-core` pulls the tscircuit runtime (React 19)
transitively — the frontend should import only its **types**, never run `layoutCircuit` client-side (that is
worker-only). If type-only import proves awkward, hand-mirror the §5 shapes (they are stable).

---

## 8. Interaction model — and an honest boundary on manual editing

The founder's question was: *"if I drag a component / pull a trace, does the PCB (and 3D) update instantly
and correctly?"* Here is the precise, honest answer for what the backend supports **today**:

- **Instant visual feedback: yes, client-side.** Dragging a `LayoutComponent`, toggling layers, panning/
  zooming — all pure frontend transforms on the rendered `LayoutGeometry`. Update the render immediately;
  recompute the local ratsnest (straight lines from the moved component's pads to their net partners) for
  live feedback.
- **Correctness (routing + DRC) is NOT instant and is NOT client-side.** Re-routing copper and re-running
  DRC is the backend engine's job (freerouting + KiCad). Like Altium/KiCad, a drag invalidates the routing
  in that area; the authoritative clean board comes from **re-running the layout**.
- **⚠ The current backend does NOT accept a manual placement.** `CreateLayoutDto` today is only
  `{ circuit, placer, fabProfile, netCurrentsA }` — there is **no `placements` input, no `lockedTraces`, no
  per-component override**. So a user's dragged positions cannot yet be sent back to be re-routed/re-DRC'd.

**What this means for v1 vs v2:**
- **v1 (buildable now):** the PCB tab is a **generate + inspect** experience — request a layout, render the
  auto-placed/auto-routed board in 2D + 3D, review DRC + airwires, cross-probe to the schematic, download
  manufacturing outputs. Dragging can be allowed as a *local view manipulation* (and to preview a manual
  placement) but cannot be persisted/re-verified server-side yet.
- **v2 (needs backend work — deferred "M5" in `LAYOUTJOB_PLAN.md`):** a `placements` input on `/layouts`
  (send user positions → re-route around them), `lockedTraces`, component overrides, and a unified Library.
  Design the UI so manual-drag-then-"Re-run layout with my placement" is a natural future addition, but
  gate the "persist/verify manual edit" affordance behind that backend capability — do not ship a drag that
  silently fails to re-verify.

---

## 9. Objects / Rules / Library panels

- **Objects** — a tree of `result.layout.components[]` (by `designator`) and the source `CircuitJson.nets[]`.
  Selecting an object cross-probes to the canvas (highlight the component's courtyard + its pads; highlight a
  net's pads/traces). This is the same cross-probe used by the schematic tab.
- **Rules** — the fab constraints you send on POST (§12): the `fabProfile` (clearance / trace width / via
  tier) and `netCurrentsA` (per-net current → trace width). Present sensible defaults; changing a rule means
  **re-running `/layouts`** (rules are inputs to the engine, not live edits).
- **Library** — the parts catalog via `GET /parts/*` (documented in `FRONTEND_BRIEF.md`'s route map). Used to
  pick real MPNs for components (which flow into `CircuitJson.components[].mpn/footprint/sourcing` on the
  schematic side, then into BOM/PnP on layout).

---

## 10. The 3D view (GLB) + the `apps/pcb-viewer` scaffold

- 3D mode renders the **`glbUrl`** artifact: a binary glTF (`model/gltf-binary`) of the routed board with
  real component 3D bodies (KiCad STEP models), soldermask, silkscreen, pours. Load it with three.js
  (`GLTFLoader`). It is a fully-baked scene — no per-element data, just geometry + materials.
- **There is already a scaffold at `apps/pcb-viewer/`** (Next.js + three.js, an HDRI environment, physical
  materials, shadows, an inspector panel) built to render these GLBs photorealistically. **Start from it** —
  it solves lighting/materials/camera and was validated against real exported boards. Note it is
  intentionally **outside the pnpm workspace** (React 18 vs the repo's React 19) — install standalone
  (`cd apps/pcb-viewer && pnpm install --ignore-workspace`).
- 2D↔3D toggle shares the same job result: 2D from `result.layout`, 3D from `glbUrl`. Keep selection state
  in sync where feasible (the GLB is opaque, so 3D selection is best-effort / camera-focus only).

---

## 11. Manufacturing outputs

Behind **`gerbersUrl`** is a single JSON bundle (`application/json`, at S3 key
`layouts/{jobId}/manufacturing.json`):

```ts
{
  gerbers: { layers: Record<string, string>, drill: string },   // layerName → gerber text (F_Cu, B_Cu, Edge_Cuts, ...) + drill file
  bomCsv: string,   // bill of materials, CSV
  pnpCsv: string,   // pick-and-place, CSV
}
```

- Offer a **Download** menu: "Gerbers (zip)" — zip the `gerbers.layers` entries + `drill` client-side; "BOM
  (CSV)" — `bomCsv`; "Pick & Place (CSV)" — `pnpCsv`.
- This bundle is **not inline** in the poll response (only the S3 key + presigned URL) — fetch it lazily when
  the user opens the Manufacturing/Export panel, not on every poll.
- Note there is **also** a live schematic-level BOM at `GET /versions/:versionId/bom?format=json|csv`
  (richer: sourcing/cost/stock) — that's the schematic BOM; the layout `bomCsv` is the manufacturing view.

---

## 12. Layout options (the "Rules" you can send)

All optional on `POST /layouts`:

- **`placer`**: `'grid'` (deterministic, default) or `'auto'` (connectivity-aware force-directed placement;
  it must beat grid on wirelength AND re-pass parity, else it keeps grid — quality never regresses).
- **`fabProfile`**: overrides for the fab tier — min clearance, min trace width, via drill/annular tiers
  (the engine ships economy / 5-mil / 3.5-mil-HDI profiles, all DRC-clean). Expose as a "Design Rules /
  Fab capability" dropdown.
- **`netCurrentsA`**: `Record<emittedNetName, amps>` — RMS current per net → IPC-2221 per-net trace width
  (a 2 A GND routes wider than a signal net, deterministically). Typically fed from simulation results
  (e.g. measured rail currents). Optional; nets without an entry use the profile minimum width.

Changing any of these = a **new `/layouts` job** (they are engine inputs). Keep the last result visible while
the new one runs.

---

## 13. What EXISTS vs what is MISSING (do not design around the gaps)

**Exists and is solid (v1):**
- `POST /layouts` (202 + jobId) and `GET /layouts/:id` (status + result + presigned GLB/gerbers).
- Full `LayoutGeometry` (board/layers/components/pads/traces/vias) for 2D render.
- DRC `checks` + `airwires` + `drcClean` for the Reviews panel.
- 3D GLB + manufacturing bundle (gerbers/BOM/PnP).
- `placer` / `fabProfile` / `netCurrentsA` inputs.

**Missing — do NOT build UI that assumes these:**
1. **No manual placement / locked traces / component overrides** on `/layouts` (only `placer`). Manual
   drag-and-re-verify is a v2 backend addition (§8).
2. **No pours/zones in `LayoutGeometry`.** The GND pour is injected into the `.kicad_pcb` and only appears in
   the exported GLB — it is **not** in the 2D geometry contract (no `LayoutPour` type). So 2D won't show
   copper fills; 3D (GLB) will. Don't promise a 2D pour editor.
3. ~~No list endpoint~~ — **`GET /layouts` SHIPS.** It lists the caller's layout jobs across their orgs,
   newest first, filterable by `?versionId=` or `?projectId=`, in the standard pagination envelope. This is
   the intended re-hydration path after a page reload: hold the durable `versionId`, not the browser-memory
   `jobId`. Each row carries `manufacturable` (`true`/`false`/`null` while undecided) and `orgId`, so a grid
   can badge outcomes without one detail request per row. What the FE no longer needs to track its own
   (store the latest layout jobId on the project version in your own client state / a future column).
4. **No cancel / retry** endpoint (`abortRequested` exists on the model but isn't exposed). A running job
   runs to completion.
5. **No push channel** — polling only.
6. **AI generation (`/design-circuit`, `/design-jobs`, `/verify-design`)** is documented in
   `FRONTEND_BRIEF.md` §7. (A note here once said the AI provider was out of balance — that was a
   point-in-time operational state, not a property of the API, and it no longer holds. Build against the
   endpoints normally.)

---

## 14. Definition of done (PCB editor)

- [ ] PCB tab: from a saved version, `POST /layouts` → progress UX → render on SUCCEEDED; handle
      FAILED (show `errorMessage` / `result.diagnostics`) and CANCELED.
- [ ] 2D canvas renders board outline, components (courtyards + designators), pads (SMD/THT distinct),
      traces (per-layer), vias — from `result.layout`, with a working **Layers** toggle.
- [ ] 3D mode loads `glbUrl` in a three.js viewer (start from `apps/pcb-viewer`).
- [ ] Reviews panel groups `result.checks` by category + shows `airwires` (ratsnest) + a `drcClean`
      "manufacturable" badge; clicking a finding highlights its `refs`.
- [ ] Cross-probe: selecting a component/net in Objects (or the schematic tab) highlights it on the PCB, and
      vice-versa, using `designator` + emitted net name.
- [ ] Rules panel sends `placer` / `fabProfile` / `netCurrentsA`; changing them re-runs the job.
- [ ] Manufacturing menu downloads Gerbers (zip) / BOM (CSV) / PnP (CSV) from `gerbersUrl` (lazy).
- [ ] Presigned-URL handling: fetch GLB/gerbers from the S3 host; refresh by re-polling on expiry.
- [ ] Client-side validation of `CircuitJson` (eda-core `safeValidateCircuitJson`) before POST.
- [ ] No UI implies the "missing" capabilities in §13 (manual persisted edits, 2D pours, cancel, list).
</content>
