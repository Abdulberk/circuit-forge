# Circuit Forge — Frontend Build Brief

**Date:** 2026-05-30 · **Audience:** an AI coding agent (e.g. Claude Code) building a greenfield frontend · **Status:** ready-to-implement specification

This document is an implementable technical specification for building a **new, from-scratch (greenfield) frontend** for **Circuit Forge** — an enterprise-grade EDA (Electronic Design Automation) platform. The backend already exists, is verified, and is the system of record; this frontend is purely a client of its REST API. Read every section in order: the contracts here are derived directly from the real backend source and are binding.

---

## Context

**Circuit Forge** is a multi-tenant, enterprise EDA web application. Users design electronic circuits in a schematic editor, run **server-side SPICE simulations** (via `ngspice`, executed in an isolated worker — there is no client-side solver), inspect the resulting waveforms, generate and edit circuits from natural language via **AI endpoints that already exist on the backend**, reuse and author circuit **templates**, and collaborate through **organizations with role-based access control (RBAC)**.

The backend lives at `e:\circuit-forge` and is a **pnpm + Turborepo monorepo** consisting of:

| Piece | What it is |
|---|---|
| `apps/api` | NestJS REST API at `http://localhost:3001` (Swagger UI at `/docs`, OpenAPI JSON at `/docs-json`, **no global route prefix**). Auth/RBAC, CRUD, AI endpoints, and simulation enqueue/read. |
| `apps/worker-sim` | BullMQ worker that consumes simulation jobs from Redis and shells out to `ngspice` in a sandboxed per-job directory; writes results to Postgres or spills large results to S3/MinIO. |
| `packages/eda-core` | Pure-TypeScript library — the canonical `CircuitJson` / `AnalysisConfig` / `SimulationResult` types, **Zod validators**, netlist generation, SPICE sanitization, ERC, and result parsing. **The frontend reuses this package directly.** |
| `packages/llm-core` | LLM integration used by the API's AI endpoints. Server-side only; the frontend never touches it. |

The supporting ground-truth docs (verified against source) are: `README.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/DATA_MODEL.md`, `docs/EDA_CORE.md`, `docs/SIMULATION.md`, and `docs/SECURITY.md`.

**This brief targets an AI coding agent building the greenfield frontend.** It is the complete handoff prompt for that build.

---

## Binding decisions

These decisions are settled. Build to them; do not relitigate them.

| Decision | Choice |
|---|---|
| **Code strategy** | **Greenfield rebuild.** Do **not** port the old `circuit-simulator` code. Learn only from its mistakes (notably: it leaked an LLM provider key into the client bundle via a `NEXT_PUBLIC_` variable — see Security). |
| **Project location** | The frontend is a **separate project / repository** that **the user sets up themselves**. Do **not** scaffold it inside this backend monorepo, and do not assume access to its workspace packages at runtime — see "How to use this brief" for the eda-core reuse strategy. |
| **Simulation** | **Server-batch only.** There is **no client-side solver**. The frontend builds a circuit → submits a job → polls for status → fetches and plots the server-computed result. |
| **AI generation** | **Built and verified on the backend.** Four secure endpoints (`POST /generate-circuit`, `POST /edit-circuit`, `POST /explain-circuit`, `POST /design-circuit`) return eda-core-validated output. The frontend **consumes** these from day one — it does **not** build, stub, or label them "coming soon". |
| **Shared schema** | **One canonical data model: eda-core `CircuitJson`** (plus `AnalysisConfig`, `SimulationResult`, `UiJson`). The frontend validates with eda-core's Zod validators before every POST and after every read. Never cast `as CircuitJson`. |
| **Secrets** | **No provider/LLM keys, JWT secrets, S3 credentials, or DB URLs** ever appear in client code or the bundle. The only permitted client-side env value is the **API base URL**. All AI, secret, and signed operations go through the backend. |

---

## How to use this brief

1. **Read in order.** Sections are numbered 01–08 and build on one another. The **Backend Integration Contract** and **Shared Data Model** sections are *binding contracts* — match the real API and eda-core types exactly; never guess field names or shapes.
2. **Treat the AI endpoints as already deployed.** The AI section documents how to *consume* the built endpoints and the surrounding UX. There is no backend work to do for AI; if the backend is unreachable, degrade with a Retry affordance, never a placeholder.
3. **Reuse eda-core as the single schema source.** Pull the validators, types, netlist generator, parser, and ERC from `@circuit-forge/eda-core` (published on **public npm** — `pnpm add @circuit-forge/eda-core`). These are pure, secret-free functions and are safe to run client-side.
4. **Honor every "definition of done" / acceptance checklist.** Each section that warrants it ends with one. The cardinal rule that recurs everywhere: never leak secrets, always validate against the shared schema, build resilient loading/empty/error states, and meet the accessibility and performance bars.
5. **When in doubt, open the cited file.** Every contract references a real path (e.g. `packages/eda-core/src/types/circuit.ts`) or path:line. The Swagger UI at `http://localhost:3001/docs` and the OpenAPI JSON at `/docs-json` are live, authoritative references for request/response shapes.

---

## Table of contents

1. [Product Overview & Personas](#1-product-overview--personas) *(this section)*
2. [Screen Inventory](#2-screen-inventory)
3. [Key User Flows](#3-key-user-flows)
4. [Backend Integration Contract](#4-backend-integration-contract)
5. [Simulation Job Lifecycle](#5-simulation-job-lifecycle)
6. [Shared Data Model & Types](#6-shared-data-model--types)
7. [AI Circuit Generation](#7-ai-circuit-generation)
8. [Frontend Architecture & Stack](#8-frontend-architecture--stack) *(security, NFRs, accessibility, resilience, testing, roadmap & Definition of Done folded in)*

> Section numbering above mirrors the assembled document. Anchors are GitHub-flavored-markdown slugs of the corresponding headings; the brief is assembled in this order.

---

## 1. Product Overview & Personas

**Circuit Forge** is an enterprise, multi-tenant EDA web app. The frontend is a greenfield **Next.js (App Router)** application — used almost entirely client-side — that talks **only** to the existing NestJS API (`http://localhost:3001`, Swagger `/docs`, OpenAPI JSON `/docs-json`). Its job is to make the backend's capabilities usable and pleasant:

- **Design** circuits in a schematic editor built around the canonical `CircuitJson` graph.
- **Validate** continuously with eda-core's client-side ERC (`runErc`) — no round-trip, no secrets.
- **Simulate** on the server (TRAN / AC / DC / OP) via submit → poll → fetch, then **plot** multi-trace waveforms.
- **Generate / edit / explain / verify** circuits via the backend AI endpoints (the headline `POST /design-circuit` returns a circuit *already verified by a simulation*, with the waveform attached).
- **Organize** work into orgs, projects, and immutable versions, governed by per-org RBAC.
- **Reuse** public and org-scoped templates; **import/export** SPICE netlists and native JSON.

### The canonical data model the frontend revolves around

Do not invent fields — these come from `packages/eda-core` (and `apps/api/prisma/schema.prisma` for persistence). Full detail is in the Shared Data Model section; the essentials:

```ts
// packages/eda-core/src/types/circuit.ts
interface CircuitJson {
  version: string;            // e.g. "1.0"
  components: Component[];
  nets: Net[];
  models?: ModelDef[];        // SPICE .model/.subckt bodies for active devices (transistors, op-amps, …).
                              //   ⚠️ PERSIST THIS FIELD — dropping it on save breaks active-device sims. See §6.1.
  metadata?: CircuitMetadata; // { name?, description?, author?, createdAt?, updatedAt? }
}

interface Component {
  id: string;
  type: ComponentType;                        // the full COMPONENT_TYPES set (28 incl. transistors + digital), NOT just 7 — see §6.2
  designator: string;                         // R1, C1, V1, GND1 — regex /^[A-Z][A-Z0-9]*[0-9]+$/i (MUST end in a digit)
  value?: string;                             // SPICE value strings: "10k", "100n", "DC 5", "SIN(0 1 1k)"
  model?: string;                             // model NAME for model-based devices (diode→omit for DDEFAULT, or an LED color model "LEDRED"/"LEDYEL"/"LEDGRN"/"LEDBLU"; transistors → e.g. "QGENNPN"); the body goes in CircuitJson.models
  pins: { pinId: string; netId: string }[];   // connectivity is via pins → nets
  properties?: Record<string, unknown>;       // also carries digital timing for gates/dff (riseDelay, …) — see §6.2
  // Optional real-part metadata (eda-core ≥1.1.0), set when created from the parts catalog
  // (GET /parts/:symbol/component). Additive & backward-compatible; ignored by the netlist generator.
  mpn?: string; manufacturer?: string; footprint?: string;
  sourcing?: { supplier: string; supplierId: string; unitCost?: number; currency?: string; stock?: number; datasheetUrl?: string };
}

interface Net { id: string; name: string; isGround?: boolean; }
```

Key facts to internalize:

- **Connectivity is through `pins[].netId` referencing `Net.id`.** There is **no flat node list** — components connect to nets, nets connect components.
- **`ComponentType` is the full `COMPONENT_TYPES` tuple (28 values), not a fixed 7.** It includes passives (R/L/C), sources (V/I + controlled vcvs/vccs + behavioral bsource), diode/zener, **active devices** (bjt/mosfet/jfet), transformer/tline/switch, `subckt` (op-amp/IC macromodels), the **digital** family (`logic_and/or/nand/nor/xor/xnor/not/buffer`, `dff`), `ground`, and `'generic'` (catalog-only, not emitted to SPICE). **Always derive the palette, pin names, and "can this simulate?" from the package — never a hardcoded list:** iterate `COMPONENT_TYPES`, read pins from `COMPONENT_PINS[type]` (R/C/L `['1','2']`, sources `['+','-']`, diode `['anode','cathode']`, ground `['1']`, gates `[]` = variable `in1..inN`+`out`, dff `['d','clk','set','rst','q','qb']`, `'generic'` `[]` = from the catalog part), and call `isSimulatable(component)`. The **v1 editor palette MAY still choose to expose only a curated subset** (that's a frontend scope decision, see §2.4), but the type/pin/validation logic must come from `COMPONENT_TYPES`/`COMPONENT_PINS` so it never drifts from the engine.
- **`UiJson`** (visual layout, kept separate from the electrical model) is `{ viewport?: { x, y, zoom }, positions?: Record<id, { x, y, rotation? }>, wires?: { netId, points: { x, y, rotation? }[] }[] }`. All three top-level fields are optional in the type; `rotation` is a **string enum** — one of `'0' | '90' | '180' | '270'` (the TS `Position` type and the Zod `PositionSchema` both use these string literals; pass `'90'`, not `90`).
- **A saved snapshot is a `ProjectVersion`** persisting `circuitJson` + `uiJson`. Versions are **immutable** and numbered per project (every save creates a new version; there is no version PATCH).

### Personas

The frontend serves four primary personas. Each section's UX decisions should trace back to one or more of them.

| Persona | Goals | Optimize for |
|---|---|---|
| **Hardware / analog engineer** *(primary)* | Design real circuits; run TRAN/AC/DC sweeps; pick precise probes; read cursors and measurements; upload SPICE `.model` files; import/export SPICE; navigate version history. | Keyboard speed, dense data, precision, deterministic SPICE round-trips, trustworthy waveforms. |
| **Student** | Learn from public templates; experiment with simple RC/diode circuits; lean on AI-generate and ERC feedback to understand mistakes. | Low friction, in-context explanations (use `POST /explain-circuit`), forgiving and instructive errors. |
| **Educator** | Author and curate org-scoped templates; share projects within an org; demonstrate analyses live in front of a class. | Template authoring, org management, clear shareable/exportable artifacts, predictable demos. |
| **Reviewer / lead** | Open a colleague's project, inspect the schematic and a simulation result, compare versions, and sign off — often read-mostly. | Fast read paths, version history clarity, role-aware affordances (RBAC-gated actions hidden/disabled for `MEMBER`). |

These personas span the full skill range, so the UI must be **forgiving for novices yet fast for experts**: progressive disclosure, sensible defaults (e.g. prefilled analysis configs and auto-layout for AI/imported circuits), and keyboard-first power paths. RBAC affordances are role-aware throughout — destructive and authoring actions are gated by the caller's org role (`OWNER` / `ADMIN` / `MEMBER`).


## 2. Screen Inventory

This section enumerates every screen the v1 frontend must ship, with its purpose, key UI elements, the **exact** backend endpoints it calls, and the quirks you must handle. The route map is authoritative against `apps/api/src/*/*.controller.ts` and `docs/API.md`.

**Ground rules that apply to every screen:**

- API base URL is `http://localhost:3001`. There is **no global route prefix** — paths are exactly as written below. Swagger UI is at `/docs`, OpenAPI JSON at `/docs-json`.
- All endpoints except `POST /auth/*`, `GET /health`, and the public-template reads require `Authorization: Bearer <accessToken>`.
- Access token TTL ~15m (held in memory on the client); refresh token TTL ~7d. `POST /auth/refresh` ROTATES — it returns a fresh pair and the old refresh token is single-use (reuse → whole session revoked, so refresh must be single-flighted). Logout revokes the session server-side. See the Backend Integration Contract (§4, Auth & Token Strategy) for the concrete refresh loop.
- All business data is **org-scoped**. The active `orgId` is global app state driven by the org switcher, not a URL segment.
- The frontend never holds any provider/LLM key, JWT secret, S3 credential, or DB URL. The only permitted client env var is the API base URL. See the Frontend Architecture & Stack section (§8), which holds Security/NFR — this is a cardinal rule.
- `CircuitJson`, `AnalysisConfig`, and `SimulationResult` are owned by `@circuit-forge/eda-core`. Reuse its Zod validators (`safeValidateCircuitJson`, `safeValidateAnalysisConfig`) before every POST and after every read. Never cast `as CircuitJson`.

> **Suggested route structure (framework-agnostic):** `/login`, `/register`, `/dashboard`, `/projects/:projectId`, `/projects/:projectId/versions/:versionId`, `/editor/:versionId`, `/templates`, `/assets`, `/settings`. Keep the active `orgId` in a global store (the org switcher), not in the path.

### Backend route map (authoritative)

| Method | Path | Auth | Screen(s) | Notes |
|---|---|---|---|---|
| POST | `/auth/register` | none | Auth | Auto-creates a personal org `"<name>'s Workspace"` (role `OWNER`). Email is normalized (trim+lowercase); a verification email is sent (link → `/verify-email?token=…`). Returns tokens immediately — the user is signed in but `emailVerified:false`. |
| POST | `/auth/login` | none | Auth | Returns 200. Email normalized. May 429 `ACCOUNT_LOCKED` (5 fails → 15m), or 403 `EMAIL_NOT_VERIFIED` (only if the server sets `REQUIRE_EMAIL_VERIFICATION=true`; off by default). |
| POST | `/auth/refresh` | none | (token loop) | Body `{ refreshToken }` → fresh pair; **rotating/single-use**, single-flight required |
| POST | `/auth/verify-email` | none | Verify page | Body `{ token }` → `204`. Invalid/expired → `400`. Single-use. |
| POST | `/auth/resend-verification` | none | Verify page | Body `{ email }` → always `204` (never reveals whether the account exists/is verified). Throttled 5/h. |
| POST | `/auth/forgot-password` | none | Forgot-pw page | Body `{ email }` → always `204` (enumeration-safe). Sends a reset link (`/reset-password?token=…`, 1h TTL) if the account exists. Throttled 5/h. |
| POST | `/auth/reset-password` | none | Reset page | Body `{ token, newPassword }` → `204`; invalid/expired → `400`. Single-use; also clears any brute-force lock. User then logs in with the new password. |
| POST | `/auth/logout` | none | Settings | Body `{ refreshToken?, allDevices? }` → 204; revokes the session family server-side |
| GET | `/orgs` | JWT | Dashboard, Settings | Org switcher source |
| POST | `/orgs` | JWT | Settings | Creator becomes `OWNER` |
| GET | `/orgs/:orgId` | JWT | Settings | Org + caller `role` |
| GET | `/orgs/:orgId/projects` | JWT | Dashboard | List projects in org |
| POST | `/orgs/:orgId/projects` | JWT | Dashboard | Create project |
| GET | `/projects/:projectId` | JWT | Project | Project + nested `org` |
| PATCH | `/projects/:projectId` | JWT | Project | Update name/description |
| DELETE | `/projects/:projectId` | JWT | Project | Returns `{ success: true }`; RBAC-gated |
| GET | `/projects/:projectId/versions` | JWT | Project | Version summaries (no circuit JSON) |
| POST | `/projects/:projectId/versions` | JWT | Editor | Body `{ circuitJson, uiJson }` → new immutable version |
| GET | `/versions/:versionId` | JWT | Editor | Full version + nested `project` |
| POST | `/versions/:versionId/simulations` | JWT | Sim Panel | Body `{ analysisConfig, probes? }` → `{ jobId }` |
| POST | `/simulations/quick` | JWT | Sim Panel | Body `{ netlist, analysisConfig? }`; throttled 10/60s |
| GET | `/versions/:versionId/bom` | JWT | BOM panel | Aggregated bill of materials: parts grouped by mpn (qty, designators, unit/line cost, stock, datasheet) + per-currency totals + `unsourced` flags. `?format=csv` downloads a purchase-ready CSV. Same access rules as reading the version. |
| GET | `/orgs/:orgId/usage` | JWT | Usage page / org settings | Current-month usage snapshot: `{ period, sim: { jobs, runtimeMs, concurrent, limits }, storage: { assetBytes, resultBytes, totalBytes, limits }, parts: { calls, limits } }`. Every `limits` value is a number or **null = unlimited** (limits come from server env `QUOTA_*`; unset in dev). Render "X used" when null, "X of Y" + a progress bar when set. ⚠️ `sim`/`storage` are org-wide, but `parts.calls` is the **requesting user's** count (parts quota is per-user) — label it "Your catalog calls", not org-wide. |
| POST | `/netlist/import` | JWT | Import dialog | Body `{ netlist }` (standard SPICE deck, max 200KB) → `{ circuit, analysis?, title?, schemaValid, schemaIssues, errors, warnings }`. Load `circuit` into the editor when `schemaValid`; show warnings otherwise. Throttled 30/60s. |
| POST | `/netlist/export` | JWT | Export action | Body `{ circuitJson, analysisConfig?, probes? }` → `text/plain` self-contained `.cir` deck (generic model bodies inlined; attachment headers set). Authoring errors → 400 with the exact message. Throttled 30/60s. |
| GET | `/simulations/:jobId` | JWT | Sim Panel | Status poll |
| GET | `/simulations/:jobId/result` | JWT | Waveform | Result payload |
| GET | `/templates` | optional JWT | Templates | Public when no `orgId`; org list requires membership |
| GET | `/templates/:templateId` | optional JWT | Templates | `ParseUUIDPipe` on id |
| POST | `/templates` | JWT | Templates | Body `{ orgId?, name, tags?, circuitJson }` |
| DELETE | `/templates/:templateId` | JWT | Templates | RBAC-gated; public templates cannot be deleted |
| POST | `/orgs/:orgId/assets/models/presign` | JWT | Assets | → `{ uploadUrl, s3Key, ... }` |
| POST | `/orgs/:orgId/assets/models/commit` | JWT | Assets | Persists the `Asset` row |
| GET | `/orgs/:orgId/assets/models` | JWT | Assets | List; optional `?type=` filter |
| GET | `/assets/:assetId` | JWT | Assets | Asset detail |
| GET | `/assets/:assetId/download` | JWT | Assets | → presigned `{ downloadUrl }` |
| DELETE | `/assets/:assetId` | JWT | Assets | RBAC-gated |
| POST | `/generate-circuit` | JWT | AI dialog | Throttled 5/60s |
| POST | `/edit-circuit` | JWT | AI dialog | Throttled 5/60s |
| POST | `/explain-circuit` | JWT | AI dialog, Editor | Throttled 10/60s |
| POST | `/design-circuit` | JWT | AI Design dialog | Agentic; throttled 3/60s; ~10–60s |
| POST | `/verify-design` | JWT | "Verify" button / review panel | Body `{ circuit, analysisConfig?, assertions? }` → a **DesignEvidence** pack (ERC + ngspice + measured-vs-requested specs → `verdict` pass/fail/inconclusive). Deterministic, no AI. 10/60s. See §4 / §7. |
| GET | `/parts/search` | JWT | Editor (part picker) | `?q=` (+ `manufacturerId?`/`categoryId?`) → real-part search; 30/60s |
| GET | `/parts/manufacturers` | JWT | Editor (part picker) | Manufacturer facet `[{ id, name, productsCount }]`; 60/60s |
| GET | `/parts/categories` | JWT | Editor (part picker) | Category tree facet (nested + counts); 60/60s |
| GET | `/parts/:symbol` | JWT | Editor (part picker) | Part detail: parameters, price tiers, stock, datasheet; 30/60s |
| GET | `/parts/:symbol/component` | JWT | Editor (part picker) | Part → CircuitJson component `{ simulatable, component?, reason?, catalog }`; 30/60s |

> All AI endpoints (`/generate-circuit`, `/edit-circuit`, `/explain-circuit`, `/design-circuit`) are **built, deployed, and verified** in `apps/api/src/generation/` (Swagger tag `ai`). The frontend **consumes** them. Never ship an "AI coming soon" placeholder. Contracts are detailed in the Backend Integration Contract (§4) and AI Circuit Generation (§7); summarized inline below.

> The **`/parts/*`** endpoints (Swagger tag `parts`, `apps/api/src/parts/`) are a **built, verified** real-component catalog backed by the TME distributor API (~1.3M parts, 1045 manufacturers) — they power a Flux-style **part picker** in the editor. Supplier credentials are **server-side only** (`TME_*`); the client never calls the distributor. Full contract in §4.4.11; the catalog→`CircuitJson` mapping and the new optional `Component` fields are in §6. Passives, diodes/zeners, and active devices (bjt/mosfet/jfet) insert as simulatable components (active devices also return a `modelDef` to merge into `circuit.models`); only true ICs/MCUs/connectors come back catalog-only (`simulatable:false`, `type:'generic'`, see §6.2). Trust the endpoint's `simulatable` flag.

---

### 2.1 Auth — Login / Register

**Purpose:** Authenticate the user. Register additionally auto-creates a personal organization named `"<name>'s Workspace"` with the new user as `OWNER` (`apps/api/src/auth/auth.service.ts:54`), so a brand-new account always lands with at least one org.

**Key elements:**
- Login form (email, password). Register form adds `name`.
- Client-side validation mirroring the DTOs (`apps/api/src/auth/dto/index.ts`): email must be a valid email; password 8–100 chars; name 1–100 chars.
- Inline error rendering from the standard NestJS error envelope `{ statusCode, message | message[], error }` (`message` is a string for single errors, an array for validation failures).
- A "remember me" toggle that only changes the token-storage strategy (see §4) — it does not change any request.
- Demo credentials hint for evaluators: `demo@circuitforge.io` / `demo123456`.

**Endpoints used:**

| Endpoint | Request | Response |
|---|---|---|
| `POST /auth/register` | `{ email, password, name }` | `201 { accessToken, refreshToken, user: { id, email, name } }` |
| `POST /auth/login` | `{ email, password }` | `200 { accessToken, refreshToken, user: { id, email, name } }` |
| `POST /auth/refresh` | `{ refreshToken }` | `200 { accessToken, refreshToken, user }` — rotating/single-use; persist the new refreshToken, single-flight only |
| `POST /auth/logout` | `{ refreshToken?, allDevices? }` | `204` — revokes the session family server-side; also discard tokens client-side |

The response type is `TokensResponse` (`apps/api/src/auth/auth.service.ts:15`): both `login` and `register` return the token pair **and** a `user` object — use `user` to seed the current-user display without an extra call.

**Caveats:**
- `409` on duplicate email (register); `401` with a generic `"Invalid credentials"` on bad login (no user-enumeration leak).
- After successful auth, immediately call `GET /orgs` to seed the org switcher and pick a default active org.
- Logout performs no server revocation — the refresh token remains technically valid until expiry. Discard both tokens client-side.

---

### 2.2 Dashboard / Projects List (org-scoped)

**Purpose:** Landing screen after auth. Lists projects for the **active org**, supports creating projects, and provides entry points into recent work, templates, and AI generation.

**Key elements:**
- Org switcher in the header (sourced from `GET /orgs`).
- Project cards/table for the active org, typically sorted by `updatedAt` desc (client-side).
- "New Project" dialog: `name` (1–100), `description?` (≤2000) per `CreateProjectDto`.
- Client-side search/filter over the returned list.
- Empty state with CTAs to the Templates Browser and the AI Generate/Design dialogs.
- Role-gated delete: hide/disable for `MEMBER`; only `OWNER`/`ADMIN` may delete (enforced server-side; reflect it in the UI).

**Endpoints used:**

| Endpoint | Purpose |
|---|---|
| `GET /orgs` | Populate the switcher: `[{ id, name, role, createdAt, updatedAt }]` |
| `GET /orgs/:orgId/projects` | List projects for the active org |
| `POST /orgs/:orgId/projects` | Create a project (`{ name, description? }`) |
| `DELETE /projects/:projectId` | Delete (RBAC-gated; returns `{ success: true }`) |

**Caveats:**
- Projects are always fetched under an `orgId` — there is no global "all my projects" endpoint. Re-fetch when the active org changes.
- `GET /orgs` carries the caller's `role` per org; use it to gate the delete affordance before the request is even attempted.

---

### 2.3 Project + Version History

**Purpose:** View a single project, browse its **immutable** version timeline, and open any version in the editor. Versions are append-only — every editor save creates a new `ProjectVersion`; there is no version mutate/PATCH.

**Key elements:**
- Project header (name, description) with inline edit via `PATCH /projects/:projectId`.
- Version list: `versionNumber`, `createdAt`, `createdByUserId`. The list endpoint returns **summaries only — no circuit JSON** (keep it lightweight).
- "Open in editor" per version (routes to `/editor/:versionId`).
- Per-version "Simulate" entry point (deep-links into the Simulation Control Panel for that version).
- Role-gated project delete.

**Endpoints used:**

| Endpoint | Purpose |
|---|---|
| `GET /projects/:projectId` | Project detail + nested `org` |
| `PATCH /projects/:projectId` | Update `{ name?, description? }` |
| `GET /projects/:projectId/versions` | Version summaries (`{ id, versionNumber, createdAt, createdByUserId }`) — no `circuitJson` |
| `GET /versions/:versionId` | Full version (`circuitJson` + `uiJson`) + nested `project` — fetched lazily on open |
| `POST /projects/:projectId/versions` | Create a new version (`{ circuitJson, uiJson }`); `versionNumber` is auto-incremented server-side |

**Caveats:**
- Do not assume the version list contains circuit data — fetch the full version only when the user opens it.
- Versions are immutable: model "edit" as "create the next version," never as mutating an existing one.

---

### 2.4 Schematic Editor (core screen)

**Purpose:** Create and edit the `CircuitJson` graph and its `UiJson` layout. This is the heart of the app and the most complex screen. The `CircuitJson` / `UiJson` shapes it edits are defined in the Shared Data Model & Types section (§6).

**Key elements:**
- Canvas with grid, pan/zoom (drives `uiJson.viewport`), component placement (drag from palette → `positions[id]`), rotation (0/90/180/270), and wiring (draw `wires[netId]`, which creates/links `Net`s and pin→net connections).
- Component palette: the v1 editor MAY expose a curated subset (e.g. the everyday passives + sources + diode + ground), but **drive types/pins from `COMPONENT_TYPES`/`COMPONENT_PINS`, never a hardcoded list** (see §6.2). The engine itself supports far more — active devices (bjt/mosfet/jfet), op-amp/IC `subckt` macromodels, controlled/behavioral sources, **and the full digital family** (`logic_and/or/nand/nor/xor/xnor/not/buffer` + `dff`) with automatic analog↔digital bridging and per-component digital timing via `properties` (see [docs/EDA_CORE.md §1.7.1](docs/EDA_CORE.md)). Which of these the v1 palette surfaces is a frontend scope decision; the type/pin/validation plumbing must still come from the package so it can't drift.
- Properties inspector for `designator` (must match `/^[A-Z][A-Z0-9]*[0-9]+$/` — must **end in a digit**, e.g. `R1`, `GND1`), `value` (SPICE strings like `10k`, `100n`, `DC 5`, `SIN(0 1 1k)`), and `model` (diodes only — and you may omit it; eda-core injects `DDEFAULT`).
- Live ERC panel running eda-core's `runErc(circuit)` **client-side** (pure function, no secrets): renders `issues[]` with code/severity/message and highlights related component/net ids; block save on `error`-severity issues.
- Toolbar entry points to Simulate, AI Generate/Edit/Explain, Import, Export.
- Undo/redo (local history), multi-select, keyboard shortcuts, autosave to a **local draft** (not to the server until explicit save).

**Endpoints used:**

| Endpoint | Purpose |
|---|---|
| `GET /versions/:versionId` | Hydrate `circuitJson` + `uiJson` on open |
| `POST /projects/:projectId/versions` | Persist on save → creates the next immutable version |
| `POST /explain-circuit` | (optional) Inline "Explain this circuit" → `{ explanation }` |
| `POST /edit-circuit` | (optional) Apply a natural-language edit to the current circuit |

**Caveats:**
- Keep electrical `CircuitJson` and visual `UiJson` as one coherent store — no split-brain. Validate with `safeValidateCircuitJson` before every save; never POST an unvalidated graph.
- There is no PATCH on versions: each save is a new version. Surface that clearly so users understand the timeline grows.
- Schema limits cap at ≤1000 components and ≤1000 nets — virtualize/`memo` for large circuits.

---

### 2.5 Simulation Control Panel (analysis config + run + job status)

**Purpose:** Configure an analysis, choose probes, submit a server-batch job, and watch its lifecycle. Simulation is **server-batch only** — there is no client-side solver. The flow is always: submit → poll status → fetch result.

**Key elements:**
- Analysis-type tabs producing the exact `AnalysisConfig` discriminated union (`packages/eda-core/src/types/analysis.ts`):

| Type | Shape |
|---|---|
| TRAN | `{ type: 'tran', stopTime, stepTime?, startTime?, maxStep?, uic?, initialConditions? }` |
| AC | `{ type: 'ac', variation: 'dec' \| 'oct' \| 'lin', points: number, startFreq, stopFreq }` |
| DC | `{ type: 'dc', source, startVal, stopVal, increment }` (`source` is a component designator, e.g. `V1`) |
| OP | `{ type: 'op' }` |

  Time/freq/value fields are SPICE value strings (e.g. `10m`, `1u`, `1MEG`). Validate client-side with eda-core's `parseSpiceValue` / value schema — remember `M`/`m` = milli, `MEG` = mega.
- **TRAN `initialConditions?: Record<string, number>`** — initial node voltages keyed by **net id** (e.g. `{ "fb": 0.5 }`, volts as plain numbers); the server emits a `.ic` card per entry (ground/unknown ids are skipped). Use it to kick a symmetric self-starting oscillator off its dead equilibrium (Wien bridge / ring / relaxation — without a seed those simulate as a flat line). Leave `uic` **unset** for circuits with supplies (the robust default: the op-point is solved with the seeded nodes pinned, then released); set `uic: true` only for pure-reactive seeding (a charged cap / LC tank with no supply — forcing `uic` on a supplied circuit zeroes the rails and aborts). Surface it as an advanced field on the TRAN tab; template `analysisConfig` records may carry it (the Wien-bridge template does).
- **Single-point AC** (`startFreq === stopFreq`) is legal — the server emits a one-point linear sweep and returns one row.
- **Solver tuning `options?` (all four analysis types):** `{ reltol?, abstol?, vntol?, gmin?, method?: 'trap'|'gear', itl4? }` → emitted as an ngspice `.options` card. An advanced/collapsed panel ("Convergence aids") — defaults are right for most circuits; a stiff power circuit that trips "Timestep too small" can be rescued with looser `reltol` (e.g. "0.01"), `gmin` "1e-9", or `method: "gear"`. Values are SPICE numbers, server-validated (invalid ones dropped).
- Probe picker producing `probes: string[]` like `["v(out)", "v(in)", "i(R1)"]`. **Mandate explicit probes** to avoid the empty-series quirk documented in the Results / Waveform Viewer screen (§2.6).
- **Current-probe support by device:** `i(V…)`/`i(L…)` (sources, inductors) work in **every** analysis. `i(R…)`/`i(C…)` (resistors, capacitors) work in **op/dc/tran** but are silently dropped in **AC** (no small-signal device-current vector exists — the voltage co-probes still return). A current probe on a diode or transistor terminal is never available — probe a series resistor's current instead. Reflect this in the probe picker (disable/annotate per analysis type) so users aren't surprised by a missing series.
- Default probes (to pre-populate the picker): eda-core does **not** export a `generateDefaultProbes` helper. Compute defaults locally from the exported `getNodeNames(circuit)` — map each non-ground node to a voltage probe, e.g. `getNodeNames(circuit).filter((n) => n !== '0' && n.toLowerCase() !== 'gnd').map((n) => \`v(${n})\`)`. The frontend still presents these as an editable suggestion; the picker output remains the authoritative `probes` array. (`getNodeNames` and `extractProbes` are the relevant probe-related exports of `@circuit-forge/eda-core`.)
- "Run" button, a job-status chip, and a recent-jobs list for the current version.

**Endpoints used:**

| Endpoint | Request | Response |
|---|---|---|
| `POST /versions/:versionId/simulations` | `{ analysisConfig, probes? }` | `{ jobId }` (server runs `generateNetlist` from the version's `circuitJson`) |
| `POST /simulations/quick` | `{ netlist, analysisConfig? }` | `{ jobId }` (throttled 10/60s; runs against the caller's **first** org) |
| `GET /simulations/:jobId` | — | `{ id, status, createdAt, startedAt, finishedAt, metrics }` |

Status enum (`status` field): `QUEUED \| RUNNING \| SUCCEEDED \| FAILED \| CANCELED \| TIMED_OUT`.

**Caveats:**
- **No cancel endpoint exists**, and the worker never sets `CANCELED` — do not render a cancel action that calls the API. Treat `CANCELED` defensively in the status renderer but never produce it.
- `POST /simulations/quick` ignores the version context and runs against the user's **first** org — use it only for the raw-netlist scratchpad path, not for saved-version runs.
- `metrics` is `null` while the job is QUEUED/RUNNING; once it reaches a terminal state (`SUCCEEDED`/`FAILED`) the status response carries `metrics` (incl. `pointsCount`). The full series only arrives via the result endpoint (§2.6).
- Set a sane client-side polling timeout (poll roughly every ~1s) and surface `FAILED`/`TIMED_OUT` distinctly.

---

### 2.6 Results / Waveform Viewer

**Purpose:** Render multi-trace waveforms from a completed simulation. This is the analysis payoff screen.

**Key elements:**
- Multi-trace plot with a per-series legend (toggle + color), zoom/pan (box + wheel), draggable cursors with delta readout (Δx, Δy), and measurements (min/max/pk-pk/RMS, plus frequency/rise-time where meaningful).
- X-axis adapts to the analysis type: `tran` → time/s, `ac` → frequency/Hz (offer a log option), `dc` → sweep variable, `op` → single operating point.
- Metrics readout (`runtimeMs`, `pointsCount`) and an error/timeout state.

**Data shape** (eda-core `SimulationResult`, `packages/eda-core/src/types/simulation.ts`):

```ts
interface SimulationResult {
  meta: {
    analysisType: string;
    xLabel: string;
    xUnit?: string;
    pointsCount: number;
    simulationTime?: number; // worker runtime in ms
  };
  series: { name: string; unit?: string; points: { x: number; y: number }[] }[];
}
```

**Endpoints used:**

| Endpoint | Outcome | Response |
|---|---|---|
| `GET /simulations/:jobId/result` | status ≠ `SUCCEEDED` | `{ id, status, error }` (`error` is the worker `stderr`) | **`?maxPoints=N`** (10..100000) decimates each series server-side with MIN-MAX bucketing (peaks/glitches survive); `meta.downsampledFrom` carries the original count. Use ~2-4× the chart pixel width for fast first paint, refetch full on zoom. |
| `GET /simulations/:jobId/result` | status = `SUCCEEDED` | `{ id, status, result: SimulationResult, metrics }` |

**Caveats (handle all three):**
- **Empty series without probes:** if `status === 'SUCCEEDED'` but `result.series` is empty, the run had no probed signals. Show "no probed signals — re-run with explicit probes" rather than a blank chart. This is why §2.5 mandates explicit probes. `pointsCount` is always present in `metrics` even when `series` is empty.
- **Rare `result: null` on a SUCCEEDED job:** large results (>1MB) are spilled to S3 by the worker (`resultJson` null, `resultS3Key` set) and the API **now re-hydrates them from S3** (key `results/{jobId}/result.json`) on read — so normally `result` is populated. If a SUCCEEDED job returns `result: null`, the response **also** carries an `error: "Result data is currently unavailable from storage."` (`apps/api/src/simulation/simulation.service.ts:166`). Treat this as a **transient storage-fetch failure** and offer **Retry** — do not present it as "result too large." It is distinct from an empty-but-valid dataset (which has a non-null `result` with empty `series`).
- For non-success states, render `status` plus `error` (the `stderr`) so the user can debug a `FAILED`/`TIMED_OUT` run.

---

### 2.7 Templates Browser

**Purpose:** Start from a reusable circuit. Browse public templates plus the active org's templates.

**Key elements:**
- Grid/list with name, tags, and a preview rendered from `circuitJson`.
- Tag filter; pagination via `limit` (default 50) / `offset` (default 0).
- Public-vs-org tab (the org tab requires an active org with membership).
- "Use as new project" / "Insert into editor"; create-template-from-current-circuit; role-gated delete for org templates.

**Endpoints used:**

| Endpoint | Request | Notes |
|---|---|---|
| `GET /templates` | query `orgId?`, `tag?`, `limit?`, `offset?` | No `orgId` → public templates only. With `orgId` → that org's templates (requires membership). Uses an optional JWT guard, so unauthenticated public browse works. |
| `GET /templates/:templateId` | — | `templateId` runs through `ParseUUIDPipe` |
| `POST /templates` | `{ orgId?, name, tags?, circuitJson, analysisConfig? }` | Omit `orgId` for a public template; `orgId` is `@IsUUID()`-validated. `analysisConfig.analysis` is server-validated as a real `AnalysisConfig`. |
| `DELETE /templates/:templateId` | — | RBAC-gated (`OWNER`/`ADMIN`); public templates cannot be deleted |

**`analysisConfig` (optional, on template records):** `{ analysis: AnalysisConfig, probes?: string[] }` — the recommended, validated simulation setup for the template. When present, the "Run" action should pre-fill the Sim Panel from it instead of defaulting to `op`. This matters for circuits that need transient `initialConditions` to start (e.g. the Wien-bridge oscillator template seeds one node — without that seed a symmetric oscillator stays at its equilibrium and the result is a flat line). Templates without it: fall back to the analysis suggested in the description text.

**Seeded catalog (what the browser will actually show):** 31 public templates — 10 simple inline circuits (RC filter, divider, buck, Sallen-Key, 555-style astable, Class-AB, R-2R DAC, …) plus **21 ngspice-validated catalog circuits** in `apps/api/prisma/templates/*.json`: flagships (8-bit ALU, DDS, power amp, dual-rail PSU), real-world projects (LDO, Class-D, overdrive pedal, RIAA, load-cell in-amp, KHN filter, H-bridge, Howland pump, precision rectifier, Wien bridge, 7-segment counter), and sensor+LED instruments (bargraph VU, NTC thermostat, LDR night light, battery gauge, traffic light, sensor→ADC→7-seg). **7 of them carry `analysisConfig`** (the Wien bridge and all six sensor+LED instruments, 16–21) — give those a one-click "Run the validated sim" affordance. Tag facets worth surfacing as filters: `flagship`, `sensor`, `display`, `led`, `audio`, `power`, `digital`.

**Caveats:**
- `:templateId` and the `orgId` query/body field are validated as **UUIDs** (`ParseUUIDPipe` / `@IsUUID()`). ALL seeded public templates and the demo org use non-UUID ids (`template-<slug>`, e.g. `template-rc-low-pass-filter`, `demo-org-id`), so fetching a seeded template by id or passing `orgId=demo-org-id` returns **400**. Listing public templates (`GET /templates` with no `orgId`) works fine. Treat ids opaquely and surface 400s gracefully.
- Always re-validate a template's `circuitJson` with `safeValidateCircuitJson` before loading it into the editor.

---

### 2.8 AI Generate / Edit / Explain + Design dialogs

**Purpose:** Produce, modify, explain, or fully design-and-verify a circuit via the **backend** AI endpoints. All model calls go through the server — the client never holds a provider key. (The legacy frontend's worst bug was leaking the LLM key via a public env var; that is strictly forbidden here. See the Frontend Architecture & Stack section (§8), which holds Security/NFR.)

There are two distinct experiences:

**A) Generate / Edit / Explain dialog** — fast, single-shot, returns a circuit to preview and insert.

| Endpoint | Throttle | Request | Response |
|---|---|---|---|
| `POST /generate-circuit` | 5/60s | `{ prompt: 1–2000, constraints?: ≤1000 }` | `{ circuit: CircuitJson, analysisConfig: AnalysisConfig, explanation?: string, repaired: boolean }` |
| `POST /edit-circuit` | 5/60s | `{ circuit: CircuitJson, instruction: 1–2000, analysisConfig?, constraints?: ≤1000 }` | same shape as generate |
| `POST /explain-circuit` | 10/60s | `{ circuit: CircuitJson }` | `{ explanation: string }` |

- UI: prompt textarea, optional constraints field, "Generate" / "Apply edit". Show a loading state, then **preview** the returned circuit (render + ERC summary) before "Insert into editor" / "Discard" / "Regenerate".
- `repaired: true` means the model's first output failed validation and the backend ran one automatic JSON-repair retry. Surface a subtle "auto-repaired" badge so users know the result was corrected.
- Edit takes the **current** circuit and an instruction and returns a full replacement circuit — diff or preview before applying.

**B) AI Design dialog** — the headline, one-shot agentic flow that returns a circuit **already verified by simulation**, with the waveform attached.

| Endpoint | Throttle | Latency | Request |
|---|---|---|---|
| `POST /design-circuit` | 3/60s | ~10–60s | `{ prompt: 1–2000, constraints?: ≤1000, maxRounds?: 1–4 (default 2) }` |

Response (`apps/api/src/generation/design.service.ts:94`):

```ts
{
  ok: boolean;
  circuit: CircuitJson;
  analysisConfig: AnalysisConfig;
  explanation?: string;
  rounds: number;
  history: { round: number; status: string; pointsCount: number; jobId?: string; note?: string }[];
  simulation: {
    jobId?: string;
    status: string;
    metrics?: SimulationMetrics; // NOTE: NOT exported by eda-core — declare locally: { runtimeMs?, outputSizeBytes?, pointsCount?, error? }
    result?: SimulationResult | null;
  };
  warning?: string; // present when ok === false (round budget exhausted)
}
```

- UI: prompt + optional constraints + a `maxRounds` selector (1–4). Show a long-running progress affordance with the round count, since the request can take ~10–60s. Stream/poll-free — it is one blocking request.
- On `ok: true`, jump straight to the Waveform Viewer using `simulation.result` (already a `SimulationResult`) — no separate poll needed. Also offer "Insert circuit into editor."
- On `ok: false`, show the `warning` and the per-round `history`, still offer the best-effort circuit for insertion, and let the user retry with a higher `maxRounds`.

#### `POST /verify-design` — deterministic Verified-Designs evidence pack (10/60s)

Verify ANY circuit by simulation — no AI, fully deterministic. Use it behind a "Verify" button, in a design-review panel, or to re-check a circuit the user edited.

Request:
```ts
{
  circuit: CircuitJson,                  // required
  analysisConfig?: AnalysisConfig,       // optional; defaults to an operating-point analysis
  assertions?: {                         // optional; max 50. Each is one spec checked vs the SIMULATION
    probe: string;                       // a NODE name — "out" or "v(out)" (the v() wrapper is optional, case-insensitive).
                                         //   ⚠️ current/power probes (i(R1), @r1[i]) are NOT supported yet → 400.
    metric: 'min' | 'max' | 'final' | 'pp';   // pp = peak-to-peak (max-min). final = last value (use for DC/settled level).
    op: 'lt' | 'lte' | 'gt' | 'gte' | 'approx';
    value: number;                       // SI base units (volts/seconds)
    tol?: number;                        // absolute tolerance for op:"approx" (default 5% of |value|)
    label?: string;                      // shown in the report
  }[]
}
```
Response `DesignEvidence` (always `200` for a valid circuit — a failed verification is a `200` with `verdict:"fail"`, NOT an error):
```ts
{
  verdict: 'pass' | 'fail' | 'inconclusive'; // pass = sim ok + no ERC errors + all assertions met;
                                             // fail = sim failed OR an ERC error OR any assertion unmet;
                                             // inconclusive = sim couldn't run / produced no data (e.g. ngspice off).
  summary: string;                           // one-line human verdict
  simStatus: 'ok' | 'failed' | 'skipped';
  analysisType?: string;
  runError?: string;
  erc: { errors: {code,message,relatedIds}[]; warnings: {code,message,relatedIds}[] };
  measurements: { node: string; min: number; max: number; final: number; pp: number }[]; // per node, the EVIDENCE
  assertions: { label; probe; metric; op; target; tol?; actual: number|null; pass: boolean; detail: string }[];
  checks: { total: number; passed: number; failed: number };
  // Present only when the run hit a CONVERGENCE failure (the "Convergence Doctor" auto-applied solver
  // remedies). recovered:true means a remedy fixed it — surface a subtle "needed solver help: <remedy>"
  // note on an otherwise-pass; recovered:false means it couldn't be solved (diagnosis explains why).
  convergence?: { recovered: boolean; kind: string; diagnosis: string; remedyApplied?: string; rationale?: string; attempts: number; triedRemedies?: string[]; note?: string };
  // Per-resistor steady-state power dissipation (P=ΔV²/R) + over-rating flags. INFORMATIONAL — does
  // NOT change `verdict` (the default 0.25W rating is a guess). basis 'last-timestep' on tran/ac.
  power?: { basis: 'operating-point' | 'last-timestep'; anyOverRating: boolean;
            components: { designator: string; dissipationW: number; ratingW: number; ratingIsDefault: boolean; overRating: boolean }[] };
}
```
- Render `verdict` as a badge (green pass / red fail / grey inconclusive) + `checks` (e.g. "2/3 specs met"). Show each assertion row with `actual` vs `target` and the ✓/✗. Plot `measurements` / the waveform as the "receipts".
- If `convergence` is present, show the plain-language `diagnosis` (and `remedyApplied` when `recovered`) — this turns ngspice's cryptic "Timestep too small" into something a user understands.
- If `power` is present, show each resistor's dissipation; badge `overRating` ones (⚠️ red when `ratingIsDefault:false`, softer amber when it's the 0.25W default guess). It never fails the verdict — it's a heads-up, not a gate.
- `400` only for a malformed `circuit`/`analysisConfig` or an unsupported current probe — everything else (even a circuit that doesn't simulate) returns a `200` evidence pack.

**Caveats (all AI dialogs):**
- Re-validate the returned `circuit` with `safeValidateCircuitJson` (and `analysisConfig` with `safeValidateAnalysisConfig`) client-side before inserting — defense in depth even though the backend already validated.
- Respect the throttles. On `429`, back off and show the retry-after window. `design-circuit` at 3/60s is the tightest.
- Degrade gracefully: if the backend is unreachable, show a clear error with **Retry**. These endpoints are deployed — never ship an "AI coming soon" stub.
- The endpoints may surface `503` (AI not configured server-side), `422` (model produced invalid output even after repair), or `502` (upstream/gateway failure). Map these to distinct user-facing messages.

---

### 2.9 Asset / Model Manager (presigned upload)

**Purpose:** Upload and manage SPICE model files per org. Uploads use **backend-issued presigned URLs** — the client never holds S3 credentials.

**Key elements:**
- Asset list (name, type, size, date) with an optional type filter.
- Three-step upload: presign → direct `PUT` to S3 → commit.
- Download (via presigned URL) and role-gated delete.

**Endpoints used (3-step upload):**

| Step | Endpoint | Request | Response |
|---|---|---|---|
| 1. Presign | `POST /orgs/:orgId/assets/models/presign` | `{ name, contentType, sizeBytes (1..10MB), sha256 }` | `{ uploadUrl, s3Key, ... }` |
| 2. Upload | (the returned `uploadUrl`) | raw bytes via `PUT` | S3 200 |
| 3. Commit | `POST /orgs/:orgId/assets/models/commit` | `{ s3Key, name, contentType, sizeBytes, sha256 }` | the persisted `Asset` |
| List | `GET /orgs/:orgId/assets/models?type=` | — | asset list |
| Detail | `GET /assets/:assetId` | — | asset detail |
| Download | `GET /assets/:assetId/download` | — | `{ downloadUrl }` (presigned) |
| Delete | `DELETE /assets/:assetId` | — | RBAC-gated |

**Caveats:**
- Compute `sha256` client-side (Web Crypto `crypto.subtle.digest`) — it is `@IsHash('sha256')`-validated on both presign and commit and must match the uploaded bytes.
- Enforce the **10MB** cap before requesting a presign (`@Max(10 * 1024 * 1024)` in `PresignUploadDto`).
- The `:orgId` path param is `ParseUUIDPipe`-validated — the same non-UUID demo-org caveat from §2.7 applies.
- The presigned `PUT` goes directly to S3/MinIO, not to the API — handle CORS/network errors on that leg separately from API errors.

---

### 2.10 Settings / Org Switcher

**Purpose:** Manage the account/session, switch the active org, create new orgs, and view the caller's role.

**Key elements:**
- Active-org selector (persisted locally), driven by `GET /orgs`.
- "Create organization" (`POST /orgs`) — the creator becomes `OWNER`.
- Current-user display (`user: { id, email, name }` from the auth response — no separate `/me` endpoint exists; cache it from login/refresh).
- Per-org role badge (from `GET /orgs` / `GET /orgs/:orgId`).
- Local preferences (theme/units) and sign-out (clear tokens; call `POST /auth/logout`).

**Endpoints used:**

| Endpoint | Purpose |
|---|---|
| `GET /orgs` | List the user's orgs (with `role`) |
| `POST /orgs` | Create an org (`{ name }`) |
| `GET /orgs/:orgId` | Org detail + caller `role` |
| `POST /auth/logout` | Client-side logout (204) |

**Caveats:**
- There are **no member-management endpoints** (no invite, role-change, or member-list API) — do not build a member-admin UI in v1.
- There is no `GET /me` — derive the current user from the cached `user` object returned by login/register/refresh.

---

### Definition of done (screen coverage)

- [ ] Every screen above is reachable and renders against the live API at `http://localhost:3001` with the seeded demo account.
- [ ] All requests except `/auth/*`, `/health`, and public-template reads send `Authorization: Bearer <accessToken>`; 401s trigger the refresh loop (§4).
- [ ] No provider/LLM key, JWT secret, or S3 credential appears anywhere in client code or the bundle (§8, Frontend Architecture & Stack / Security).
- [ ] `CircuitJson` / `AnalysisConfig` are validated with eda-core's Zod validators before every POST and after every read; nothing is cast `as CircuitJson`.
- [ ] The Waveform Viewer handles all three result states: populated series, empty-series-without-probes, and the rare `result: null` storage-fetch failure (with Retry).
- [ ] The AI Design dialog handles the long-running request, `ok: true` (jump to waveform via `simulation.result`), and `ok: false` (show `warning` + `history`).
- [ ] RBAC affordances (project/template/asset delete) are gated on the per-org `role` from `GET /orgs`.
- [ ] Throttle responses (`429`) on AI and quick-sim endpoints are handled with backoff and user feedback.


## 3. Key User Flows

This section walks the three core user journeys end-to-end, naming the exact endpoint, request body, and response/state at every step. Treat these as the canonical happy-paths the UI must support. Endpoint contracts and DTOs are spelled out in full in the Backend Integration Contract (§4); error semantics and token handling also live there. Import/export details are covered in this section (§3) and the Frontend Architecture & Stack section (§8). Cross-reference rather than re-derive.

All requests below are against the API base URL `http://localhost:3001` (no global route prefix — paths are exactly as written). Every endpoint here is JWT-guarded except where noted; send `Authorization: Bearer <accessToken>`. The simulation engine is **server-batch only** — there is no client-side solver. The frontend submits a job, polls status, then fetches the parsed result.

> **eda-core is your contract enforcer.** Validate with `safeValidateCircuitJson` / `safeValidateAnalysisConfig` before every POST that carries circuit/analysis data, and again after every read. Never `as CircuitJson`. The exact import surface and types live in the Shared Data Model & Types section (§6). Functions referenced below — `safeValidateCircuitJson`, `safeValidateAnalysisConfig`, `generateNetlist`, `parseNetlist`, `runErc`, `getNodeNames` — are all pure, client-importable from `@circuit-forge/eda-core`.

---

### Flow A — Design (editor) → Save version → Simulate → poll → view waveforms

This is the primary authoring loop. A simulation always runs against a **saved version**, never against unsaved editor state.

| # | Action | Call | Request | Response / State |
|---|--------|------|---------|------------------|
| A1 | Sign in | `POST /auth/login` | `{ email, password }` | `{ accessToken, refreshToken }`. Hold `accessToken` in memory; treat `refreshToken` per the token strategy in the Backend Integration Contract (§4). Demo creds: `demo@circuitforge.io` / `demo123456`. |
| A2 | Pick org | `GET /orgs` | — | List of orgs the user belongs to. Set an **active org** in app state. |
| A3 | Pick project | `GET /orgs/:orgId/projects` → `GET /projects/:projectId` | — | Project metadata + (next call) its versions. |
| A4 | List / open a version | `GET /projects/:projectId/versions`, then `GET /versions/:versionId` | — | Version row carries `circuitJson` and `uiJson`. Validate `circuitJson` with `safeValidateCircuitJson` on read; hydrate the editor from `uiJson` (positions/wires/viewport). |
| A5 | Edit schematic | — (client only) | — | Place/wire components. Run `runErc(circuit)` live; surface `error`-severity issues and block save (or warn) until resolved. ERC is **client-side**; the backend does not run it. |
| A6 | Save a new version | `POST /projects/:projectId/versions` | `{ circuitJson, uiJson }` (both required objects) | New immutable version → returns the version record incl. its `id`. **Versions are append-only** — there is no update/delete endpoint; "save" always creates a new version. |
| A7 | Configure analysis | — (client only) | — | Build an `AnalysisConfig` (discriminated by `type`) and an **explicit `probes` array**. Validate the config with `safeValidateAnalysisConfig`. See the analysis shapes and the probes quirk below. |
| A8 | Submit simulation | `POST /versions/:versionId/simulations` | `{ analysisConfig, probes? }` | `{ jobId }`. The job is enqueued with `status: "QUEUED"`. |
| A9 | Poll status | `GET /simulations/:jobId` | — | `{ id, status, createdAt, startedAt, finishedAt, metrics }`. Poll until `status` is terminal. `metrics.pointsCount` is populated on success. |
| A10 | Fetch result | `GET /simulations/:jobId/result` | — | On success: `{ id, status, result, metrics }` where `result` is the eda-core `SimulationResult` `{ meta, series }`. Render `series` in the waveform viewer. |

#### A7 — Analysis config shapes

`analysisConfig` is a discriminated union on `type` (from `@circuit-forge/eda-core`, `packages/eda-core/src/types/analysis.ts`). Build exactly one of:

```ts
// Transient (time domain) — the common default
{ type: 'tran', stopTime: '10m', stepTime?: '10u', startTime?: '0', maxStep?: string, uic?: boolean }

// AC (frequency domain, small-signal)
{ type: 'ac', variation: 'dec' | 'oct' | 'lin', points: 20, startFreq: '1', stopFreq: '1MEG' }

// DC sweep
{ type: 'dc', source: 'V1', startVal: '0', stopVal: '5', increment: '0.1' }

// Operating point (single DC solution)
{ type: 'op' }
```

Values are SPICE-style strings with engineering suffixes (`k`, `MEG`, `m`, `u`, `n`, `p`, …). Note SPICE's `M`/`m` both mean **milli**; use `MEG` for mega.

#### A8/A9 — Polling strategy

The `SimJobStatus` enum is `QUEUED | RUNNING | SUCCEEDED | FAILED | CANCELED | TIMED_OUT`.

- **Terminal states the UI must handle:** `SUCCEEDED`, `FAILED`, `TIMED_OUT`.
- `CANCELED` exists in the schema but is **never set** — the worker does not emit it and there is **no cancel endpoint**. Do not build a "cancel" button expecting server-side cancellation; at most abandon polling client-side.
- Use a bounded backoff, e.g. poll every ~700 ms ramping to ~2 s, with an overall cap (server timeout defaults to ~10 s of ngspice wall-clock; allow generous headroom for queue wait + parsing, e.g. a 60–90 s client cap). A typical quick sim resolves in a few seconds.
- `startedAt` flips from null when the job leaves `QUEUED`; `finishedAt` is set at any terminal state. You can show "queued vs running" by comparing these.

#### A10 — Reading the result (success vs failure)

`GET /simulations/:jobId/result` returns **two different shapes** depending on status (`apps/api/src/simulation/simulation.service.ts:139`):

```ts
// status === 'SUCCEEDED'
{ id: string, status: 'SUCCEEDED', result: SimulationResult, metrics: { runtimeMs, outputSizeBytes, pointsCount } }

// any non-SUCCEEDED status (FAILED | TIMED_OUT | still QUEUED/RUNNING if polled early)
{ id: string, status: SimJobStatus, error: string | null }   // error == job.stderr
```

`SimulationResult` is `{ meta: { analysisType, xLabel, xUnit?, pointsCount, simulationTime? }, series: Array<{ name, unit?, points: Array<{ x, y }> }> }`. Plot each `series` against the shared X axis (`meta.xLabel` / `meta.xUnit`).

> **S3 re-hydration (large results).** When a parsed result exceeds 1 MB the worker spills it to S3 and leaves the DB `resultJson` null. `getResult` now **re-hydrates from S3** (key `results/{jobId}/result.json`) and returns the full `result` transparently — your client does not call S3 and needs no S3 credentials. The **only** time a `SUCCEEDED` response has `result: null` is when that S3 fetch/parse fails; in that case the response also carries `error: "Result data is currently unavailable from storage."`. Treat `SUCCEEDED` + `result === null` as "temporarily unavailable, retry," distinct from a genuinely empty dataset. `metrics.pointsCount` is **always** present even when `result` is unavailable, so use it as the source of truth for "did this produce data."

> ⚠ **Quirk — version sims without explicit probes return empty series.** A version sim submitted with **no `probes`** (or `probes: []`) still **SUCCEEDS** and ngspice produces real data, but the stored `series` is **empty** and `metrics.pointsCount === 0`. Cause: the netlist generator injects default probes for the netlist, but the worker's CSV parser only builds series for the probe names it was handed — and the API forwards `probes || []`, so the parser sees none (`docs/SIMULATION.md` §9). **Mitigation:** always derive and send an explicit `probes` array at step A7. You can compute sensible defaults client-side from the circuit's net names via eda-core's `getNodeNames(circuit)`, mapping each non-ground node (ground is the `'0'` node) to a voltage probe locally, e.g. `getNodeNames(circuit).filter((n) => n !== '0').map((n) => `v(${n})`)` (yielding `["v(out)","v(in)"]`). If a sim comes back `SUCCEEDED` with `pointsCount === 0`, show a "no probed signals" hint rather than a blank chart.

#### Flow A — Definition of done

- [ ] Editor hydrates from a fetched version's `circuitJson` + `uiJson`; `circuitJson` passes `safeValidateCircuitJson`.
- [ ] ERC runs live; `error`-severity findings are surfaced before save.
- [ ] Save creates a new version and the UI switches to that `versionId` (append-only — no edit-in-place).
- [ ] Analysis config validated with `safeValidateAnalysisConfig`; an **explicit, non-empty `probes`** array is sent.
- [ ] Polling handles all terminal states and never assumes `CANCELED`.
- [ ] Waveform viewer renders `result.series`; handles `SUCCEEDED + result === null` (retry) and `pointsCount === 0` (no-data hint) distinctly.
- [ ] Failure path shows `error`/`stderr` text from the result response.

---

### Flow B — AI Generate / Design → preview (validate client-side) → Insert / Open as new version → simulate

The AI endpoints are **built and verified**, served by `apps/api/src/generation/` under the Swagger tag `ai`. The frontend **consumes** them; it does not implement any AI logic, and **no LLM/provider key ever reaches the client** — all AI runs server-side. There are two entry points with different shapes and costs.

#### B-1 — One-shot generate, then simulate yourself (`POST /generate-circuit`)

Use when you want a circuit fast and will drive simulation through the normal Flow A pipeline (or let the user keep editing first).

| # | Action | Call | Request | Response / State |
|---|--------|------|---------|------------------|
| B1.1 | Enter prompt | — | — | Optional `constraints` free-text. |
| B1.2 | Generate | `POST /generate-circuit` (rate limit **5 / 60 s**) | `{ prompt: 1–2000 chars, constraints?: ≤1000 chars }` | `{ circuit: CircuitJson, analysisConfig: AnalysisConfig, explanation?: string, repaired: boolean }`. The backend already validated the output with eda-core (with one automatic JSON-repair retry — `repaired: true` flags that it happened). |
| B1.3 | Validate client-side | — | — | Run `safeValidateCircuitJson(circuit)` and `safeValidateAnalysisConfig(analysisConfig)` **before** touching the editor. If either fails, show an error + "Regenerate"; never insert unvalidated data. (Defense-in-depth — the server validated too.) |
| B1.4 | Preview | — | — | Render the circuit read-only + a `runErc` summary + `explanation`. The AI returns **electrical-only** `CircuitJson` (no layout), so generate a sensible auto-layout `uiJson` for preview/insert. |
| B1.5 | Insert / open | — | — | Insert into the active editor doc, or open as a fresh editor doc. |
| B1.6 | Save + simulate | Flow A6 → A10 | — | Save as a new version, then run the standard simulate/poll/result loop. Prefill the sim panel from the returned `analysisConfig`, and derive explicit `probes` (see the Flow A probes quirk). |

#### B-2 — Agentic design: generate + simulate in one call, waveform returned inline (`POST /design-circuit`)

This is the headline flow: the server runs a closed loop — **generate → build netlist → simulate → on failure, AI-fix → re-simulate** — for up to `maxRounds` rounds, and returns a circuit **already verified by a real simulation**, with the waveform embedded in the response. Use this when the user wants "make me something that works" rather than hand-editing.

| # | Action | Call | Request | Response / State |
|---|--------|------|---------|------------------|
| B2.1 | Enter prompt | — | — | Optional `constraints`; optional `maxRounds` (1–4, default 2). |
| B2.2 | Design | `POST /design-circuit` (rate limit **3 / 60 s**, agentic, **~10–60 s** wall-clock) | `{ prompt: 1–2000, constraints?: ≤1000, maxRounds?: 1–4 }` | See shape below. **Long request** — show a determinate/indeterminate progress UI; do not time the client out aggressively (allow ≥ 90 s). |
| B2.3 | Validate client-side | — | — | Run `safeValidateCircuitJson` / `safeValidateAnalysisConfig` on the returned `circuit` / `analysisConfig` before inserting. |
| B2.4 | Show result inline | — | — | If `ok === true`, the response **already contains the verified waveform** in `simulation.result` — render it directly with **no further simulate call**. Show `explanation` and the per-round `history`. |
| B2.5 | Insert / open as version | Flow A6 | — | Auto-layout `uiJson`, insert/open, save as a new version. The user can then re-simulate or edit normally (Flow A). |

Response shape (`apps/api/src/generation/design.service.ts:36`):

```ts
{
  ok: boolean,                       // true => a clean, data-producing simulation was achieved
  circuit: CircuitJson,              // best circuit (verified when ok)
  analysisConfig: AnalysisConfig,    // analysis the AI chose
  explanation?: string,
  rounds: number,                    // rounds actually run
  history: Array<{
    round: number,
    status: string,                  // 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'NETLIST_ERROR'
    pointsCount: number,
    jobId?: string,
    note?: string
  }>,
  simulation: {
    jobId?: string,                  // present when a sim actually ran
    status: string,
    metrics?: { runtimeMs, outputSizeBytes, pointsCount },
    result?: SimulationResult | null // the inline waveform when ok === true
  },
  warning?: string                   // set when ok === false (budget exhausted)
}
```

- **`ok === true`:** render `simulation.result` immediately. This is the "it already works" path.
- **`ok === false`:** the loop exhausted its round budget without a clean run. `warning` explains it; `circuit` is still the best effort. Offer the user "insert anyway," "increase max rounds & retry," or "edit manually." `simulation.result` may be null here.
- The `jobId` in `simulation`/`history` is a real simulation job created under the user's first org — you **can** re-fetch it via `GET /simulations/:jobId/result` if you want, but for `ok === true` it is unnecessary since the waveform is inline.

#### B-3 — Edit & explain (supporting AI actions)

Wired to the same `ai` tag; both consume a `CircuitJson` you already hold:

| Action | Call | Request | Response |
|--------|------|---------|----------|
| Edit existing circuit | `POST /edit-circuit` (5 / 60 s) | `{ circuit: CircuitJson, instruction: 1–2000, analysisConfig?, constraints?: ≤1000 }` | Same shape as `/generate-circuit`: `{ circuit, analysisConfig, explanation?, repaired }`. Validate client-side, then preview/insert exactly like B1.3–B1.6. |
| Explain a circuit | `POST /explain-circuit` (10 / 60 s) | `{ circuit: CircuitJson }` | `{ explanation: string }`. Render as plain text; no circuit mutation. |

> **Diodes:** the AI omits the `model` field on diodes by design — eda-core injects the default `DDEFAULT` model at netlist generation. Do not flag a missing diode `model` as an error in preview/ERC.

#### Flow B — Definition of done

- [ ] No LLM/provider key, gateway URL, or model name exists anywhere in client code or the bundle (see the Security/NFR coverage in the Frontend Architecture & Stack section, §8). The only client-side env is the API base URL.
- [ ] Every AI response is re-validated client-side (`safeValidateCircuitJson` / `safeValidateAnalysisConfig`) before insertion; invalid → error + Regenerate, never insert.
- [ ] `repaired === true` is surfaced (subtle "auto-repaired" badge) so the user knows the output was retried.
- [ ] `/design-circuit` UI tolerates a 10–60 s request, renders `simulation.result` inline when `ok`, and handles `ok === false` (warning + options) without a blank state.
- [ ] AI-generated circuits get an auto-layout `uiJson` before entering the editor.
- [ ] Rate-limit responses (429) are handled gracefully with a retry-after hint (limits: generate/edit 5, explain 10, design 3 per 60 s).

---

### Flow C — Import SPICE netlist (quick sim) / Export results + CircuitJson

Import/export conversions happen **client-side** by reusing eda-core's pure functions, so the user gets exactly the netlist the backend would build. The import/export matrix lives in this section (§3, the C-2 table below) and in the Frontend Architecture & Stack section (§8); this is the runtime flow.

#### C-1 — Import a SPICE `.cir` and run a quick sim

`POST /simulations/quick` accepts a **raw netlist string** and runs it without requiring a saved project/version — ideal for "paste a netlist and simulate." It is rate-limited to **10 / 60 s** and bound to the user's **first org** server-side.

| # | Action | Call | Request | Response / State |
|---|--------|------|---------|------------------|
| C1.1 | Load `.cir` text | — (client) | — | User pastes or uploads a netlist. |
| C1.2 | Parse to circuit (optional, for editing) | — (client) | — | `parseNetlist(text)` → `{ circuit, analysis?, title?, errors[], warnings[] }`. Show `errors`/`warnings`. If a `.tran/.ac/.dc/.op` directive was present, `analysis` is populated — prefill the sim panel from it. |
| C1.3a | **Quick sim path** (no save) | `POST /simulations/quick` | `{ netlist: string, analysisConfig?: object }` | `{ jobId }`. If `analysisConfig` is omitted the worker defaults the analysis type to `tran`. Then poll/result exactly as Flow A9–A10. |
| C1.3b | **Editor path** (to save/iterate) | Flow A6 onward | — | Auto-layout the parsed `circuit` into `uiJson`, open in the editor, save as a version, then simulate via `POST /versions/:versionId/simulations`. |

> Quick sim sends `probeNames: []` to the worker, but because you supply a complete netlist (with its own `wrdata`/probe directives), this path is not subject to the version-sim empty-series quirk in the same way — the netlist you provide controls what's written. If you author the netlist via eda-core's `generateNetlist`, include probes in it. Still verify `metrics.pointsCount > 0` after the run.

#### C-2 — Export results and circuit

All exports are **client-side serializations** — no backend call:

| Export | Source | Mechanism |
|--------|--------|-----------|
| **Results → CSV** | `SimulationResult.series` (from the result response) | Serialize client-side: column 0 = shared X (`meta.xLabel`), then one column per `series[i].name`. |
| **Native project JSON** | Current version's `{ circuitJson, uiJson }` | Serialize and download directly. |
| **SPICE `.cir` netlist** | Current `circuit` + `analysisConfig` | `generateNetlist(circuit, analysisConfig, { probes, title })` (eda-core, deterministic). This yields the same netlist the backend would build for a sim job — the backend never exposes the generated netlist as a separate endpoint, so reusing eda-core client-side avoids a round-trip. |

#### Flow C — Definition of done

- [ ] `parseNetlist` errors/warnings are shown to the user before import; unparseable netlists do not silently produce an empty circuit.
- [ ] Quick-sim path submits a raw netlist and reuses the same poll/result handling (including the `SUCCEEDED + result === null` and `pointsCount === 0` cases) as Flow A.
- [ ] Imported circuits get an auto-layout `uiJson` before editing/saving.
- [ ] CSV export columns are X-then-series and round-trip cleanly; `.cir` export uses `generateNetlist` (not a hand-rolled serializer) and includes probes.
- [ ] Parsed `analysis` (when present) prefills the sim panel.

---

### State machine reference (shared by Flows A, B-2, C-1)

```
submit ──▶ QUEUED ──▶ RUNNING ──▶ SUCCEEDED ──▶ GET …/result ──▶ { result, metrics }   (pointsCount may be 0; result may be null only if S3 hydrate failed)
                              ├──▶ FAILED      ──▶ GET …/result ──▶ { status, error }   (error == stderr)
                              └──▶ TIMED_OUT   ──▶ GET …/result ──▶ { status, error }
```

`CANCELED` is in the enum but unreachable — do not depend on it. Poll `GET /simulations/:jobId` for status; only call `GET /simulations/:jobId/result` once terminal (calling it earlier returns the non-success shape with the in-flight `status` and a null/empty `error`).


## 4. Backend Integration Contract

> **Authoritative source.** Every contract below is derived from the running NestJS code under `apps/api/src/**` and the ground-truth docs (`docs/API.md`, `docs/SECURITY.md`), verified against source. Where the API's behavior is surprising or buggy, it is flagged as **QUIRK** with the exact frontend mitigation. **Do not invent endpoints or fields.** If the OpenAPI document at `/docs-json` disagrees with this section, the running server wins — regenerate the client and reconcile.
>
> **The rule that dominates this entire section:** the LLM provider key and every other secret stays **server-side**. The frontend NEVER calls an LLM provider, NEVER embeds a provider key, and NEVER uses a `NEXT_PUBLIC_` env var for anything secret. All AI generation goes through the backend endpoints in §4.4.9. The only client-visible config is the API base URL. (The previous frontend's worst defect was leaking the LLM key through a `NEXT_PUBLIC_` variable — that mistake must never recur.)

---

### 4.1 Base URL, environment config, CORS, validation, throttling

#### 4.1.1 Base URL & client env

| Concern | Value | Notes |
|---|---|---|
| Local API base URL | `http://localhost:3001` | The repo sets `PORT=3001` in the root `.env`. Code reads only `PORT` (`main.ts`, default `3000`); `API_PORT` is **ignored**. |
| OpenAPI JSON | `GET http://localhost:3001/docs-json` | Auto-served by `SwaggerModule.setup('docs', …)`. Generate the typed client from this (§4.5). |
| Swagger UI | `http://localhost:3001/docs` | Has an "Authorize" (Bearer) button. |
| Global route prefix | **none** | `main.ts` sets no `setGlobalPrefix`. Paths are exactly as written below (e.g. `/auth/login`, not `/api/auth/login`). |

The **only** required public env var is the API base URL. Validate it at boot and fail fast:

```ts
// src/lib/env.ts — validate at startup with Zod
import { z } from 'zod';

const Env = z.object({
  // Public base URL of the Circuit Forge API. NOT a secret.
  // Next.js: exposed to the client only via the NEXT_PUBLIC_ prefix.
  API_BASE_URL: z.string().url().default('http://localhost:3001'),
});

export const env = Env.parse({
  API_BASE_URL: process.env.NEXT_PUBLIC_API_URL,
});
```

> **MANDATE (anti-leak):** the only public-prefixed env var permitted is the API base URL. No provider keys, JWT secrets, S3 credentials, or DB URLs may ever appear in client code or the bundle. Add a CI grep that fails the build if a `NEXT_PUBLIC_` identifier appears next to `KEY`/`SECRET`/`TOKEN`/`PASSWORD` (anything `NEXT_PUBLIC_*` is inlined into the client bundle and is public).

#### 4.1.2 CORS

`main.ts` calls `app.enableCors()` with **no options** → it reflects the request origin (effectively all origins), allows the default methods, and **does not enable `credentials`**.

**Frontend consequences:**
- Cross-origin `fetch` works without preflight surprises for simple JSON requests.
- **Do not rely on cookies for auth.** Because `credentials` is not enabled server-side, a cookie-based session would not be sent cross-origin anyway. Auth is therefore **Bearer-token in the `Authorization` header** (§4.2). This aligns with the recommended in-memory access-token strategy.
- A production deployment will lock CORS to an explicit origin allowlist; nothing in the client needs to change when it does.

#### 4.1.3 Global ValidationPipe (request-body contract)

Configured once in `main.ts`:

```ts
new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })
```

| Option | Effect on the client |
|---|---|
| `whitelist: true` | Undeclared body properties are stripped. |
| `forbidNonWhitelisted: true` | **Any** undeclared body property → `400`. **Send exactly the documented fields and nothing more** (no stray `id`, `createdAt`, debug flags, etc.). |
| `transform: true` | Query strings are coerced into their DTO types (`limit`/`offset` → numbers via `@Type(() => Number)`). Send plain query params; no manual casting needed. |

**Frontend rule:** build request bodies from typed DTO factories that include *only* the fields in the tables below. Never spread a full domain object into a create/update call — extra keys produce a `400`.

#### 4.1.4 Throttling (rate limits) — ENFORCED

`app.module.ts` registers a global `ThrottlerGuard` (`APP_GUARD`) with two tiers: a per-route **`default`** budget (120 req/60 s unless a route overrides it) and a universal **`burst`** guard (30 req/1 s) that no route can exceed. These limits **are enforced** in dev/prod (skipped only under the jest test env). Health/liveness/readiness are exempt (`@SkipThrottle`).

Per-route overrides (these are the `default`-tier limits each route sets; the 30/1 s burst guard also applies to every one):

| Endpoint | Limit | Decorator location |
|---|---|---|
| `POST /versions/:versionId/simulations` | 30 / 60 s | `simulation.controller.ts` |
| `POST /simulations/quick` | 10 / 60 s | `simulation.controller.ts` |
| `POST /generate-circuit` | 5 / 60 s | `generation.controller.ts` |
| `POST /edit-circuit` | 5 / 60 s | `generation.controller.ts` |
| `POST /explain-circuit` | 10 / 60 s | `generation.controller.ts` |
| `POST /design-circuit` | 3 / 60 s | `design.controller.ts` |
| `GET /parts/search`, `/parts/:symbol`, `/parts/:symbol/component` | 30 / 60 s | `parts.controller.ts` |
| `GET /parts/manufacturers`, `/parts/categories` | 60 / 60 s | `parts.controller.ts` |
| `POST /netlist/import`, `/netlist/export` | 30 / 60 s | `netlist.controller.ts` |
| everything else | 120 / 60 s + 30 / 1 s burst | global default |

**Two distinct 429s — branch on the body, not the status code:**
- **Throttle 429** → body `{ statusCode: 429, message: "ThrottlerException: Too Many Requests" }` (no `code` field). Transient — back off ~2–5 s and retry once; debounce the triggering button.
- **Quota 429** → body `{ code: "QUOTA_EXCEEDED", metric, used, limit, period }` (see §4.5). A configured usage cap was hit — do **not** blind-retry; show the per-metric message and link to the usage page.

**Client must (code defensively now, not later):**
- Treat the per-route limits as the *contract* and budget the UI to stay within them — debounce AI/quick-sim buttons and disable them while a request is in flight; the 30/1 s burst guard means fanning out many parallel reads on a single screen can trip it, so batch/stagger bulk fetches.
- Be especially conservative on `POST /design-circuit` (3/60 s) — it is the most expensive call (§4.4.9).

---

### 4.2 Authentication flow & client token strategy

JWT-based. Tokens are minted in `AuthService.generateTokens` (`auth.service.ts`).

| Token | Secret | Expiry | Transport |
|---|---|---|---|
| `accessToken` | `JWT_SECRET` | **15m** (hardcoded in `auth.module.ts`) | `Authorization: Bearer <accessToken>` header on every protected call |
| `refreshToken` | `JWT_REFRESH_SECRET` | **7d** (hardcoded inline) | JSON body of `POST /auth/refresh` |

The JWT payload is `{ sub: userId, email }` for **both** tokens (they differ only by secret/expiry). The env vars `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` exist in `.env` but are **not read** — expiries are fixed in code.

#### 4.2.1 Exact request/response per auth endpoint

All four live on the `auth` controller, **no guard**, all public.

**`POST /auth/register`** → `201`
```jsonc
// Request (RegisterDto)
{ "email": "a@b.com", "password": "min8chars", "name": "Ada" }
// email: valid email · password: 8–100 chars · name: 1–100 chars
// Response 201 (TokensResponse)
{ "accessToken": "<jwt 15m>", "refreshToken": "<jwt 7d>",
  "user": { "id": "<uuid>", "email": "a@b.com", "name": "Ada" } }
// 409 if email already registered.
// Side effect: a personal org "Ada's Workspace" is created with the user as OWNER.
```

**`POST /auth/login`** → `200`
```jsonc
// Request (LoginDto)
{ "email": "a@b.com", "password": "..." }
// Response 200: same TokensResponse shape as register.
// 401 "Invalid credentials" for BOTH unknown email and wrong password
// (no user enumeration) — show one generic message.
```

**`POST /auth/refresh`** → `200` — **ROTATING & SINGLE-USE**
```jsonc
// Request (RefreshDto)
{ "refreshToken": "<jwt 7d>" }
// Response 200: a BRAND-NEW TokensResponse. The refresh token you sent is now CONSUMED — you MUST
// replace your stored refresh token with the returned one. The old one will never work again.
// 401 "Invalid refresh token" if expired/invalid/ALREADY-USED → force re-login.
// SECURITY: presenting an already-used refresh token (theft, OR a non-single-flighted double refresh)
// is treated as compromise and REVOKES THE WHOLE SESSION FAMILY — including the successor you just
// got. So single-flight is mandatory (§4.2.2), not optional.
```

**`POST /auth/logout`** → `204`
```jsonc
// Request (LogoutDto, all optional): { "refreshToken"?: "<jwt>", "allDevices"?: true }
// Send the refreshToken to actually revoke the session SERVER-SIDE (its whole family dies).
// allDevices:true revokes every session of the user ("log out everywhere"). Always 204, even for a
// missing/garbage token. The access token (≤15m) is stateless and survives until it expires.
```

> **QUIRKS to encode in types:**
> - `user` contains exactly `{ id, email, name }` — **no `createdAt`** in auth responses. Do not type it with `createdAt`.
> - Logout returns **204 with no body** — do not call `res.json()`; expect and allow an empty response.
> - Refresh tokens ARE revocable server-side now (rotation + reuse-detection + logout). The **access** token is still stateless: a leaked one is valid for its full ≤15m — which is why it must stay in memory only (§4.2.2). Send the refresh token to `/auth/logout` so the session is actually killed.
> - The seeded demo user is `demo@circuitforge.io` / `demo123456` (use it for development).

#### 4.2.2 Recommended client token strategy

| Token | Where to store | Why |
|---|---|---|
| **accessToken** | **In memory only** (a module-scoped variable / state-store auth slice; not persisted). | 15m lifetime, sent on every request. Keeping it out of `localStorage` removes the highest-value XSS theft target. |
| **refreshToken** | **In memory** for v1 (single-tab session); optionally a **same-site, secure cookie set by a small same-origin BFF route** in a later version. **Avoid `localStorage`** — it is a 7-day bearer credential. | Refresh tokens are now server-revocable (rotation + reuse-detection + logout), but a stolen one still grants access until it's used/revoked — and theft from `localStorage` is silent. Keep it out of persistent storage. |
| **user** (`{ id, email, name }`) | In-memory store; safe to also cache in `sessionStorage` for fast hydration (non-secret). | UI display only. |

**v1 pragmatic default (no BFF):** keep both tokens in memory inside the auth store. On a full page reload the session is lost and the user logs in again — acceptable for v1 and strictly safer than `localStorage`. Document this as a deliberate trade-off; a same-origin BFF cookie for the refresh token is the v2 upgrade.

**Silent refresh on 401 (single-flight — now MANDATORY):**
1. The fetch wrapper attaches `Authorization: Bearer <accessToken>`.
2. On `401` from any protected endpoint (and the failing request was not itself an `/auth/*` call), call `POST /auth/refresh` **once**, guarded by a shared in-flight promise so concurrent 401s trigger exactly one refresh. ⚠️ This is no longer just an optimization: refresh tokens are single-use, so two in-flight refreshes with the same token make the second look like token reuse and the backend revokes the **entire session** — instant forced logout. One refresh at a time, always.
3. On refresh success: **persist the returned refresh token in place of the old one** (it rotated — the old one is dead) and replace the access token, then **retry the original request once** with the new access token.
4. On refresh failure (`401`): clear the auth store, redirect to `/login`, surface "Session expired — please sign in again."
5. **Proactive refresh (optional):** schedule a refresh near `exp − 60s` (decode the JWT `exp` only for scheduling — never trust it for security) to avoid a user-visible 401 round-trip.

**Logout:** call `POST /auth/logout` with `{ refreshToken }` (optionally `{ allDevices: true }`) so the session is revoked **server-side** (best-effort — ignore failures, it always 204s), then clear the in-memory auth store and any cached `user`, and redirect to `/login`. Sending the refresh token matters: it kills that session family on the server, not just the local copy.

#### 4.2.3 RBAC the UI must reflect

Roles live on `OrgMembership.role`: `OWNER`, `ADMIN`, `MEMBER`. There is **no `@Roles` guard** — authorization is enforced imperatively inside services via `OrgsService.checkMembership(orgId, userId, requiredRoles?)`. Role-gated operations:

| Operation | Required role | Failure |
|---|---|---|
| `DELETE /projects/:projectId` | `OWNER` or `ADMIN` | `403` for `MEMBER` |
| `DELETE /templates/:templateId` | `OWNER` or `ADMIN` (org templates only; public templates cannot be deleted at all) | `403` |
| `DELETE /assets/:assetId` | `OWNER` or `ADMIN` | **`400` "Only admins can delete assets"** (QUIRK — **not** 403; a backend inconsistency) |

Today `OWNER` and `ADMIN` have identical effective privileges; there are no OWNER-only routes and **no member-management endpoints** (see §4.4). The caller's role for each org is returned on `GET /orgs` and `GET /orgs/:orgId` as a `role` field. **Use that `role` to gate destructive UI** (hide/disable Delete buttons for `MEMBER`), but still handle the `403`/`400` defensively — the server is the only real authority.

#### 4.2.4 Bearer header

Every protected call: `Authorization: Bearer <accessToken>`. Extracted server-side by `JwtStrategy` (`ExtractJwt.fromAuthHeaderAsBearerToken()`, `ignoreExpiration: false`). An expired/missing/invalid token → `401`.

---

### 4.3 UUID path params & validation conventions

Table conventions used below:
- **Auth** = the guard enforcing it (`JWT` = `JwtAuthGuard`; `Optional` = `OptionalJwtAuthGuard`; `none` = public).
- **Role** = service-enforced membership (any role unless noted).
- All request bodies are validated by the global pipe (§4.1.3) — send only the listed fields.
- Path params marked **(UUID)** run `ParseUUIDPipe`; a malformed value → `400` **before** the handler runs.

> **Seed-data UUID pitfall (applies to templates & assets):** the seeded public templates have human-readable IDs like `template-rc-low-pass-filter`, and the seeded demo org id is `demo-org-id` — **none of these are valid UUIDs**. Any `(UUID)` path param or `@IsUUID()` body/query field that receives one of them returns `400`. Always obtain real UUIDs from list endpoints (`GET /orgs`, `GET /templates`) rather than hard-coding seed ids.

---

### 4.4 Full endpoint table (every endpoint the frontend uses)

#### 4.4.1 Health — `health.controller.ts` (public, no auth)

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/health` | none | `200 { status: "ok", timestamp, service: "circuit-forge-api" }` |
| GET | `/health/ready` | none | `200 { status: "ok"\|"degraded", timestamp, service, checks: { database: { status, latencyMs, error? } } }` — **always HTTP 200**; read the `status` field for true health. |
| GET | `/health/live` | none | `200 { status: "ok", timestamp }` |

Use `/health/ready` for a non-blocking "backend up?" indicator. Do not gate the whole app on it — show a banner if `degraded`.

#### 4.4.2 Auth — `auth.controller.ts` (full bodies in §4.2.1)

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| POST | `/auth/register` | none | `RegisterDto` `{ email, password, name }` | `201 TokensResponse` |
| POST | `/auth/login` | none | `LoginDto` `{ email, password }` | `200 TokensResponse` |
| POST | `/auth/refresh` | none | `RefreshDto` `{ refreshToken }` | `200 TokensResponse` |
| POST | `/auth/logout` | none | `LogoutDto` `{ refreshToken?, allDevices? }` | `204` empty |

#### 4.4.3 Organizations — `orgs.controller.ts` (entire controller `JwtAuthGuard`)

| Method | Path | Auth | Role | Request | Response |
|---|---|---|---|---|---|
| GET | `/orgs` | JWT | membership | — | `200 [{ id, name, createdAt, updatedAt, role }]` (caller's orgs, each with their `role`) |
| POST | `/orgs` | JWT | creator → OWNER | `CreateOrgDto` `{ name: 1–100 }` | `201 { id, name, createdAt, updatedAt }` (no `role`, no members) |
| GET | `/orgs/:orgId` | JWT | membership | — | `200 { id, name, createdAt, updatedAt, role }`; `404` "…not found or access denied" if not a member |

> **QUIRK:** GET responses return org fields **plus a single `role` string** — they do **not** include member lists or nested membership objects. `POST /orgs` returns the raw org with **no** `role` field. Do not expect a `members` array anywhere.

#### 4.4.4 Projects — `projects.controller.ts` (entire controller `JwtAuthGuard`, no controller prefix)

| Method | Path | Auth | Role | Request | Response |
|---|---|---|---|---|---|
| GET | `/orgs/:orgId/projects` | JWT | membership | — | `200 Project[]` (ordered `updatedAt desc`) |
| POST | `/orgs/:orgId/projects` | JWT | membership | `CreateProjectDto` `{ name: 1–100, description?: <=2000 }` | `201 Project` |
| GET | `/projects/:projectId` | JWT | membership (of project's org) | — | `200 Project & { org: { id, name, createdAt, updatedAt } }` |
| PATCH | `/projects/:projectId` | JWT | membership | `UpdateProjectDto` `{ name?, description? }` | `200 Project` (updated) |
| DELETE | `/projects/:projectId` | JWT | **OWNER/ADMIN** | — | `200 { success: true }` (cascades versions) |

`Project` = `{ id, orgId, name, description, createdAt, updatedAt }`.

> **QUIRK:** `update` applies `name` only when truthy and `description` only when `!== undefined`. To clear a description send `description: ""` (empty string), not omitted/null. Note `:orgId`/`:projectId` here are **not** run through `ParseUUIDPipe` (no UUID validation on this controller), so a bad id reaches the service and returns `404`/`403`, not `400`.

#### 4.4.5 Versions — `versions.controller.ts` (entire controller `JwtAuthGuard`, no controller prefix)

| Method | Path | Auth | Role | Request | Response |
|---|---|---|---|---|---|
| GET | `/projects/:projectId/versions` | JWT | membership | — | `200 [{ id, versionNumber, createdAt, createdByUserId }]` — **list omits `circuitJson`/`uiJson`** (ordered `versionNumber desc`) |
| POST | `/projects/:projectId/versions` | JWT | membership | `CreateVersionDto` `{ circuitJson: object, uiJson: object }` | `201 ProjectVersion` (full row) |
| GET | `/versions/:versionId` | JWT | membership | — | `200 ProjectVersion & { project }` (full, incl. `circuitJson`/`uiJson`) |

`ProjectVersion` (full) = `{ id, projectId, versionNumber, createdByUserId, circuitJson, uiJson, createdAt }`. `versionNumber` auto-increments from 1.

> **QUIRK:** both `circuitJson` and `uiJson` are **required** on create and validated only as generic `@IsObject()` at the API edge — the API does **not** run eda-core's `CircuitJsonSchema` here. **The frontend MUST validate `circuitJson` against eda-core's Zod schema before POSTing** (and again when reading it back), so a drifted/invalid shape is caught client-side rather than silently persisted. (`uiJson` is your editor-layout blob — own its own schema.) The full data-model contract is in the **Shared Data Model & Types** section.

#### 4.4.6 Templates — `templates.controller.ts` (mixed guards; `:templateId` is **(UUID)**)

| Method | Path | Auth | Role | Request / Query | Response |
|---|---|---|---|---|---|
| GET | `/templates` | **Optional** JWT | membership **iff** `orgId` query given | query `ListTemplatesQueryDto` `{ orgId?(UUID), tag?, limit?(>=1, def 50), offset?(>=0, def 0) }` | `200 Template[]` |
| POST | `/templates` | JWT | membership **iff** `orgId` in body | `CreateTemplateDto` `{ orgId?(UUID), name, tags?: string[], circuitJson: object }` | `201 Template` |
| GET | `/templates/:templateId` (UUID) | **Optional** JWT | membership iff org-scoped | — | `200 Template` |
| DELETE | `/templates/:templateId` (UUID) | JWT | **OWNER/ADMIN** of org | — | `200 { deleted: true }` |

`Template` = `{ id, orgId, name, tags, circuitJson, createdAt, updatedAt }`. With no `orgId` query/body → only **public** templates (`orgId = null`) are returned. Anonymous request **with** an `orgId` → `403`. Public templates cannot be deleted (`403`).

> **QUIRK (seed data):** see the UUID pitfall in §4.3. `GET/DELETE /templates/:id` with a seed id (e.g. `template-rc-low-pass-filter`) → `400` (UUID parse failure). Listing public templates (`GET /templates`, no `orgId`) works and returns the seeded set. **Do not deep-link seeded templates by id — load them via the list.**

#### 4.4.7 Assets — `assets.controller.ts` (entire controller `JwtAuthGuard`; UUID path params)

| Method | Path | Auth | Role | Request / Query | Response |
|---|---|---|---|---|---|
| POST | `/orgs/:orgId/assets/models/presign` (UUID) | JWT | membership | `PresignUploadDto` `{ name, contentType, sizeBytes (1..10485760), sha256 }` | `201 { uploadUrl, s3Key }` |
| POST | `/orgs/:orgId/assets/models/commit` (UUID) | JWT | membership | `CommitAssetDto` `{ s3Key, name, contentType, sizeBytes (>=1), sha256 }` | `201 Asset` |
| GET | `/orgs/:orgId/assets/models` (UUID) | JWT | membership | query `type?` | `200 Asset[]` (ordered `createdAt desc`) |
| GET | `/assets/:assetId` (UUID) | JWT | membership | — | `200 Asset` |
| GET | `/assets/:assetId/download` (UUID) | JWT | membership | — | `200 { downloadUrl }` (presigned GET, 1h) |
| DELETE | `/assets/:assetId` (UUID) | JWT | **OWNER/ADMIN** | — | `200 { deleted: true }` (QUIRK: role failure = **400**; deletes DB row only, leaves S3 object) |

`Asset` = `{ id, orgId, type, name, contentType, sizeBytes, s3Key, sha256, createdAt }` (`type` = `'SPICE_MODEL'`). `sha256` is `@IsHash('sha256')` on both DTOs. The full upload flow is §4.4.8.

#### 4.4.8 Asset upload flow (presign → PUT → commit)

Three steps, all backed by S3/MinIO (`assets.service.ts`; bucket default `circuitforge`, endpoint default `http://localhost:9000`).

```ts
// 1) PRESIGN — POST /orgs/:orgId/assets/models/presign
//    Compute sha256 first. sizeBytes must be 1..10_485_760 (10 MB).
const { uploadUrl, s3Key } = await api.post(`/orgs/${orgId}/assets/models/presign`, {
  name: file.name, contentType: file.type, sizeBytes: file.size, sha256, // hex SHA-256 of bytes
});

// 2) UPLOAD — PUT the raw bytes DIRECTLY to S3/MinIO (NOT to the API). Send NO Authorization header to S3.
//    Content-Type MUST match what you presigned with (the presigned PUT is bound to ContentType + ContentLength).
await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });

// 3) COMMIT — POST /orgs/:orgId/assets/models/commit  → creates the Asset row (type SPICE_MODEL)
const asset = await api.post(`/orgs/${orgId}/assets/models/commit`, {
  s3Key, name: file.name, contentType: file.type, sizeBytes: file.size, sha256,
});
```

Rules & gotchas to encode:
- **`orgId` MUST be a real UUID** (path runs `ParseUUIDPipe`). The seeded `demo-org-id` is not a UUID → `400`. Use the real id from `GET /orgs`.
- **Compute `sha256` client-side** (`crypto.subtle.digest('SHA-256', bytes)` → hex) before presign and pass the **same** value to commit; both DTOs use `@IsHash('sha256')`.
- **10 MB cap** is enforced at presign (`sizeBytes <= 10485760`). Validate size client-side first and show a clear error.
- The **presigned PUT goes directly to S3** — do not route bytes through the API, and do not attach the Bearer token to the S3 PUT (it would break the signature). Surface upload progress from the PUT (XHR/`fetch` progress).
- **Commit verifies** the object exists (`HeadObject`; `400 "Asset not found in storage…"` if the PUT failed) and that `s3Key` starts with `orgs/<orgId>/` (`400` otherwise) — always commit with the exact `s3Key` returned by presign.
- **Download:** `GET /assets/:assetId/download` → `{ downloadUrl }` (presigned GET, 1h). Redirect/fetch the browser to it; don't proxy through the API.
- **Delete** removes the **DB row only** (S3 object intentionally retained), requires OWNER/ADMIN, and (QUIRK) returns **`400`** "Only admins can delete assets" for a `MEMBER`, not `403`.

#### 4.4.9 Simulation — `simulation.controller.ts` (entire controller `JwtAuthGuard`, no controller prefix)

Jobs are enqueued to a BullMQ queue (`simulations`) and executed by the separate `worker-sim` service (ngspice). The engine is always `NGSPICE`. There is **no WebSocket/SSE** — the client **submits then polls**. **Simulation is server-batch only; there is no client-side solver.**

| Method | Path | Auth | Role | Request | Response |
|---|---|---|---|---|---|
| POST | `/versions/:versionId/simulations` | JWT | membership (version → project → org) | `CreateSimulationDto` `{ analysisConfig: object, probes?: string[], modelAssetIds?: string[] }` | `201 { jobId }` |
| POST | `/simulations/quick` | JWT | membership (caller's **first** org) | `QuickSimulationDto` `{ netlist: string, analysisConfig?: object, modelAssetIds?: string[] }` | `201 { jobId }` (declared throttle 10/60 s) |
| GET | `/simulations/:jobId` | JWT | membership (job's org) | — | `200` status object (§4.4.9.2) |
| GET | `/simulations/:jobId/result` | JWT | membership (job's org) | — | `200` result object (§4.4.9.3) |

##### 4.4.9.1 Submit

**From a saved version** — `POST /versions/:versionId/simulations`:
```jsonc
// body
{ "analysisConfig": { "type": "tran", "stopTime": "1ms", "stepTime": "1us" },
  "probes": ["v(out)", "v(in)"],
  "modelAssetIds": [] } // optional: ids of uploaded SPICE-model Assets to .include for this run (§6.2 escape hatch)
// 201 → { "jobId": "<uuid>" }
```
The server resolves the version (membership-checked through project → org), runs `generateNetlist(circuitJson, analysisConfig, { probes })`, persists a `SimulationJob` (`status: QUEUED`, `orgId` from the version's project), and enqueues the job. `analysisType` is taken from `analysisConfig.type` (default `'tran'`). **`modelAssetIds?: string[]`** is an accepted (whitelisted) optional field on BOTH this and `/simulations/quick` — the worker `.include`s those uploaded model assets; omit it if unused. (The global pipe is `forbidNonWhitelisted`, so only documented fields are allowed — but this one IS allowed.)

**Quick sim from a raw netlist** — `POST /simulations/quick`:
```jsonc
// body (analysisConfig optional)
{ "netlist": "* RC\nV1 in 0 5\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 5m\n.control\nrun\nwrdata output.csv v(out)\n.endc\n.end",
  "analysisConfig": { "type": "tran", "stopTime": "5m" } }
// 201 → { "jobId": "<uuid>" }
```
The server uses the **raw netlist as-is** (no netlist generation) and the caller's **first** org (`404 "No organization found for user"` if none — shouldn't happen, since register creates a personal org). `probeNames` is sent as `[]` for quick sims (see the critical quirk in §4.4.9.4).

##### 4.4.9.2 Poll status — `GET /simulations/:jobId`
```jsonc
{ "id": "<uuid>",
  "status": "QUEUED"|"RUNNING"|"SUCCEEDED"|"FAILED"|"TIMED_OUT"|"CANCELED",
  "createdAt": "...", "startedAt": "..."|null, "finishedAt": "..."|null,
  "metrics": { "runtimeMs": 123, "outputSizeBytes": 4096, "pointsCount": 500 } | { "error": "..." } | null }
```
- Status enum: `QUEUED, RUNNING, SUCCEEDED, FAILED, CANCELED, TIMED_OUT`. The worker only ever sets `QUEUED → RUNNING → {SUCCEEDED|FAILED|TIMED_OUT}`. There is **no cancel endpoint**, so **`CANCELED` is in the enum but never produced** — handle it in your type/switch for completeness, but don't expect it.
- `metrics` is `null` until set and its shape varies by outcome. **`pointsCount` is always present in `metrics` once the job finishes** — prefer it over digging into `result.meta` (which is absent for S3-spilled results; see §4.4.9.3).

##### 4.4.9.3 Fetch result — `GET /simulations/:jobId/result`

If `status !== 'SUCCEEDED'`:
```jsonc
{ "id": "<uuid>", "status": "FAILED"|"TIMED_OUT"|..., "error": "<ngspice stderr or message>" }
```
If `status === 'SUCCEEDED'`:
```jsonc
{ "id": "<uuid>", "status": "SUCCEEDED",
  "result": {                       // eda-core SimulationResult { meta, series } — see Shared Data Model section
    "meta": { "analysisType": "tran", "xLabel": "time", "xUnit": "s", "pointsCount": 500 },
    "series": [ { "name": "v(out)", "points": [ { "x": 0, "y": 0 }, /* … */ ] } ]
  },
  "metrics": { "runtimeMs": 123, "outputSizeBytes": 4096, "pointsCount": 500 } }
```
Render waveforms directly from `result.series[].points` (`x` = time/freq/sweep per `meta.xLabel`/`meta.xUnit`; `y` = signal value). **Reuse the exact eda-core types** (`SimulationResult`, `DataSeries`, `DataPoint`, `ResultMeta`) — see the Shared Data Model & Types section. Do not redefine these. (`SimulationMetrics` is the one exception — it is **not** an eda-core export; declare it locally as `{ runtimeMs?: number; outputSizeBytes?: number; pointsCount?: number; error?: string }`, all optional since a failed run returns only `{ runtimeMs, error }`.)

> **S3 spill caveat (now handled by the API):** if a result's JSON exceeds ~1 MB the worker stores it in S3 (DB `resultJson` null, `resultS3Key` set). **`getResult` now re-hydrates from S3** (key `results/{jobId}/result.json`) when `resultJson` is null, so a `SUCCEEDED` result normally returns the full `{ meta, series }`. The response includes `result: null` **plus an `error: "Result data is currently unavailable from storage."` field _only_** when that S3 fetch/parse fails. Frontend: when `status === 'SUCCEEDED'` but `result == null` (or `result.series` is empty), show "Result temporarily unavailable" rather than crashing on `result.series.map`. `metrics.pointsCount` is still present in that case, so you can distinguish "unavailable" from a genuinely empty dataset.

##### 4.4.9.4 CRITICAL QUIRK — version sims without explicit probes return empty series

For `POST /versions/:versionId/simulations` **without a `probes` array**, the job can **SUCCEED** while the stored `series` is **empty** and `metrics.pointsCount === 0` (the worker parses with `probeNames: []`). **Frontend mitigation:** ALWAYS send an explicit, non-empty `probes` array on version sims (derive from the circuit's named nets, e.g. `["v(out)", "v(in)"]`). Quick sims work because the caller's netlist already contains its own `wrdata` line.

##### 4.4.9.5 Polling strategy → UI state machine

No push channel exists; poll `GET /simulations/:jobId` and only call `…/result` on a terminal status.

```ts
// Backend SIM_TIMEOUT_MS default is ~10s, so jobs are short.
const FAST_MS = 500;        // first ~5s: poll every 500ms (most jobs finish here)
const SLOW_MS = 2000;       // after 5s: poll every 2s
const MAX_WAIT_MS = 60_000; // hard client-side give-up
// On terminal status (SUCCEEDED|FAILED|TIMED_OUT|CANCELED): stop, fetch result if SUCCEEDED.
// On 429: back off (double the interval, cap ~5s). On poll 5xx/network: retry with backoff; don't drop the poll.
```

| Backend status | UI state | Notes |
|---|---|---|
| (`201 { jobId }`) | "Submitting…" → "Queued" | Optimistically show Queued once `jobId` returns. |
| `QUEUED` | "Queued" (spinner) | `startedAt` null. |
| `RUNNING` | "Running" (spinner/progress) | `startedAt` set. |
| `SUCCEEDED` | "Done" → fetch `/result`, render waveforms | If `result == null`/empty series → "No data / temporarily unavailable" (§4.4.9.3–.4). |
| `FAILED` | "Failed" + error panel | Show the `error` (ngspice stderr) in a collapsible details panel. |
| `TIMED_OUT` | "Timed out" | Suggest reducing `stopTime`/step count (worker timeout ~10s). |
| `CANCELED` | "Canceled" | Handle for completeness; not produced today. |
| never terminal by `MAX_WAIT_MS` | "Lost contact / still running" + retry | Don't spin forever. |

Use a single `useSimulationJob(jobId)` hook owning the poll loop and cleanup on unmount; key your data-fetching cache by `jobId` so navigating away and back resumes from current status. **Wrap the waveform renderer in an error boundary** so a malformed/huge result never blanks the app.

#### 4.4.10 AI generation — `generation.controller.ts` + `design.controller.ts` (`JwtAuthGuard`, Swagger tag `ai`)

These endpoints are **built and verified.** The LLM runs server-side via `apps/api/src/generation` + `packages/llm-core` (the official `@anthropic-ai/sdk` against an Anthropic-compatible gateway, model `claude-sonnet-4-6`), and **every** output is validated server-side with eda-core (`safeValidateCircuitJson` + `safeValidateAnalysisConfig`) with one automatic JSON-repair retry — surfaced to you as the `repaired` boolean. The frontend calls these like any other authenticated JSON endpoint and renders the result into the editor. **The frontend does not build these and never calls an LLM provider directly — there is no client-side AI config** (config is server-side only: `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`).

| Method | Path | Declared throttle | Request | Response |
|---|---|---|---|---|
| POST | `/generate-circuit` | 5 / 60 s | `{ prompt: 1–2000, constraints?: <=1000 }` | `{ circuit: CircuitJson, analysisConfig: AnalysisConfig, explanation?: string, repaired: boolean }` |
| POST | `/edit-circuit` | 5 / 60 s | `{ circuit: CircuitJson, instruction: 1–2000, analysisConfig?, constraints?: <=1000 }` | same shape as generate |
| POST | `/explain-circuit` | 10 / 60 s | `{ circuit: CircuitJson }` | `{ explanation: string }` |
| POST | `/design-circuit` | 3 / 60 s | `{ prompt: 1–2000, constraints?: <=1000, maxRounds?: 1–4 (def 2) }` | agentic shape below |

`/design-circuit` is the **headline flow** — agentic and long-running (~10–60 s): it generates a circuit, simulates it, and AI-fixes on failure across up to `maxRounds` rounds, returning a circuit **already verified by simulation** with the waveform inline.

```jsonc
// POST /design-circuit response
{
  "ok": true,
  "circuit": { /* CircuitJson */ },
  "analysisConfig": { /* AnalysisConfig */ },
  "explanation": "…",
  "rounds": 1,
  "history": [ { "round": 1, "status": "SUCCEEDED", "pointsCount": 500, "jobId": "<uuid>" } ],
  "simulation": { "jobId": "<uuid>", "status": "SUCCEEDED",
                  "metrics": { "pointsCount": 500, "runtimeMs": 123 },
                  "result": { /* SimulationResult { meta, series } | null */ } },
  "warning": "…"   // present only when ok=false (budget exhausted without a clean run)
}
```

Client notes:
- `circuit` from any of these endpoints is a **validated `CircuitJson`** — it loads straight into the editor and simulates with no transform. Still re-validate with eda-core's Zod on the way in (defense in depth), per the Shared Data Model section.
- `repaired === true` means the model's first output failed validation and was auto-repaired — optionally surface a subtle "AI output was auto-corrected" hint.
- For `/design-circuit`, render `simulation.result` directly as the verified waveform; if `ok === false`, show `warning` and the `history` (per-round `status`/`pointsCount`) so the user understands what the agent tried.
- AI errors map to specific status codes — see §4.5.1.

> **Documentation correctness:** these are **not** "to build" / "NEW" / "stub" work — they are live. The module is `apps/api/src/generation` (not `apps/api/src/ai`); the secret env var is `LLM_API_KEY` (not `ANTHROPIC_API_KEY`); the model is `claude-sonnet-4-6`.

#### 4.4.11 Component catalog (parts) — `parts.controller.ts` (`JwtAuthGuard`, Swagger tag `parts`)

A **built, verified** real-component catalog behind a supplier-agnostic provider (TME today; DigiKey/LCSC pluggable later). It powers a Flux-style **part picker**: search ~1.3M real manufacturer parts, filter by manufacturer/category facets, inspect parametrics + live pricing/stock + datasheet, and insert a real part as a `CircuitJson` component. Supplier credentials live in `TME_*` and are **server-side only** — the client never talks to the distributor.

| Method | Path | Throttle | Request (query) | Response |
|---|---|---|---|---|
| GET | `/parts/search` | 30 / 60 s | `q` (1–100, **required**), `manufacturerId?`, `categoryId?`, `page?` (1–1000) | `{ items: CatalogPart[], page, pageSize, total? }` |
| GET | `/parts/manufacturers` | 60 / 60 s | — | `ManufacturerRef[]` = `[{ id, name, productsCount }]` (sorted desc; ~1045) |
| GET | `/parts/categories` | 60 / 60 s | — | `CategoryNode[]` (tree: `{ id, parentId, name, productsCount, children[] }`) |
| GET | `/parts/:symbol` | 30 / 60 s | — | `CatalogPart` (full: `parameters`, `priceBreaks`, `stock`, `datasheetUrl`) |
| GET | `/parts/:symbol/component` | 30 / 60 s | — | `{ simulatable, component?, reason?, catalog }` (see below) |

`CatalogPart` = `{ mpn, manufacturer, description, category?, footprint?, photo?, datasheetUrl?, parameters: {name,value}[], priceBreaks: {amount,price,currency,special?}[], stock?, unitCost?, currency?, supplier, supplierId }`. In **search** results `parameters`/`priceBreaks` are empty (light rows); `GET /parts/:symbol` returns them populated. `supplierId` is the value to pass as `:symbol`.

`GET /parts/:symbol/component` maps a catalog part to a (partial) `CircuitJson` component:

```jsonc
{ "simulatable": true,
  "component": { "type": "resistor", "value": "10K", "footprint": "0603",
                 "mpn": "WR06X1002FTL", "manufacturer": "WALSIN",
                 "sourcing": { "supplier": "tme", "supplierId": "WR06X1002FTL",
                               "unitCost": 0.04737, "currency": "EUR", "stock": 77991, "datasheetUrl": "https://…" } },
  "reason": null,
  // modelDef is present for ACTIVE devices (transistors/op-amps): merge it into circuit.models on insert.
  // "modelDef": { "name": "QGENNPN", "device": "bjt", "body": ".model QGENNPN NPN(...)", "tier": "generic" },
  "catalog": { /* the full CatalogPart */ } }
```

- The returned `component` is **partial — no `id`/`designator`/`pins`**. The editor assigns those on insert: generate the next free designator (`R1`, `R2`, …, must end in a digit) and wire pins from `COMPONENT_PINS[type]`. The `value`/`model`/`footprint`/`mpn`/`manufacturer`/`sourcing` are ready to merge straight onto the new `Component` (see §6.1). **For a `'generic'` catalog part `COMPONENT_PINS['generic']` is `[]`** — its terminals come from the catalog part itself, so seed `pins` from the part's terminals (and the schematic symbol), not from `COMPONENT_PINS`.
- **`simulatable`:** passives (R/L/C), diodes/zeners **and active devices (bjt/mosfet/jfet)** now map to a simulatable component. For an active device the response also carries a **`modelDef`** (`ModelDef`) and the `component.model` is set to its name — on insert, **push `modelDef` into `circuit.models`** (dedup by name) so the part simulates (§6.1). Parts with no generic model yet (true ICs/MCUs/connectors) come back `simulatable:false` with a human-readable `reason` and a `type:'generic'` `component` (carrying `mpn`/`manufacturer`/`footprint`/`sourcing`) so they can still be **placed on the schematic/BOM** with a "BOM-only, not simulatable yet" badge. **For a catalog part, trust the response's `simulatable` boolean** — do NOT re-derive it by calling `isSimulatable()` on the returned partial: an active device whose model failed to resolve comes back `simulatable:false` but keeps its `bjt`/`mosfet`/`jfet` type (not `'generic'`), and `isSimulatable()` only checks `type !== 'generic'`, so it would disagree. (`isSimulatable(component)` is still the right test for components already in the editor document.)
- **UX — the Part Picker** (modal or editor side-panel): a debounced search box (respect the 30/60s throttle) + manufacturer & category facets (from the facet endpoints, each with product counts, à la Flux) → result list → detail pane (parameters, price tiers, stock, datasheet) → **Insert** calls `/parts/:symbol/component` and, when `simulatable`, drops the component into the editor with its sourcing metadata attached (feeds a future BOM view).
- Errors map like any other endpoint (§4.5): config missing → `503`, distributor rejected/unreachable → `502`, unknown symbol → `404`, bad query → `400`.

---

### 4.5 Error envelope & how the client surfaces errors

Errors use the standard NestJS `HttpException` shape. `message` is **either a string or an array of strings** (validation errors are arrays):
```jsonc
{ "statusCode": 400, "message": ["email must be an email", "password must be longer than or equal to 8 characters"], "error": "Bad Request" }
{ "statusCode": 401, "message": "Invalid credentials", "error": "Unauthorized" }
```

| Status | Cause | Client handling |
|---|---|---|
| `400` | Validation failure; malformed UUID path param; bad asset presign/commit; asset-delete by a `MEMBER` | Map array `message` → field-level form errors when possible; else a toast. **Normalize `message` (string OR string[])** before display. |
| `401` | Missing/invalid/expired access token; bad login; invalid refresh | On protected calls → single-flight silent refresh + retry (§4.2.2). On `/auth/login` → inline "Invalid credentials". On refresh failure → force re-login. |
| `403` | Not a member / insufficient role | "You don't have access to this organization/resource." Proactively hide the action via the `role` field. |
| `404` | Not found, or membership-gated "not found or access denied" | Show "Not found / no access." Don't leak existence vs. forbidden. |
| `409` | Email already registered (`/auth/register`) | Inline "An account with this email already exists." |
| `429` | Throttle (declared on quick-sim/AI routes; may activate at/near production) | Read `Retry-After`; back off and retry once; disable the triggering button briefly. |
| `429` + body `{ code: "QUOTA_EXCEEDED", metric, used, limit, period }` | A configured usage QUOTA was hit (sim enqueue / parts call / asset upload). Distinguish from throttling by the `code` field; `used ≥ limit` always holds. | Message depends on `metric`: **`sim_concurrent`** is an in-flight cap that clears in seconds — "Too many simulations running, try again shortly" (retry is fine). **`sim_jobs` / `sim_runtime_ms` / `parts_calls`** are monthly — "Monthly quota reached (used/limit)", resets next period, do not auto-retry. **`storage_bytes`** — "Storage limit reached" (`used` is the projected total incl. the rejected upload); clears when assets are deleted. Link all to the usage page. |
| `429` + body `{ code: "ACCOUNT_LOCKED", retryAfterSeconds, message }` | On `/auth/login`: too many consecutive failed logins (5) locked the account for 15 min. | Show the `message` and a "try again in ~`retryAfterSeconds`" hint; do NOT auto-retry. Distinct from a plain throttle 429 (which has no `code`) and from quota 429s. |
| `5xx` / network | Server/worker/infra down | Retry idempotent GETs with backoff; for mutations show a retry affordance, never silently swallow. |

#### 4.5.1 AI-specific error mapping

The AI services map provider/validation failures to distinct codes (`generation.service.ts`, `design.service.ts`):

| Status | Meaning | Client message |
|---|---|---|
| `400` | Input `circuit` failed eda-core validation (`edit`/`explain`/`design`) | "That circuit isn't valid — fix it before asking the AI." Show the validation issues from `message`. |
| `422` | The model produced output that failed validation even after the repair retry (`invalid_output`) | "The AI couldn't produce a valid circuit — try rephrasing." Offer a retry. |
| `503` | AI not configured (`LLM_API_KEY` unset) or provider config error | "AI features are temporarily unavailable." Disable AI entry points if this persists. |
| `502` | Upstream LLM/gateway failure | "The AI service had a problem — please try again." Retryable. |

#### 4.5.2 Client error contract (mandates)

- **One typed error normalizer** — `ApiError { status, code: error, messages: string[], raw }` produced by the fetch wrapper; UI never reads a raw `Response`.
- **Mount a toaster at the root** and route non-field errors to it (verify the toast provider is actually rendered — the previous app defined toasts but never mounted the provider).
- **React error boundaries** around the canvas, the waveform viewer, and each route segment so one failure doesn't blank the app.
- Add `aria-live="polite"` to the toast region and `role="alert"` to inline error text.

---

### 4.6 Concurrency, ordering & state hygiene

- **Versions are immutable, append-only.** Editing creates a new version via `POST …/versions`; `versionNumber` auto-increments. There is no PATCH-a-version route. After save, refetch the versions list (it omits the heavy JSON — cheap).
- **Single source of truth for server state.** Use one data-fetching layer (React Query/SWR) keyed by resource id; do not also mirror it in ad-hoc `useState`/duplicate store slices. Editor document state (the working `circuitJson` + `uiJson`) is client-owned until you POST a new version; server data (orgs/projects/versions list/sim status) is cache-owned.
- **No member-management endpoints exist** — do not build UI for inviting/removing members or transferring ownership; there are no routes for it.

---

### 4.7 Recommended API client: generate from OpenAPI, validate with eda-core Zod

The frontend is a **separate repo**, so it cannot import `apps/api` source. The recommended approach decouples the client from the backend's internals while keeping it type-safe:

1. **Generate the endpoint client/types from `/docs-json`** (OpenAPI codegen) so request/response types track the backend automatically.
2. **Get the rich domain types from a published `@circuit-forge/eda-core` package** (publish it to your registry, or vendor it) — its OpenAPI representation of `circuitJson`/`analysisConfig`/`result` is a generic `object`, so the precise `CircuitJson`/`AnalysisConfig`/`SimulationResult` types and their **Zod validators** must come from eda-core, not the generated schema.

**Generation (build step, committed output):**
```jsonc
// package.json
"scripts": {
  // Pull the live OpenAPI doc and generate types into src/api/generated.
  "api:types": "openapi-typescript http://localhost:3001/docs-json -o src/api/generated/schema.d.ts"
  // (Alternatively orval / openapi-zod-client to emit a typed client + Zod for the endpoint envelopes.)
}
```

**Layering (regardless of generator):**
1. **Generated types/schemas** in `src/api/generated/` — never hand-edit.
2. **Domain types + validators from `@circuit-forge/eda-core`** for `CircuitJson`, `ModelDef`, `Component`, `Net`, `ComponentType`, `AnalysisConfig`, `SimulationResult`, `DataSeries`, `DataPoint`, `ResultMeta`, plus `COMPONENT_PINS`, `SPICE_PREFIXES`, `COMPONENT_TYPES`, `isSimulatable`, and `validateCircuitJson`/`safeValidateCircuitJson` + `validateAnalysisConfig`/`safeValidateAnalysisConfig`. **Reuse the package; never re-declare or `as CircuitJson`.** (`SimulationMetrics` is NOT exported — declare it locally, all fields optional: `{ runtimeMs?, outputSizeBytes?, pointsCount?, error? }`.)
3. **One fetch wrapper** (`src/api/client.ts`) that: injects the base URL + Bearer header; serializes only declared body fields; performs single-flight silent refresh on `401` (§4.2.2); normalizes errors to `ApiError` (§4.5); handles `429` backoff; and **validates the load-bearing responses with eda-core Zod** (auth tokens, simulation status/result, version `circuitJson`, AI outputs) so a backend drift surfaces as a typed error rather than a runtime explosion deep in a component.

```ts
// Pattern: typed call + boundary validation (no `as`), single-flight refresh, normalized errors.
async function apiFetch<T>(path: string, init: RequestInit, schema?: ZodType<T>): Promise<T> {
  const res = await rawFetch(path, withAuth(init));   // attaches Bearer; on 401 → refresh+retry once
  if (!res.ok) throw await toApiError(res);            // { status, code, messages[] } — normalizes string|string[]
  if (res.status === 204) return undefined as T;       // logout etc.
  const json = await res.json();
  return schema ? schema.parse(json) : (json as T);    // validate the load-bearing responses
}

// Typed endpoint module example
export const simulationApi = {
  createFromVersion: (versionId: string, body: { analysisConfig: AnalysisConfig; probes: string[] /* always non-empty */ }) =>
    apiFetch(`/versions/${versionId}/simulations`, { method: 'POST', body: JSON.stringify(body) }, JobIdSchema),
  status: (jobId: string) => apiFetch(`/simulations/${jobId}`, { method: 'GET' }, SimStatusSchema),
  result: (jobId: string) => apiFetch(`/simulations/${jobId}/result`, { method: 'GET' }, SimResultSchema),
};
```

**Definition of done — the API layer (must all hold):**
- [ ] `src/api/generated/` is produced by `pnpm api:types` from `/docs-json` and is reproducible (regen yields no diff against the running server).
- [ ] Domain types/validators come from `@circuit-forge/eda-core`; **zero `as` assertions** in `src/api/**` (CI fails on new `as` in the API layer).
- [ ] Auth-token, simulation-status, simulation-result, AI-output, and version-`circuitJson` responses are validated at the boundary with eda-core Zod; a shape mismatch throws a typed `ApiError`, never a silent `undefined` deref.
- [ ] Single-flight `401 → refresh → retry` is unit-tested (concurrent 401s trigger exactly one `/auth/refresh`; refresh failure clears auth and redirects).
- [ ] `429` triggers backoff; quick-sim and AI buttons are disabled while a request is in flight.
- [ ] Access token lives only in memory (assert it never appears in `localStorage`); logout clears the store and tolerates the `204` empty body.
- [ ] Version sims are submitted with a **non-empty `probes`** array (guard in the simulation API module).
- [ ] No public-prefixed secret env var exists (CI grep guard); no LLM/provider call originates from the browser.
- [ ] The error normalizer handles `message: string | string[]`; the toaster is mounted at root; the canvas and waveform are wrapped in error boundaries with a11y attributes.


## 5. Simulation Job Lifecycle

Simulation is **server-batch only** — there is no client-side SPICE solver, no WebAssembly engine, and no streaming. The browser never runs ngspice and never touches S3. The contract is **submit → poll → fetch result**, all over plain HTTP/JSON against the API base URL (`http://localhost:3001`, see the Backend Integration Contract). Jobs are enqueued to a BullMQ queue (`simulations`) and executed by the `worker-sim` service (ngspice); the engine is always `NGSPICE`.

Because there is **no WebSocket or SSE channel**, the client owns the polling loop. This section gives you the exact request/response shapes, the `AnalysisConfig` discriminated union, the probes contract, the S3 re-hydration behavior, and a status → UI state machine.

> All four endpoints are JWT-guarded and org-scoped. See the Backend Integration Contract for token handling (Auth/JWT) and the org-membership (Resources & RBAC) rules these endpoints enforce.

Backend source of truth (read these if anything below is ambiguous):

| Concern | File |
|---------|------|
| Controller (routes) | `apps/api/src/simulation/simulation.controller.ts` |
| Service (job creation, status, result, S3 hydration) | `apps/api/src/simulation/simulation.service.ts` |
| Request DTOs | `apps/api/src/simulation/dto/index.ts` |
| Worker job processing + DB writes | `apps/worker-sim/src/simulation/processor.ts` |
| ngspice execution + output parsing | `apps/worker-sim/src/simulation/runner.ts` |
| `AnalysisConfig` types + Zod schemas | `packages/eda-core/src/types/analysis.ts`, `packages/eda-core/src/schemas/analysis.schema.ts` |
| `SimulationResult` types | `packages/eda-core/src/types/simulation.ts` |
| Worker reference doc | `docs/SIMULATION.md` |

---

### 5.1 Endpoints at a glance

| Method | Path | Throttle | Auth | Purpose |
|--------|------|----------|------|---------|
| `POST` | `/versions/:versionId/simulations` | default | JWT + org membership (via version → project → org) | Submit a sim for a saved circuit version. Server generates the netlist from `circuitJson`. |
| `POST` | `/simulations/quick` | **10 / 60s** | JWT + user's first org | Submit a sim from a raw SPICE netlist (no netlist generation). |
| `GET` | `/simulations/:jobId` | default | JWT + org membership (via job's `orgId`) | Poll job **status** + metrics. |
| `GET` | `/simulations/:jobId/result` | default | JWT + org membership (via job's `orgId`) | Fetch the terminal **result** (or error). |

There is **no cancel endpoint** and **no list endpoint** on this controller. Track `jobId`s you submit in client state if you need a history view.

---

### 5.2 Submit — version-based

`POST /versions/:versionId/simulations` (`simulation.controller.ts:19`)

The server resolves the version (membership-checked through project → org), runs `generateNetlist(circuitJson, analysisConfig, { probes })` from eda-core, persists a `SimulationJob` row with `status: QUEUED` and `engine: NGSPICE`, and enqueues `{ jobId, orgId, netlist, probeNames: probes ?? [], analysisType, analysisConfig }`. `analysisType` is `analysisConfig.type` (falling back to `'tran'`).

**Request body** (`CreateSimulationDto`):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `analysisConfig` | `AnalysisConfig` (object) | yes | Discriminated union on `type` — see §5.6. The DTO only enforces "is an object"; the **real validation** is eda-core's Zod schema, which you must run client-side before POST. |
| `probes` | `string[]` | optional | Probe signal strings, e.g. `["v(out)", "v(in)"]`. See §5.7 — **always send these explicitly for version sims.** |

```jsonc
// POST /versions/<versionId>/simulations
{
  "analysisConfig": { "type": "tran", "stopTime": "1ms", "stepTime": "1us" },
  "probes": ["v(out)", "v(in)"]
}
```

**Response** (`201`):

```jsonc
{ "jobId": "<uuid>" }
```

That is the *entire* submit response — just the job id. You then poll (§5.4).

---

### 5.3 Submit — quick / raw netlist

`POST /simulations/quick` (`simulation.controller.ts:34`) — **throttled to 10 requests / 60s per client.**

Use this for ad-hoc simulation of a netlist you already have (e.g. a netlist returned by the AI endpoints, or a hand-edited SPICE deck). The server uses the **raw netlist verbatim** (no netlist generation) and attributes the job to the **caller's first org** (`findAllForUser(userId)[0]`). If the user has no org it throws `404 "No organization found for user"` — this should not happen in practice because registration creates a personal org (see the Backend Integration Contract).

**Request body** (`QuickSimulationDto`):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `netlist` | `string` | yes | A complete SPICE netlist. To get back data it **must contain its own `wrdata output.csv <probes…>` line** inside a `.control` block (see §5.7). |
| `analysisConfig` | `AnalysisConfig` (object) | optional | Used only to set the enqueued `analysisType` (defaults to `'tran'`). The actual analysis is whatever the netlist's `.tran`/`.ac`/`.dc`/`.op` line says. |

```jsonc
// POST /simulations/quick
{
  "netlist": "* RC lowpass\nV1 in 0 5\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 5m\n.control\n  set filetype=ascii\n  run\n  wrdata output.csv v(out)\n  quit\n.endc\n.end",
  "analysisConfig": { "type": "tran", "stopTime": "5m" }
}
```

**Response** (`201`): `{ "jobId": "<uuid>" }` — identical shape to the version submit.

> Quick sims always enqueue with `probeNames: []`. The worker recovers probe names from the netlist's `wrdata` line (see §5.7), so a quick sim whose netlist includes a `wrdata` line returns populated series.

---

### 5.4 Poll status — `GET /simulations/:jobId`

`simulation.service.ts:118`. Returns the live job row (membership-checked). Poll this; do **not** poll `/result` while the job is non-terminal.

**Response shape:**

```jsonc
{
  "id": "<uuid>",
  "status": "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELED",
  "createdAt": "2026-05-30T12:00:00.000Z",
  "startedAt": "2026-05-30T12:00:01.000Z" | null,
  "finishedAt": "2026-05-30T12:00:02.000Z" | null,
  "metrics": { /* see below */ } | null
}
```

`metrics` is `null` until the worker finishes, and its **shape differs by outcome** (`processor.ts`):

| Outcome | `metrics` shape |
|---------|-----------------|
| Success | `{ runtimeMs: number, outputSizeBytes: number, pointsCount: number }` |
| Failure / timeout | `{ runtimeMs: number, error: string }` |
| Unhandled worker exception | `{ error: string }` |

Treat **every** `metrics` field as optional in your types. `pointsCount` is the authoritative point count for a successful run and is **always present in `metrics` on success** even when the full result payload is large enough to be spilled to S3 (§5.5).

**Status enum** — the Prisma `SimJobStatus` enum is:

```
QUEUED | RUNNING | SUCCEEDED | FAILED | CANCELED | TIMED_OUT
```

The worker only ever drives `QUEUED → RUNNING → { SUCCEEDED | FAILED | TIMED_OUT }`. **`CANCELED` exists in the enum but is never set today** (there is no cancel endpoint). Handle it in your type union and switch statement for completeness, but do not expect it to occur.

Terminal statuses: `SUCCEEDED`, `FAILED`, `TIMED_OUT`, `CANCELED`. Stop polling on any of these.

---

### 5.5 Fetch result — `GET /simulations/:jobId/result`

`simulation.service.ts:139`. Call this **only once the status is terminal**.

**If `status !== 'SUCCEEDED'`** (failed, timed out, still running, canceled) the response carries the error string (ngspice stderr / message, stored truncated to ≤ 10 000 chars) and **no `result`/`metrics` keys**:

```jsonc
{
  "id": "<uuid>",
  "status": "FAILED",
  "error": "ngspice exited with code 1"
}
```

**If `status === 'SUCCEEDED'`** the response carries the full eda-core `SimulationResult` inline as `result`, plus `metrics`:

```jsonc
{
  "id": "<uuid>",
  "status": "SUCCEEDED",
  "result": {
    "meta": {
      "analysisType": "tran",
      "xLabel": "time",
      "xUnit": "s",
      "pointsCount": 500,
      "simulationTime": 42        // optional, runtime in ms
    },
    "series": [
      { "name": "v(out)", "unit": "V", "points": [ { "x": 0, "y": 0 }, /* … */ ] }
    ]
  },
  "metrics": { "runtimeMs": 42, "outputSizeBytes": 4096, "pointsCount": 500 }
}
```

Render waveforms straight from `result.series[].points`: `x` is the independent axis (time / frequency / sweep value, labeled by `meta.xLabel` + `meta.xUnit`) and `y` is the signal value. The `SimulationResult` / `DataSeries` / `DataPoint` / `ResultMeta` types are exported from `@circuit-forge/eda-core` (`packages/eda-core/src/types/simulation.ts`) — **reuse them; do not redefine the domain model in the frontend.** (The Shared Data Model & Types section formalizes these; the waveform viewer is covered in the Screens section (§2.6) and the Frontend Architecture section.)

#### S3 re-hydration (large results)

When a parsed result's JSON exceeds **1 MiB**, the worker spills it to S3 instead of the DB: it uploads to key `results/{jobId}/result.json`, leaves the DB `resultJson` column `null`, and sets `resultS3Key` (`processor.ts` `handleSuccess`).

**`getResult` re-hydrates this transparently.** When `resultJson` is null but `resultS3Key` is set, the API fetches `results/{jobId}/result.json` from S3 server-side, `JSON.parse`s the `{ meta, series }` payload, and returns it as `result` — identical to a small inline result (`simulation.service.ts:158`–`176`, `fetchResultFromS3`). **The client always reads `result` inline from the API response and NEVER fetches S3 directly.** There is no signed URL, no client S3 access, no size branch to handle in the UI.

The **only** case where a `SUCCEEDED` job returns `result: null` is a storage fetch/parse failure (missing/corrupt S3 object, connectivity). The API surfaces this as `result: null` **plus** an `error` field so you can distinguish "temporarily unavailable" from a genuinely empty dataset:

```jsonc
{
  "id": "<uuid>",
  "status": "SUCCEEDED",
  "result": null,
  "metrics": { "runtimeMs": 42, "outputSizeBytes": 1500000, "pointsCount": 100000 },
  "error": "Result data is currently unavailable from storage."
}
```

**Client guard:** if `status === 'SUCCEEDED'` but `result == null`, show a "result temporarily unavailable, retry" message (the `error` string is present); if `result` is non-null but `result.series` is empty, show "no data to display" (see §5.7). In both cases never call `result.series.map(...)` without a null/empty guard, and wrap the waveform renderer in an error boundary so a malformed or oversized payload can never blank the app.

---

### 5.6 `AnalysisConfig` — the discriminated union

`analysisConfig` is a discriminated union on the `type` field. The canonical definitions are `packages/eda-core/src/types/analysis.ts` (TypeScript) and `packages/eda-core/src/schemas/analysis.schema.ts` (Zod, `AnalysisConfigSchema`). **Validate with eda-core's `safeValidateAnalysisConfig` before every submit** — the API DTO only checks `@IsObject()`, so a malformed config that passes the DTO will fail deeper (netlist generation or ngspice) and waste a round-trip.

#### `tran` — transient (time domain)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | `"tran"` | yes | discriminator |
| `stopTime` | SPICE value string | yes | e.g. `"10m"` = 10 ms |
| `stepTime` | SPICE value string | optional | e.g. `"1u"` = 1 µs. Defaults to `stopTime / 1000`. |
| `startTime` | SPICE value string | optional | default `"0"` |
| `maxStep` | SPICE value string | optional | maximum internal step |
| `uic` | `boolean` | optional | use initial conditions |

```jsonc
{ "type": "tran", "stopTime": "1ms", "stepTime": "1us" }
```

#### `ac` — small-signal frequency sweep

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | `"ac"` | yes | discriminator |
| `variation` | `"dec" \| "oct" \| "lin"` | yes | sweep spacing |
| `points` | `number` (int, 1..10000) | yes | points per decade/octave, or total for `lin` |
| `startFreq` | SPICE value string | yes | e.g. `"1"` (1 Hz) |
| `stopFreq` | SPICE value string | yes | e.g. `"1MEG"` (1 MHz) |

```jsonc
{ "type": "ac", "variation": "dec", "points": 20, "startFreq": "1", "stopFreq": "1MEG" }
```

#### `dc` — DC sweep

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | `"dc"` | yes | discriminator |
| `source` | string designator | yes | source to sweep, e.g. `"V1"`. Validated against `^[A-Z][A-Z0-9]*[0-9]+$` (case-insensitive). |
| `startVal` | SPICE value string | yes | sweep start |
| `stopVal` | SPICE value string | yes | sweep stop |
| `increment` | SPICE value string | yes | step size |

```jsonc
{ "type": "dc", "source": "V1", "startVal": "0", "stopVal": "5", "increment": "0.1" }
```

#### `op` — operating point (single DC solution)

| Field | Type | Required |
|-------|------|----------|
| `type` | `"op"` | yes (no other fields) |

```jsonc
{ "type": "op" }
```

**SPICE value strings** match the regex `^[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?\s*[a-zA-Z]*$` — a number with an optional unit suffix. Common suffixes: `f` (1e-15), `p` (1e-12), `n` (1e-9), `u` (1e-6), `m` (1e-3), `k` (1e3), `MEG` (1e6 — note `M` alone means **milli**, not mega), `G` (1e9), `T` (1e12). Send them as **strings**, never numbers.

TypeScript union (from eda-core — import it, do not retype):

```ts
type AnalysisConfig =
  | { type: 'tran'; stopTime: string; stepTime?: string; startTime?: string; maxStep?: string; uic?: boolean }
  | { type: 'ac'; variation: 'dec' | 'oct' | 'lin'; points: number; startFreq: string; stopFreq: string }
  | { type: 'dc'; source: string; startVal: string; stopVal: string; increment: string }
  | { type: 'op' };
```

---

### 5.7 Probes format and the "always send explicit probes" rule

A **probe** is a signal string telling the parser which CSV column to name. The eda-core `ProbeSchema` (`analysis.schema.ts:68`) validates the format `^[vi]\([a-zA-Z0-9_]+(?:,[a-zA-Z0-9_]+)?\)$` (case-insensitive):

- `v(node)` — node voltage, e.g. `v(out)`
- `v(a,b)` — differential voltage between two nodes
- `i(device)` — branch current through a device, e.g. `i(R1)`

Max 100 probes per request (`SimulationRequestSchema`). Validate each probe string client-side before POST.

#### How probes flow through the system

1. **Version sim:** the API passes your `probes` to `generateNetlist(circuit, config, { probes })`. eda-core emits a `wrdata output.csv <probes…>` line into the netlist. If you omit `probes`, eda-core falls back to **default probes** = every non-ground node voltage. Either way the enqueued payload carries `probeNames: probes ?? []`.
2. **Worker parse:** ngspice writes `output.csv`; the CSV parser builds one `series` per probe **name it is given**. The runner uses the enqueued `probeNames` if non-empty, otherwise it re-derives them from the netlist's `wrdata` line via `extractProbes(sanitizedNetlist)` (`runner.ts:121`–`123`). This fallback is what lets quick sims (always `probeNames: []`) and version sims-without-probes still produce named series, because the netlist always contains a `wrdata` line.

#### The empty-series quirk (know it, and side-step it)

Historically, a version sim submitted **without** an explicit `probes` array returned a `SUCCEEDED` job with an **empty `series` and `pointsCount === 0`**: the netlist used eda-core's default probes, but the worker parsed with the empty `probeNames` it was handed. The worker's `extractProbes` fallback (`runner.ts:121`) now mitigates this for the common case by recovering probe names from the netlist's `wrdata` line. Treat that as a safety net, **not** a contract:

> **Rule: always send a non-empty, explicit `probes` array on version sims.** Derive it from the circuit's named (non-ground) nets, e.g. `["v(out)", "v(in)"]`, or from whatever signals the user selected in the run panel.

Sending explicit probes gives you three guarantees the fallback does not:
- You control **exactly** which series come back (and their order), instead of "all node voltages."
- You can request **branch currents** (`i(R1)`) and **differential voltages** (`v(a,b)`), which default probes never include.
- You are insulated from any future change to the worker's parse path.

**Defensive UI:** regardless of the above, if a `SUCCEEDED` result comes back with `result.series.length === 0` (or `metrics.pointsCount === 0`), render an empty-state ("No probed signals — add probes and re-run") rather than a blank chart.

---

### 5.8 Polling strategy (TanStack Query, no push channel)

There is no WebSocket/SSE. Poll `GET /simulations/:jobId` with TanStack Query's `refetchInterval`, keyed by `jobId`, and **stop polling on a terminal status**. Fetch `/result` only after the status is terminal (and only render waveforms when it is `SUCCEEDED`).

Jobs are short — the worker's ngspice timeout (`SIM_TIMEOUT_MS`) defaults to **10 s**, so most jobs finish within a few seconds. Poll fast early, back off after, and cap total wait.

```ts
import { useQuery } from '@tanstack/react-query';

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELED']);

function useSimulationStatus(jobId: string | null) {
  return useQuery({
    queryKey: ['simulation', jobId, 'status'],
    enabled: !!jobId,
    queryFn: () => api.get(`/simulations/${jobId}`),     // returns the §5.4 shape
    // Poll while non-terminal; stop once terminal. `query.state.dataUpdatedAt`
    // lets you slow down after the first few seconds.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (!status || TERMINAL.has(status)) return false;  // stop polling
      const ageMs = Date.now() - query.state.dataUpdatedAt;
      return ageMs < 5_000 ? 500 : 2_000;                 // 500ms early, then 2s
    },
    refetchIntervalInBackground: false,
  });
}
```

Then fetch the result once terminal:

```ts
function useSimulationResult(jobId: string | null, status?: string) {
  return useQuery({
    queryKey: ['simulation', jobId, 'result'],
    enabled: !!jobId && !!status && TERMINAL.has(status),
    queryFn: () => api.get(`/simulations/${jobId}/result`),  // §5.5 shape
    staleTime: Infinity,   // results are immutable once terminal
  });
}
```

Operational guidance to encode:
- **Hard client cap.** Stop polling after a ceiling (e.g. 60 s) even if never terminal, and show "still running / lost contact — Check again". Do not spin forever.
- **429 on poll** (other endpoints are throttled; status itself is not, but be defensive): back off, doubling the interval up to ~5 s.
- **5xx / network on poll:** retry with backoff; do not drop the poll loop.
- **Resumability:** because the cache is keyed by `jobId`, navigating away and back resumes from the current status. Persist in-flight `jobId`s in editor state (see the Frontend Architecture section) so a remount can re-attach.

---

### 5.9 Status → UI state mapping

| Backend status | `metrics` / fields | UI state | Action |
|----------------|--------------------|----------|--------|
| _(submit returns `{ jobId }`)_ | — | "Submitting…" → "Queued" | Optimistically show Queued, start polling. |
| `QUEUED` | `startedAt: null`, `metrics: null` | "Queued" (spinner) | Keep polling (fast). |
| `RUNNING` | `startedAt` set | "Running" (spinner / progress) | Keep polling. |
| `SUCCEEDED` + `result` non-null, `series` non-empty | `metrics.pointsCount > 0` | "Done" → render waveforms | Fetch `/result`, plot `result.series`. |
| `SUCCEEDED` + `result` non-null, `series` empty | `metrics.pointsCount === 0` | "Completed — no data" | Prompt to add probes and re-run (§5.7). |
| `SUCCEEDED` + `result: null` + `error` | `metrics` present | "Result unavailable — retry" | S3 hydration failed (§5.5). Offer "Retry" (re-GET `/result`). |
| `FAILED` | `result.error` (ngspice stderr) | "Failed" + collapsible error panel | Show `error` verbatim. **A missing/uninstalled ngspice surfaces as `"ngspice exited with code 1"`, not ENOENT** — surface the raw string. |
| `TIMED_OUT` | `result.error` includes "timed out" | "Timed out" | Suggest reducing `stopTime` / step count (worker timeout default 10 s). |
| `CANCELED` | — | "Canceled" | Handle for completeness; not produced today. |
| _(no terminal status by client cap)_ | — | "Lost contact / still running" + Retry | Stop the loop; offer manual "Check again". |

---

### 5.10 Definition of done — simulation flow

- [ ] Submit uses `POST /versions/:versionId/simulations` for saved circuits and `POST /simulations/quick` for raw netlists; both read `jobId` from the `201` body.
- [ ] `analysisConfig` is validated with eda-core's `safeValidateAnalysisConfig` **before** every POST; the discriminated union (`tran`/`ac`/`dc`/`op`) is typed from `@circuit-forge/eda-core`, never hand-redefined.
- [ ] Every probe string is validated against eda-core's `ProbeSchema` before POST, and **version sims always send a non-empty explicit `probes` array** (§5.7).
- [ ] Polling uses TanStack Query `refetchInterval` keyed by `jobId`, stops on terminal status, and respects a hard client-side time cap.
- [ ] `/result` is fetched only on a terminal status; waveforms render only when `status === 'SUCCEEDED'` and `result?.series?.length` is truthy.
- [ ] The three `SUCCEEDED` sub-cases are handled distinctly: data present, empty series, and `result: null` + `error` (S3 unavailable).
- [ ] The client never references S3 keys, signed URLs, or storage endpoints — `result` is always read inline from the API.
- [ ] The waveform renderer is wrapped in an error boundary; null/empty `series` never throws.
- [ ] `CANCELED` is present in the status union/switch even though it is never emitted today.

> Cross-references: the Backend Integration Contract holds the API base URL + client, JWT auth, and the orgs/versions Resources & RBAC rules; the Shared Data Model & Types section defines the `SimulationResult` shape; the waveform viewer is described in the Screens section (§2.6) and the Frontend Architecture section, which also owns the editor/run-panel state. The AI **design** endpoint (`POST /design-circuit`, see the AI Circuit Generation section) returns a circuit **already verified by a simulation** with the waveform in `simulation.result` — that response is the same `SimulationResult` shape documented here, so the viewer is shared.


## 6. Shared Data Model & Types

This section is the **single source of truth** for every shape the editor reads, writes, persists, and exchanges with the backend. The non-negotiable rule: **the frontend MUST NOT define its own circuit / component / net / analysis / result model.** It consumes the existing `@circuit-forge/eda-core` types and Zod schemas verbatim. Everything below is derived from the actual source, not from prose:

- `packages/eda-core/src/types/circuit.ts` — interfaces + `COMPONENT_PINS`, `SPICE_PREFIXES`, `UiJson`
- `packages/eda-core/src/types/analysis.ts` — the `AnalysisConfig` union
- `packages/eda-core/src/types/simulation.ts` — `SimulationResult`, `DataSeries`, `DataPoint`
- `packages/eda-core/src/schemas/circuit.schema.ts` — Zod `CircuitJsonSchema`, `UiJsonSchema`, validators
- `packages/eda-core/src/schemas/analysis.schema.ts` — Zod `AnalysisConfigSchema`, `ProbeSchema`, `SimulationRequestSchema`
- `packages/eda-core/src/index.ts` — the exact public export surface

> **Why this section is load-bearing.** The previous app maintained its own `ComponentData` / `ConnectionData` model that drifted from the canonical one, duplicated the domain, and accumulated unsafe `as` casts to paper over the mismatch. The backend exhibits the same smell at one seam — `apps/api/src/simulation/simulation.service.ts` does `version.circuitJson as unknown as CircuitJson`. The greenfield frontend must make its in-memory editor document **structurally identical** to `CircuitJson` so no translation layer (and no casting) is ever needed. Cross-references: the persistence and simulation contracts live in the **Backend Integration Contract** (§4); the AI endpoints that emit `CircuitJson` live in **AI Circuit Generation** (§7).

---

### 6.1 The exact `CircuitJson` shape the editor must produce/consume

This is the **electrical** model only. No coordinates, no colors, no zoom — those live in `uiJson` (see §6.6). Field names, optionality, and constraints below are exactly as enforced by `CircuitJsonSchema` (`circuit.schema.ts:63`).

```ts
// packages/eda-core/src/types/circuit.ts
interface CircuitJson {
  version: string;          // MUST match /^\d+\.\d+$/  → use "1.0"
  components: Component[];   // array, max 1000
  nets: Net[];               // array, max 1000
  models?: ModelDef[];       // max 200; SPICE .model/.subckt bodies for active devices (see ModelDef below)
  metadata?: CircuitMetadata;
}

interface Component {
  id: string;               // 1..100 chars; unique within the circuit (editor-owned id)
  type: ComponentType;      // the full COMPONENT_TYPES enum (28 values incl. active + digital, see §6.2) — NOT just 7
  designator: string;       // /^[A-Z][A-Z0-9]*[0-9]+$/i — letter, then alnum, MUST END IN A DIGIT
                            //   valid: R1, V12, GND1   invalid: "R", "1R", "R1A"
  value?: string;           // max 100 chars; "10k", "100n", "DC 5", "SIN(0 1 1k)"
  model?: string;           // max 100 chars; model NAME for model-based devices (diode→omit→DDEFAULT, LED→"LEDRED"/"LEDYEL"/"LEDGRN"/"LEDBLU"; bjt→"QGENNPN"/"QGENPNP", mosfet→"MGENNMOS"/…, subckt→"OPAMPGEN"); the BODY lives in CircuitJson.models (generic bodies auto-attach server-side). Digital gates/dff set NO model.
  pins: PinConnection[];    // 1..64 entries — ORDER IS SIGNIFICANT for fixed-arity model devices (see §6.2)
  properties?: Record<string, unknown>; // accepted by schema; the netlist generator reads it ONLY for digital timing (gates: riseDelay/fallDelay/inputLoad; dff: clkDelay/setDelay/resetDelay/riseDelay/fallDelay/ic) — see §6.2
  // Optional real-part / catalog metadata (eda-core ≥1.1.0) — populated by GET /parts/:symbol/component:
  mpn?: string;             // max 100 — Manufacturer Part Number, e.g. "NE555P"
  manufacturer?: string;    // max 120 — e.g. "TEXAS INSTRUMENTS"
  footprint?: string;       // max 50 — package/case, e.g. "0603", "SOIC-8"
  sourcing?: ComponentSourcing; // { supplier, supplierId, unitCost?, currency?, stock?, datasheetUrl? }
}

interface PinConnection {
  pinId: string;            // 1..50 chars; one of COMPONENT_PINS[type]
  netId: string;            // 1..100 chars; MUST reference an existing Net.id
}

interface Net {
  id: string;               // 1..100 chars; the stable identity referenced by pins
  name: string;             // 1..100 chars; REQUIRED (display label, e.g. "VOUT")
  isGround?: boolean;       // true → this net becomes SPICE node '0'
}

interface CircuitMetadata {
  name?: string;            // max 200
  description?: string;     // max 2000
  author?: string;          // max 100
  createdAt?: string;       // ISO string (no format check)
  updatedAt?: string;
}

interface ModelDef {        // CircuitJson.models[] — the SPICE definitions active devices reference by name
  name: string;             // 1..100; matches a Component.model (e.g. "QGENNPN")
  device: 'bjt' | 'mosfet' | 'jfet' | 'diode' | 'subckt' | 'switch' | 'digital';
  body: string;             // 1..20000; literal SPICE: ".model QGENNPN NPN(...)" or ".subckt … .ends"
  tier?: 'manufacturer' | 'generic' | 'ideal';
  ports?: string[];         // subckt only: pinIds in the macromodel's port order
}
```

> **⚠️ `CircuitJson.models[]` — persist it or active-device circuits break.** When a transistor/op-amp/etc. is placed (from `GET /parts/:symbol/component` → `modelDef`, §4.4.11, or from the AI which auto-attaches models), its `Component.model` is just a NAME; the matching `.model`/`.subckt` **body** lives in `circuit.models`. If the editor types its document from a hand-copied interface that omits `models`, it will silently drop the array on save and every active-device circuit will fail to simulate (unresolved model). **Import the real `CircuitJson` + `ModelDef` types from `@circuit-forge/eda-core`** (both are exported) instead of re-declaring them, and round-trip `models` verbatim.

> **Real-part metadata (eda-core ≥1.1.0):** `mpn`, `manufacturer`, `footprint`, and `sourcing` are **optional and additive** — existing circuits validate unchanged. They are filled when a component is inserted from the catalog (`GET /parts/:symbol/component`, §4.4.11) and are for the BOM/sourcing UI + round-trip persistence; the netlist generator ignores them. `ComponentSourcing` = `{ supplier, supplierId, unitCost?, currency?, stock?, datasheetUrl? }` (Zod: `supplier`/`supplierId` required bounded strings, `unitCost`/`stock` nonnegative, `datasheetUrl` a URL). Exported from eda-core as the `ComponentSourcing` type + `ComponentSourcingSchema`.

**Exact bounds and patterns enforced by Zod** (do not relax these in the editor — mirror them so the user gets immediate feedback instead of a server 400):

| Field | Constraint (from `circuit.schema.ts`) |
|---|---|
| `CircuitJson.version` | regex `^\d+\.\d+$` — two dot-separated integer groups (use `"1.0"`) |
| `CircuitJson.components` | array, `max(1000)` |
| `CircuitJson.nets` | array, `max(1000)` |
| `Component.id` | string, `min(1) max(100)` |
| `Component.designator` | regex `^[A-Z][A-Z0-9]*[0-9]+$` (case-insensitive) — must end in a digit |
| `Component.value` | string, `max(100)`, optional |
| `Component.model` | string, `max(100)`, optional |
| `Component.pins` | array, `min(1) max(64)` |
| `PinConnection.pinId` | string, `min(1) max(50)` |
| `PinConnection.netId` | string, `min(1) max(100)` |
| `Net.id` | string, `min(1) max(100)` |
| `Net.name` | string, `min(1) max(100)` — **required** |
| `metadata.name / author` | `max(200)` / `max(100)`; `description` `max(2000)` |

**Connectivity model (critical):** there is **no flat node / terminal list**. A component connects to the circuit *only* through its `pins` array, and each pin references a `Net` by `netId`. Two pins are electrically connected **if and only if they reference the same `netId`**. The editor's "draw a wire" gesture therefore reduces to: *assign both endpoints' `PinConnection.netId` to the same net* (creating or merging a `Net` as needed). Wires are a UI affordance; the electrical truth is the shared `netId`.

#### Schema-valid example (RC low-pass filter)

```json
{
  "version": "1.0",
  "components": [
    {
      "id": "v1",
      "type": "voltage_source",
      "designator": "V1",
      "value": "DC 5",
      "pins": [
        { "pinId": "+", "netId": "vin" },
        { "pinId": "-", "netId": "gnd" }
      ]
    },
    {
      "id": "r1",
      "type": "resistor",
      "designator": "R1",
      "value": "1k",
      "pins": [
        { "pinId": "1", "netId": "vin" },
        { "pinId": "2", "netId": "vout" }
      ]
    },
    {
      "id": "c1",
      "type": "capacitor",
      "designator": "C1",
      "value": "100n",
      "pins": [
        { "pinId": "1", "netId": "vout" },
        { "pinId": "2", "netId": "gnd" }
      ]
    },
    {
      "id": "gnd1",
      "type": "ground",
      "designator": "GND1",
      "pins": [{ "pinId": "1", "netId": "gnd" }]
    }
  ],
  "nets": [
    { "id": "vin",  "name": "VIN" },
    { "id": "vout", "name": "VOUT" },
    { "id": "gnd",  "name": "GND", "isGround": true }
  ],
  "metadata": { "name": "RC Low-Pass Filter" }
}
```

**Client-side invariants to enforce (mirror the schema and the generator; do not rely solely on the server):**

- Every `PinConnection.netId` references an existing `Net.id` (no dangling pins). The netlist generator throws `Net not found: <netId> for component <designator>` otherwise.
- `Component.id` is unique within `components`; `Net.id` is unique within `nets`.
- `designator` passes `^[A-Z][A-Z0-9]*[0-9]+$`; auto-assign as `<prefix><n>` using the type's `SPICE_PREFIXES` letter (resistors → `R1`, `R2`, …). A designator like `GND` (no trailing digit) is **invalid** — use `GND1`.
- `value` should only contain characters that survive server-side `sanitizeValue` (`[a-zA-Z0-9 ()+\-.,_]`); strip anything else in the input control to avoid silent value mangling.
- At least one net has `isGround: true` (or a `ground` component is present), or ERC code `ERC001 NO_GROUND` fires server-side.

---

### 6.2 Supported component types & SPICE mapping

The full enum (`ComponentTypeSchema` and `ComponentType`, both derived from the single-source `COMPONENT_TYPES` tuple in `circuit.ts`) now covers the broad SPICE-simulatable device set in the table below **plus `'generic'`** — a catalog-only type (variable pins, no SPICE prefix) that the netlist generator skips. The editor's palette MUST be built from `ComponentType` — never a hand-maintained list — but should offer only the simulatable types (filter with `isSimulatable`); `'generic'` parts come from the part picker, not the palette. The SPICE prefix per type comes from `SPICE_PREFIXES`, the canonical pin names from `COMPONENT_PINS`, and the emitted line from the worker's `componentToSpice()` (which returns `null` for `'generic'`).

| `type` | SPICE prefix (`SPICE_PREFIXES`) | Canonical pins (`COMPONENT_PINS`) — order matters | Generated SPICE line | Notes |
|---|---|---|---|---|
| `resistor` | `R` | `['1','2']` | `R1 <n1> <n2> <value\|0>` | value defaults to `0` if absent |
| `capacitor` | `C` | `['1','2']` | `C1 <n1> <n2> <value\|0>` | value defaults to `0` |
| `inductor` | `L` | `['1','2']` | `L1 <n1> <n2> <value\|0>` | value defaults to `0` |
| `voltage_source` | `V` | `['+','-']` | `V1 <n+> <n-> <value\|'DC 0'>` | value defaults to `DC 0`; value carries the waveform: `DC 5`, `AC 1`, `SIN(0 1 1k)`, `PULSE(...)` |
| `current_source` | `I` | `['+','-']` | `I1 <n+> <n-> <value\|'DC 0'>` | value defaults to `DC 0` |
| `diode` | `D` | `['anode','cathode']` | `D1 <anode> <cathode> <model\|'DDEFAULT'>` | uses the built-in `DDEFAULT` model when `model` is absent. **LEDs** = a diode with a generic color model set by NAME: `LEDRED` (Vf≈1.9V), `LEDYEL` (≈2.0V), `LEDGRN` (≈2.4V), `LEDBLU` (≈3.0V) — bodies auto-injected like `QGENNPN`; a lit LED shows several mA through its series resistor |
| `zener` | `D` | `['anode','cathode']` | `D1 <anode> <cathode> <DZ…>` | breakdown `.model` **generated from `value`** (Zener voltage) |
| `bjt` | `Q` | `['c','b','e']` | `Q1 <c> <b> <e> <model>` | requires a model; generic `QGENNPN`/`QGENPNP` |
| `mosfet` | `M` | `['d','g','s','b']` | `M1 <d> <g> <s> <b> <model>` | requires a model; generic `MGENNMOS`/`MGENPMOS` |
| `jfet` | `J` | `['d','g','s']` | `J1 <d> <g> <s> <model>` | requires a model; generic `JGENNJF`/`JGENPJF` |
| `vcvs` | `E` | `['+','-','c+','c-']` | `E1 <+> <-> <c+> <c-> <gain>` | linear V-controlled **voltage** source; `value` = gain |
| `vccs` | `G` | `['+','-','c+','c-']` | `G1 <+> <-> <c+> <c-> <gm>` | V-controlled **current** source; `value` = transconductance |
| `bsource` | `B` | `['+','-']` | `B1 <+> <-> V=<expr>` (or `I=`) | arbitrary behavioral source; `v(netId)` in `value` is rewritten to SPICE nodes |
| `switch` | `S` | `['+','-','c+','c-']` | `S1 <+> <-> <c+> <c-> <model>` | V-controlled switch; generic `SWGEN` |
| `transformer` | *(composite)* | `['p+','p-','s+','s-']` | expands to `L…P`/`L…S` + `K…` | coupled windings; params in `properties`: `primaryInductance`, `secondaryInductance`, `coupling?` (default 0.999), `windingResistance?` (per-winding series DCR, default a tiny anti-singularity 1mΩ — set a realistic ohmic value on high-L/low-frequency transformers for faithful magnetizing settling) |
| `tline` | `T` | `['a+','a-','b+','b-']` | `T1 <a+> <a-> <b+> <b-> Z0=.. TD=..` | lossless line; params in `properties` (z0 + td, or f[+nl]) |
| `subckt` | `X` | `[]` (macromodel ports) | `X1 <ports…> <model>` | `.subckt` macromodel; pins bound by the model's `ports`. Generic: op-amp `OPAMPGEN`, thyristor/SCR `SCRGEN`, IGBT `IGBTGEN` |
| `ground` | `''` (none) | `['1']` | *(no line emitted)* | `componentToSpice` returns `null`; ground only marks a net as node `'0'` |

**Pin rule (must be respected by the editor's UI and any auto-wiring):** always keep each component's `pins` in `COMPONENT_PINS[type]` order and render/label terminals from `COMPONENT_PINS`, so the array order and the visible labels never diverge. Two-terminal passives, sources, `diode`/`zener` and `bsource` are emitted in the **authored array order** — for a `voltage_source` the first entry is `+`, the second `-`, which is electrically significant. The model-based devices (`bjt`/`mosfet`/`jfet`/`switch`), the controlled sources (`vcvs`/`vccs`), `transformer` and `tline` are bound **by `pinId`** in a canonical order, and a `subckt` by its model's declared `ports` — so authored order can't silently mis-wire those, but the correct pinIds must all be present (a missing required pin throws).

**The diode "omit model" rule (do not invent a model name).** Diodes are special: when the editor does not have a specific model for a diode, it MUST simply **omit the `model` field**. The backend's netlist generator injects the built-in `DDEFAULT` model automatically (`.model DDEFAULT D(...)`), so an emitted diode without a model still simulates. The same rule applies to AI output — the generation endpoints (see AI Circuit Generation, §7) deliberately omit `model` on diodes and eda-core fills in `DDEFAULT`. Never hard-code a fake model string client-side.

**Richer devices are now first-class (the earlier "transistors/op-amps don't exist" gap is closed).** `ComponentType` includes structured `bjt`, `mosfet`, `jfet`, `vcvs`, `vccs`, `bsource`, `switch`, `transformer`, `tline`, `zener`, and `subckt` (op-amp / IC macromodels). `componentToSpice` emits each of them and returns `null` (it no longer throws) for a non-emittable type. Model-based devices reference a model **by name**; eda-core ships a curated generic library (`QGENNPN`/`QGENPNP`, `MGENNMOS`/`MGENPMOS`, `JGENNJF`/`JGENPJF`, op-amp `OPAMPGEN`, switch `SWGEN`, thyristor/SCR `SCRGEN`, IGBT `IGBTGEN`, …) and generates parametric models (a `zener` from its breakdown voltage). So the editor can offer all of these as **structured** palette items.

**Digital logic is now first-class too.** `logic_and/or/nand/nor/xor/xnor/not/buffer` + `dff` simulate via ngspice XSPICE, and the generator auto-inserts analog↔digital bridges so logic and analog mix freely in one circuit; digital components carry **no** `model` (the host synthesizes a `CFD_*` model), gates are variable-arity (`in1..inN` + `out`), and a clock is just a `PULSE` `voltage_source`. **Timing is per-component and panel-editable via `properties`** (not `value`): gates take `riseDelay`/`fallDelay`/`inputLoad`; `dff` takes `clkDelay`/`setDelay`/`resetDelay`/`riseDelay`/`fallDelay`/`ic` — all optional SPICE value strings (e.g. `"2n"`). Delays default to `1n`; gate `inputLoad` defaults to `0.5p`; `ic` (dff initial Q) defaults to `0`. A properties panel that writes these into `properties` directly changes the simulation. See [docs/EDA_CORE.md §1.7.1](docs/EDA_CORE.md).

Still NOT structured — use the escape hatch: whole **logic ICs / MCUs / complex programmable parts** (source as catalog `generic` parts) and an **exact manufacturer model** for a specific MPN.

- **Escape hatch / long tail** — a user can upload a SPICE model `Asset` and attach it to a run via `modelAssetIds` (the worker `.include`s it; see §4), and any unsupported device can flow through the raw-netlist path (`POST /simulations/quick`). This bypasses structured editing/ERC but unblocks the long tail.

**Build the palette from `ComponentType` + `isSimulatable`** — never a hand-maintained list, and never invent device shapes locally (that recreates the exact drift this section exists to prevent). A `ComponentType` extension remains a coordinated eda-core + API + worker change.

---

### 6.3 `AnalysisConfig` — exact fields per type

`AnalysisConfig` is a **discriminated union on `type`** (`AnalysisConfigSchema = z.discriminatedUnion('type', [...])`, `analysis.schema.ts:58`). The editor's "simulation settings" form must produce exactly one of these four shapes. All numeric magnitudes are **SPICE value strings** validated by `SpiceValueSchema` (regex `^[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?\s*[a-zA-Z]*$`), e.g. `10m`, `1u`, `1MEG`, `1.5e-3`, `5V`.

> **SPICE multiplier reminder:** per SPICE convention, `M` / `m` mean **milli** (1e-3), not mega. Use `MEG` for 1e6. The editor's value controls should make this explicit to avoid a 10⁹× error.

```ts
// packages/eda-core/src/types/analysis.ts
type AnalysisConfig = TranAnalysis | AcAnalysis | DcAnalysis | OpAnalysis;
```

**Transient — `type: 'tran'`**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `stopTime` | SpiceValue string | **yes** | end time |
| `stepTime` | SpiceValue string | no | print/step time; if omitted the generator defaults to `stopTime / 1000` |
| `startTime` | SpiceValue string | no | default `0` |
| `maxStep` | SpiceValue string | no | max integration step |
| `uic` | boolean | no | appends `uic` (use initial conditions) |

**AC — `type: 'ac'`**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `variation` | `'dec' \| 'oct' \| 'lin'` | **yes** | sweep mode |
| `points` | integer, `> 0`, `<= 10000` | **yes** | points per decade/octave (or total for `lin`) |
| `startFreq` | SpiceValue string | **yes** | start frequency |
| `stopFreq` | SpiceValue string | **yes** | stop frequency |

**DC sweep — `type: 'dc'`**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `source` | string matching `^[A-Z][A-Z0-9]*[0-9]+$` (i) | **yes** | source **designator** to sweep, e.g. `V1` (must match an existing source designator in the circuit) |
| `startVal` | SpiceValue string | **yes** | sweep start |
| `stopVal` | SpiceValue string | **yes** | sweep stop |
| `increment` | SpiceValue string | **yes** | step size |

**Operating point — `type: 'op'`** — no fields beyond `type`.

> **Editor note:** `dc.source` is a *designator selector*, not a free-text box — populate it from the circuit's `voltage_source` / `current_source` designators so it always references a real device.

**Probe format (`ProbeSchema`, `analysis.schema.ts:68`):** regex `^[vi]\([a-zA-Z0-9_]+(?:,[a-zA-Z0-9_]+)?\)$` (case-insensitive). Valid: `v(out)`, `v(n1)`, `v(out,in)` (differential), `i(R1)`. Note the regex allows only `[a-zA-Z0-9_]` inside the parens — that matches the **sanitized** SPICE node name, not the raw `Net.id`/`name`. **ALWAYS send an explicit, non-empty `probes` array on a version sim** (derive node names locally from `getNodeNames(circuit)` and probe what the user pinned, or every non-ground net by default). Sending **no** probes is a documented quirk to AVOID, not a default: the worker's auto-probe is a safety net, **not** a contract (§4.4.9.4), so a no-probe run can SUCCEED with empty series / `pointsCount === 0`. Build probe strings with the server's sanitized node-name convention.

**`SimulationRequest` (what gets POSTed):** `SimulationRequestSchema = { analysisConfig: AnalysisConfig, probes?: Probe[] (<= 100), modelAssets?: UUID[] (<= 10) }`. Match this exactly. The REST DTO types `analysisConfig` loosely as `Record<string, unknown>`, so the frontend should validate against the strict eda-core schemas **before** sending — a bad config is then caught client-side with a precise message instead of failing deep in the worker. See the Backend Integration Contract (§4) for the submit/poll/result flow.

---

### 6.4 `SimulationResult` shape (what the waveform viewer renders)

Server results are parsed by eda-core into this exact shape (`types/simulation.ts`). The waveform chart and data table consume it directly — no remapping.

```ts
interface SimulationResult {
  meta: ResultMeta;
  series: DataSeries[];
}

interface ResultMeta {
  analysisType: string;     // "tran" | "ac" | "dc" | "op"
  xLabel: string;           // tran→"time", ac→"frequency", dc→"voltage", op→"point"
  xUnit?: string;           // tran→"s", ac→"Hz", dc→"V", op→(none)
  pointsCount: number;      // always present in metrics + meta
  simulationTime?: number;  // runtime in ms
}

interface DataSeries {
  name: string;             // probe/signal name, e.g. "v(nvout)"
  unit?: string;
  points: DataPoint[];
}

interface DataPoint { x: number; y: number; }
```

**Rendering contract:** one line/trace per `DataSeries`; X axis labeled from `meta.xLabel` / `meta.xUnit`; each point is `{ x, y }`. For `op` there is effectively a single point per series. **AC results carry a full Bode pair:** for every probe the result has its MAGNITUDE series (the probe name, e.g. `v(out)`, y = |H|) at the original index, plus one **`phase(<probe>)` series in DEGREES** appended after all magnitudes (e.g. series = `[v(out), v(fb), phase(v(out)), phase(v(fb))]`). Magnitude indexes are stable, so a viewer that ignores phase keeps working. For a Bode plot: top pane = 20·log10(magnitude) dB, bottom pane = the matching `phase(...)` series (split series by the `phase(` name prefix); use a log-frequency X axis. (Validated: an RC low-pass shows |H|=0.705 / −45.2° at fc, → −90° beyond.)

> **Where this comes from on the wire (see the Backend Integration Contract, §4, for full detail).** The backend stores results in `simulation_jobs.resultJson` (inline) or `simulation_jobs.resultS3Key` (large payloads spilled to S3 at key `results/{jobId}/result.json`). `GET /simulations/:jobId/result` **re-hydrates** an S3-spilled result automatically and returns it inline as `{ id, status, result, metrics }`. The client therefore just reads `result` — it never fetches S3 directly. `result` is `null` and an `error` field appears **only** when that S3 fetch/parse fails; `metrics.pointsCount` is always present, so it can confirm a run completed even when `result` is null.

---

### 6.5 Strong recommendation: make `CircuitJson` the single shared schema

**Mandate:** the editor's in-memory document type **is** `CircuitJson`. There is exactly one definition of components / nets / pins / analysis / results across backend, worker, and frontend, and it is `@circuit-forge/eda-core`. No parallel `ComponentData` / `ConnectionData`, no DTO that re-declares the fields, no per-prop casting.

This directly prevents the prior failure mode (a separate, drifting domain model that required hundreds of `as` casts to bridge) and removes the loose-typing already present at the seams (`analysisConfig: Record<string, unknown>`, `version.circuitJson as unknown as CircuitJson`).

**Implementation plan (pick the lowest-friction option that fits the frontend's build):**

1. **Preferred — consume `@circuit-forge/eda-core` directly as a workspace package.** It ships `dist/*.js` + `dist/*.d.ts` and depends only on `zod`. Add the frontend app to the **pnpm** workspace and depend on `"@circuit-forge/eda-core": "workspace:*"`. Import types **and** runtime validators/helpers from the package root: `CircuitJson`, `Component`, `Net`, `PinConnection`, `ComponentType`, `AnalysisConfig`, `SimulationResult`, `COMPONENT_PINS`, `SPICE_PREFIXES`, `CircuitJsonSchema`, `safeValidateCircuitJson`, `validateUiJson`, `AnalysisConfigSchema`, `ProbeSchema`, `SimulationRequestSchema`, `validateSimulationRequest`, `runErc` / `quickCheck`, and the unit utils (`parseSpiceValue` / `formatSpiceValue` / `normalizeValue`).
   - *Browser caveat:* parts of eda-core are Node/SPICE oriented (netlist generation, sanitization, include-path validation). Import the **types, Zod schemas, ERC, and unit utils**; do **not** run `generateNetlist` client-side — server-batch simulation owns netlist generation. Tree-shaking keeps the browser bundle to the validation/type surface.

2. **If the frontend cannot share the package at runtime** (bundling constraints): generate the frontend's types **from** eda-core rather than rewriting them (re-export the `.d.ts`, or a small codegen step over `schemas/*.ts`). The Zod schemas are the contract; never hand-author a second copy.

**Validation discipline at every boundary (the anti-`as`-cast rule):**

- When loading a `ProjectVersion` / `Template` from the API, run `safeValidateCircuitJson(circuitJson)` before putting it in the editor store. On failure surface a precise error — never cast `as CircuitJson`.
- Before submitting a simulation, run `validateSimulationRequest({ analysisConfig, probes })` and `quickCheck(circuit)` (ERC); block submit on errors.
- AI responses are already server-validated, but treat them like any other untrusted JSON: run `safeValidateCircuitJson` on `circuit` from `/generate-circuit` / `/edit-circuit` / `/design-circuit` before loading (see AI Circuit Generation, §7).
- Treat `CircuitJsonOutput` (the Zod **output** type) as the canonical store type so the compiler enforces the contract end-to-end.

---

### 6.6 Persistence shape: `ProjectVersion.circuitJson` + `uiJson`

From `apps/api/prisma/schema.prisma` and `docs/DATA_MODEL.md`, a `ProjectVersion` (table `project_versions`) is an **immutable snapshot** that stores the design as **two separate JSONB columns**:

| Column | Type | Holds |
|---|---|---|
| `circuitJson` | `JSONB` | the canonical **electrical** model — exactly the `CircuitJson` of §6.1 |
| `uiJson` | `JSONB` | the **layout / editor view state** — positions, viewport, wire routing (editor-owned) |

Other version fields: `id`, `projectId`, `versionNumber` (monotonic, unique per project via `@@unique([projectId, versionNumber])`), `createdByUserId`, `createdAt`. **`Template.circuitJson`** stores the same `CircuitJson` shape, but templates have **no `uiJson`** column — the editor must auto-lay-out a circuit instantiated from a template.

**`uiJson` is the editor-owned layout blob** — everything that is NOT electrical (`UiJson` / `UiJsonSchema` in eda-core):

```ts
// packages/eda-core/src/types/circuit.ts + schemas/circuit.schema.ts
interface UiJson {
  viewport?: { x: number; y: number; zoom: number };       // zoom MUST be > 0
  positions?: Record<string, {                             // keyed by Component.id
    x: number; y: number;
    rotation?: '0' | '90' | '180' | '270';                 // string-literal enum (see note)
  }>;
  wires?: Array<{ netId: string; points: { x: number; y: number }[] }>; // visual routing for a net
}
```

Rules this enforces for the editor:

- **Keep the two models strictly separated.** Moving / rotating / rerouting mutates only `uiJson`. Changing a connection, value, designator, or component set mutates `circuitJson`. The identity bridge between the two is `Component.id` (the key in `uiJson.positions`); a wire's bridge is `Net.id` (`uiJson.wires[].netId`).
- **`rotation` is a string enum** (`'0' | '90' | '180' | '270'`) in the Zod schema even though the `Position` TS comment phrases the values as numbers. The editor MUST store/serialize them as **strings** to pass `UiJsonSchema`.
- **`viewport.zoom` must be `> 0`** (`z.number().positive()`); guard against zero/negative zoom in pan-zoom logic.
- **Validate `uiJson` too** with `validateUiJson` on load; tolerate a missing/empty `uiJson` (every field is optional) by running auto-layout.
- **Persisting a version** sends both `circuitJson` and `uiJson` together so the snapshot is self-contained and re-openable with identical layout. Since versions are immutable, "Save" creates a new `versionNumber` (the API assigns it) — never mutate an existing version in place. See the Backend Integration Contract (§4) for the exact create-version request.

**Net effect:** the editor's store is two slices — `circuit: CircuitJson` (the API/simulation contract) and `ui: UiJson` (render state) — both typed by and validated against eda-core. There is no third, frontend-private model anywhere.

---

### 6.7 Definition of Done (this section's contract)

- [ ] No frontend-local circuit/component/net/analysis/result type exists; all are imported from `@circuit-forge/eda-core`.
- [ ] The editor document type is `CircuitJson` (Zod **output** type); there are zero `as CircuitJson` / `as unknown as` casts.
- [ ] Component palette is derived from `ComponentType`; pins are rendered/ordered from `COMPONENT_PINS[type]`.
- [ ] Diodes without a chosen model **omit** the `model` field (eda-core injects `DDEFAULT`).
- [ ] `designator` auto-assignment uses `SPICE_PREFIXES` and always ends in a digit (passes the regex).
- [ ] `circuitJson` is validated with `safeValidateCircuitJson` on every load (version/template/AI output) and before save.
- [ ] `uiJson` is validated with `validateUiJson` on load; `rotation` stored as string literals; `zoom > 0`.
- [ ] Simulation submissions are validated with `validateSimulationRequest` (+ `quickCheck` ERC) before POST.
- [ ] The waveform viewer renders `SimulationResult` (`meta` + `series[].points[{x,y}]`) directly, with X axis from `meta.xLabel`/`meta.xUnit`.
- [ ] Save persists `circuitJson` and `uiJson` together as a new immutable version.


## 7. AI Circuit Generation

> **STATUS — BUILT, WIRED, AND VERIFIED.** All four AI endpoints below already exist, are JWT-guarded, and are verified end-to-end. They live in `apps/api/src/generation/` (`GenerationController` + `DesignController`, Swagger tag `ai` — see `apps/api/src/generation/generation.controller.ts` and `apps/api/src/generation/design.controller.ts`). The generation logic lives in `packages/llm-core/src/index.ts`. **The frontend builds NONE of this.** It consumes these endpoints like any other authenticated JSON endpoint — you wire dialogs, hooks, previews, and error toasts against them. This section is the consumer contract plus the frontend UX spec.

AI generation turns a natural-language prompt (e.g. *"an RC low-pass filter with a 1 kHz cutoff driven by a 5 V source"*) into a **validated `CircuitJson`** that loads straight into the editor and is immediately simulatable through the existing pipeline (no transform). The headline endpoint — `POST /design-circuit` — goes one step further: it generates a circuit, **runs the simulation server-side, AI-fixes it on failure**, and returns a circuit that is **already proven to simulate**, with the waveform inline.

> **Cross-references.** Auth/token handling is the Backend Integration Contract (§4). The schematic editor that consumes inserted circuits is the Frontend Architecture & Stack section (§8). Simulation submit/poll/result is the Simulation Job Lifecycle (§5). The versions/projects API (for "Open as new version") is also in the Backend Integration Contract (§4). This section reuses `@circuit-forge/eda-core` validators defined in the Shared Data Model & Types (§6).

---

### 7.1 The four endpoints — full contracts

All four are `POST`, JWT-guarded (`Authorization: Bearer <accessToken>`), Swagger tag `ai`, on base URL `http://localhost:3001` with **no route prefix**. Request bodies are validated by the global `ValidationPipe` (`whitelist + forbidNonWhitelisted + transform`), so an unknown/misspelled field hard-fails with `400` rather than being silently dropped (this is your structural defense against MUST-AVOID bug #1 — see §7.5).

| Method / path | Throttle | Request body | Success (`200/201`) response |
|---|---|---|---|
| `POST /generate-circuit` | 5 / 60 s | `{ prompt: 1–2000, constraints?: ≤1000 }` | `{ circuit, analysisConfig, explanation?, repaired }` |
| `POST /edit-circuit` | 5 / 60 s | `{ circuit, instruction: 1–2000, analysisConfig?, constraints?: ≤1000 }` | `{ circuit, analysisConfig, explanation?, repaired }` |
| `POST /explain-circuit` | 10 / 60 s | `{ circuit }` | `{ explanation }` |
| `POST /design-circuit` | 3 / 60 s | `{ prompt: 1–2000, constraints?: ≤1000, maxRounds?: 1–4 (def 2) }` | `{ ok, circuit, analysisConfig, explanation?, rounds, history[], simulation, warning? }` |

Field-length bounds come straight from the DTOs in `apps/api/src/generation/dto/index.ts`. `circuit` in every request and response is a `@circuit-forge/eda-core` **`CircuitJson`**; `analysisConfig` is an **`AnalysisConfig`** (see the Shared Data Model & Types, §6). The throttle decorators are in the controllers (`@Throttle({ default: { limit, ttl } })`).

#### 7.1.1 `POST /generate-circuit` — text → circuit

The everyday "make me a circuit" call. Returns a validated circuit plus a suggested analysis to run.

Request:

```jsonc
{
  "prompt": "An RC low-pass filter with a 1 kHz cutoff driven by a 5V source",
  "constraints": "Use standard E12 resistor values; single 5V supply"  // optional, ≤1000 chars
}
```

Response (`GenerateCircuitResult`, see `packages/llm-core/src/index.ts:41`):

```jsonc
{
  "circuit": {
    "version": "1.0",
    "components": [
      { "id": "v1", "type": "voltage_source", "designator": "V1", "value": "SIN(0 5 1k)",
        "pins": [{ "pinId": "+", "netId": "in" }, { "pinId": "-", "netId": "gnd" }] },
      { "id": "r1", "type": "resistor", "designator": "R1", "value": "10k",
        "pins": [{ "pinId": "1", "netId": "in" }, { "pinId": "2", "netId": "out" }] },
      { "id": "c1", "type": "capacitor", "designator": "C1", "value": "16n",
        "pins": [{ "pinId": "1", "netId": "out" }, { "pinId": "2", "netId": "gnd" }] },
      { "id": "gnd1", "type": "ground", "designator": "GND1",
        "pins": [{ "pinId": "1", "netId": "gnd" }] }
    ],
    "nets": [
      { "id": "in", "name": "IN" },
      { "id": "out", "name": "OUT" },
      { "id": "gnd", "name": "GND", "isGround": true }
    ],
    "metadata": { "name": "RC low-pass", "description": "first-order LPF, ~1 kHz" }
  },
  "analysisConfig": { "type": "tran", "stopTime": "5m", "stepTime": "20u" },
  "explanation": "A first-order RC low-pass filter. R1 (10k) and C1 (16n) set the -3 dB point near 1 kHz...",
  "repaired": false
}
```

- `circuit` — validated `CircuitJson`. Loads into the editor and simulates with **no transform**.
- `analysisConfig` — a suggested analysis (most often `tran`). Feed it to the simulation flow (§5) as-is, or let the user override.
- `explanation?` — optional short prose summary for the preview pane. **Display-only** — it is AI text, not a verified calculation; never render it as authoritative numbers.
- `repaired` — `true` if the server needed one automatic JSON-repair retry to make the output valid (§7.2). Surface this subtly (e.g. an "auto-corrected" badge); it is **not** an error.

#### 7.1.2 `POST /edit-circuit` — circuit + instruction → modified circuit

Applies **only** the requested change(s) and preserves everything else. Same response shape as generate.

```jsonc
{
  "circuit": { /* a valid CircuitJson */ },
  "instruction": "Change R1 to 10k and add a 1uF output capacitor to ground",
  "analysisConfig": { "type": "tran", "stopTime": "5m", "stepTime": "20u" },  // optional — lets the model keep/adjust it
  "constraints": "keep the same source"                                       // optional, ≤1000 chars
}
```

Validation quirk worth knowing: the **input `circuit` is re-validated server-side** with `safeValidateCircuitJson` before the model is called (`generation.service.ts:93`). An invalid input circuit returns **`400`** with a human-readable list of issues (`Invalid circuit: nets.0.id: Required; ...`) — *not* `422`. So always validate the circuit client-side before POSTing (you have `safeValidateCircuitJson` from the Shared Data Model & Types, §6, already).

#### 7.1.3 `POST /explain-circuit` — circuit → prose

```jsonc
// request
{ "circuit": { /* a valid CircuitJson */ } }
// response
{ "explanation": "This is a first-order RC low-pass filter. V1 drives R1 into the C1/output node; the -3 dB cutoff is f = 1/(2*pi*R*C) ≈ 1 kHz ..." }
```

Returns plain prose only (no JSON, no circuit). Same input-circuit `400` rule as edit. Display-only text. Higher throttle (10 / 60 s) because it is the cheapest call.

#### 7.1.4 `POST /design-circuit` — the headline: a simulation-verified circuit in one call

This is the flagship of the AI feature and should be the **primary** AI entry point in the UI. One request runs a **closed agentic loop** server-side: generate → build netlist → simulate → if it fails or yields no data points, ask the AI to fix it → re-simulate, up to `maxRounds` (1–4, default 2). It returns a circuit that has **actually been simulated successfully**, with the waveform inline. The user gets a working, plotted design from a single prompt.

It is slow (~10–60 s) and expensive — hence the strict **3 / 60 s** throttle. Build the UI for a long-running call: a progress/"designing & verifying…" state, an in-flight guard, and a generous client timeout (≥ 90 s; the server itself polls each round up to 90 s, `design.service.ts:75`).

Request:

```jsonc
{
  "prompt": "A half-wave rectifier with a smoothing capacitor, 10V peak 50Hz AC input",
  "constraints": "use a single diode",   // optional, ≤1000 chars
  "maxRounds": 2                          // optional, 1–4, default 2 (clamped server-side)
}
```

Response (success path, `design.service.ts:94`):

```jsonc
{
  "ok": true,
  "circuit": { /* validated CircuitJson — simulation-verified */ },
  "analysisConfig": { "type": "tran", "stopTime": "40m", "stepTime": "50u" },
  "explanation": "Half-wave rectifier: D1 conducts on positive half-cycles, C1 smooths the output ...",
  "rounds": 1,
  "history": [
    { "round": 1, "status": "SUCCEEDED", "pointsCount": 801, "jobId": "..." }
  ],
  "simulation": {
    "jobId": "...",
    "status": "SUCCEEDED",
    "metrics": { "pointsCount": 801, /* ... */ },
    "result": { "meta": { "analysisType": "tran", "xLabel": "time", "xUnit": "s", "pointsCount": 801 },
                "series": [ { "name": "v(out)", "unit": "V", "points": [ /* {x,y}... */ ] } ] }
  }
}
```

Response (could-not-converge path, `design.service.ts:118`):

```jsonc
{
  "ok": false,
  "circuit": { /* best-effort CircuitJson — NOT verified */ },
  "analysisConfig": { /* ... */ },
  "explanation": "...",
  "rounds": 2,
  "history": [
    { "round": 1, "status": "FAILED", "pointsCount": 0, "jobId": "..." },
    { "round": 2, "status": "SUCCEEDED", "pointsCount": 0, "jobId": "..." }
  ],
  "simulation": { "status": "FAILED" },           // note: no jobId/result on this path
  "warning": "Could not produce a successful simulation within the round budget."
}
```

Response fields:

| Field | Type | Meaning |
|---|---|---|
| `ok` | `boolean` | `true` only if a round simulated with `status === 'SUCCEEDED'` **and** `pointsCount > 0`. Branch the UI on this — see below. |
| `circuit` | `CircuitJson` | The final design. Verified when `ok:true`; best-effort when `ok:false`. Always re-validate client-side before insert (see the Shared Data Model & Types, §6). |
| `analysisConfig` | `AnalysisConfig` | The analysis the loop used. Reuse it for any re-run. |
| `explanation?` | `string` | Display-only prose (may be the fix-round's explanation). |
| `rounds` | `number` | Rounds actually executed. |
| `history` | `{ round, status, pointsCount, jobId? }[]` | Per-round trace. `status` is a simulation status string (`SUCCEEDED`/`FAILED`/`TIMED_OUT`/`NETLIST_ERROR`). Render as a compact "design log" / timeline. |
| `simulation` | `{ jobId?, status, metrics?, result? }` | On `ok:true`: full result. On `ok:false`: only `{ status }` (no `jobId`, no `result`). |
| `warning?` | `string` | Present only on `ok:false`. Show as a non-fatal warning. |

Critical consumer notes:

- **`simulation.result` is the eda-core `SimulationResult` directly** (`{ meta, series }`) — already re-hydrated server-side, including large results that the worker spilled to S3 (§5 covers the >1 MB spill/re-hydration). It is *not* wrapped in `{ id, status, result }` like the standalone `GET /simulations/:jobId/result` envelope. Plot `simulation.result.series` straight away (§5's waveform plotter). It can be `null` in the rare case the result payload couldn't be fetched — then trust `simulation.metrics.pointsCount` to confirm it ran and re-fetch via `GET /simulations/:jobId/result` using `simulation.jobId` if you need the data.
- **Always handle `ok:false` gracefully.** Still show the `circuit` and `history`, surface `warning`, and offer the user the option to insert the best-effort circuit and iterate manually (or re-run with a higher `maxRounds`). Never treat `ok:false` as a hard failure/blank state.
- `pointsCount > 0` is part of the success test — a sim can "succeed" with zero data points (floating node / analysis that doesn't excite the circuit). On `ok:true` you are guaranteed a non-empty waveform.

---

### 7.2 How it works server-side (so you consume it correctly)

You do not build this, but understanding it explains the contract:

- **llm-core uses the official `@anthropic-ai/sdk`** (`packages/llm-core/src/index.ts:7`) pointed at a **configurable Anthropic-compatible gateway** (default `https://api.zentio.dev`; the SDK appends `/v1/messages`). The provider key is sent as `x-api-key`. A neutral `User-Agent` is set because the gateway's WAF blocks the SDK's default UA.
- **Every model output is validated server-side with eda-core** — `safeValidateCircuitJson` + `safeValidateAnalysisConfig` (`index.ts:236`, `:247`). The model is asked for `{ circuit, analysisConfig, explanation }` as strict JSON; the server strips code fences, parses, and validates.
- **One automatic JSON-repair retry** (`runWithRepair`, `index.ts:157`). If the first output fails validation, the server feeds the validator's issues back to the model once and re-validates. Success after that path sets **`repaired: true`**. If it *still* fails → the request returns **`422`** (it never returns junk). `analysisConfig` is best-effort: if the model's analysis is invalid, the server falls back to a default `{ type: 'tran', stopTime: '5m', stepTime: '50u' }` rather than failing.
- **Prompt-injection hardening.** The system prompt holds all rules and the output contract; user text is wrapped in delimiters (`<user_request>`, `<edit_instruction>`) and explicitly labeled as untrusted data the model must treat as a spec, never as instructions (`buildGenerateMessage`/`buildEditMessage`, `index.ts:267`). The output vocabulary is pinned to the eda-core schema (component `type` enum, `designator` regex, canonical pin names) so the model cannot invent unsupported parts.
- **Diodes omit `model`** — eda-core injects a default diode model (`DDEFAULT`); the system prompt forbids setting a custom model name. Don't add one on the client either.
- **Config is server-side only:** `LLM_API_KEY` (provider key — secret), `LLM_BASE_URL` (gateway), `LLM_MODEL` (`claude-sonnet-4-6`), optional `LLM_USER_AGENT`. If `LLM_API_KEY` is unset the endpoints return **`503`** (`generation.service.ts:78`).

---

### 7.3 Error codes — map every one to a toast

Errors are uniform across all four endpoints (`generation.service.ts#mapError:104`, `design.service.ts:128`).

| HTTP | When | Frontend handling |
|---|---|---|
| `400` | Invalid DTO (prompt empty / > 2000, constraints > 1000) **or** an invalid input `circuit` on edit/explain | "That request can't be used" — show the validation detail (usually length, or the `Invalid circuit: ...` issues). Prevent most of these client-side. |
| `401` | Missing/expired access token | Trigger the app's token-refresh/login flow (see the Backend Integration Contract, §4), then allow retry. Do not show a generic error. |
| `422` | Model output still invalid after the repair retry (`invalid_output`) | "The AI couldn't produce a valid circuit. Try rephrasing or adding detail." Optionally surface the server message. |
| `429` | Throttled (6th generate/edit, 11th explain, or 4th design within 60 s) | "You're generating too fast — try again in a minute." Disable submit with a short cooldown. |
| `502` | Upstream gateway error (`api_error`) — gateway down, network, non-auth provider error | "The AI service is temporarily unavailable." Offer a **Retry** action. |
| `503` | AI not configured (`LLM_API_KEY` unset) **or** provider auth failed (`config`) | "AI generation isn't available right now." Retry won't help if unconfigured; still offer Retry for transient cases. |

Treat network errors / client-timeouts like `502` (Retry). Read the status from the response, not the message text.

---

### 7.4 Secret boundary — the cardinal rule

**Zero AI configuration exists in the browser.** The only AI surface the frontend touches is the four authenticated endpoints above. There is no client-side Anthropic SDK, no gateway URL, no model name, and above all **no provider key** anywhere in the web app or its bundle.

- The **only** permitted client env var is the API base URL (`NEXT_PUBLIC_API_URL`). Never a `NEXT_PUBLIC_LLM_*`, never `LLM_API_KEY`, never any `NEXT_PUBLIC_` AI key.
- No direct `fetch` to `api.anthropic.com` / `api.zentio.dev` from the browser. All AI traffic goes through the NestJS API, which holds the key server-side and validates output with eda-core.
- This is a **build-blocking review failure** if violated: a `NEXT_PUBLIC_` AI key, a client-side `@anthropic-ai/sdk` import, or any direct gateway fetch from browser code. Add a CI guard (e.g. grep the bundle/source for `anthropic`, `zentio`, `LLM_API_KEY`) — it must find nothing in the web app.

---

### 7.5 MUST-AVOID bugs (carried from the old app)

These two AI bugs were the headline failures of the abandoned frontend. Mandate the opposite and add tests that fail if they recur.

**Bug #1 — Client/server field-name mismatch that silently dropped the prompt.**
The old client sent the prompt under one key while the handler read another, so the model got an empty prompt and returned a generic circuit while the UI looked like it "worked." **Mandate a single source of truth for the request shape.** The request keys are exactly **`prompt`** (generate/design), **`instruction`** (edit), **`circuit`** (edit/explain), and **`constraints`**/**`maxRounds`** — never `text`/`message`/`input`/`query` at any layer. Generate the client types from the live OpenAPI spec at `http://localhost:3001/docs-json` (or share a single hand-written type) so the key is compiler-enforced. The server's `ValidationPipe` runs `forbidNonWhitelisted: true`, so a *misspelled* field now hard-fails with `400` instead of silently dropping — back that with a contract test asserting the posted `prompt` reaches the request body. **No prompt → no silent success.**

**Bug #2 — Leaked client-side provider key.**
The old app shipped the provider key to the browser via a `NEXT_PUBLIC_`-prefixed env var, exposing it in the JS bundle. **Mandate:** the key exists exclusively as `LLM_API_KEY` in the API's server environment. The frontend has **zero** AI provider config; its only AI dependency is the authenticated endpoints. See §7.4 — this is the concrete instance of the brief-wide secret boundary.

---

### 7.6 Frontend UX

Suggested location: `src/features/ai/`.

```
src/features/ai/
  GenerateDesignDialog.tsx     # prompt textarea + example chips + constraints + mode toggle (Generate | Design)
  GeneratedCircuitPreview.tsx  # read-only schematic/summary + explanation (+ optional ERC) + waveform on Design
  DesignHistoryTrace.tsx       # per-round timeline for /design-circuit
  EditCircuitDialog.tsx        # instruction-driven edit of the current circuit
  ExplainPanel.tsx             # on-demand prose explanation of the current circuit
  useGenerateCircuit.ts        # useMutation -> POST /generate-circuit
  useDesignCircuit.ts          # useMutation -> POST /design-circuit (long timeout)
  useEditCircuit.ts            # useMutation -> POST /edit-circuit
  useExplainCircuit.ts         # useMutation -> POST /explain-circuit
  ai.api.ts                    # typed client; keys: prompt / instruction / circuit / constraints / maxRounds
  ai.types.ts                  # request/response types (generated from /docs-json or shared)
```

#### 7.6.1 The generate/design dialog

- A modal (`role="dialog"`, `aria-modal="true"`, labelled title via `aria-labelledby`, focus trapped on open and restored to the trigger on close, `Esc` closes) with a **multiline textarea** for the prompt.
- **Client-side length cap mirroring the DTO:** `maxLength={2000}`, a live char counter, submit disabled when empty or > 2000 — instant feedback instead of a round-trip `400`.
- A **mode toggle** between **Generate** (fast, `/generate-circuit`) and **Design** (slow, simulation-verified, `/design-circuit`). Make **Design the recommended default** for first-time users — a verified circuit + waveform is the wow moment. For Design, expose `maxRounds` (1–4, default 2) as an "effort" control.
- An **examples row** of one-click prompt chips that prefill the textarea — chosen to match the seeded templates so output is predictable and demoable, e.g. *"RC low-pass filter, 1 kHz cutoff"*, *"voltage divider, 12 V in, 5 V out"*, *"half-wave diode rectifier with smoothing cap"*, *"series RLC, find resonance"*. Chips are real `<button>`s.
- An **optional constraints field** — a single free-text string (`constraints`, ≤ 1000 chars), mirror the cap client-side. There is **no** structured `notes`/`maxComponents` object; it is one string.

#### 7.6.2 Loading state

- Use a typed `useMutation` (TanStack Query) per endpoint via `ai.api.ts`; the `Authorization` header reuses the app's access-token logic (see the Backend Integration Contract, §4).
- Submit disables the button, sets `aria-busy`, and shows a pending state. For **generate/edit/explain** it is a normal short spinner ("Designing your circuit…"). For **design** show a longer-running, reassuring state ("Designing and verifying by simulation — this can take up to a minute…"), ideally with the round count if you stream `history`-style progress (the call is single request/response, so progress is indeterminate; a step list of "generate → simulate → fix" reads well).
- **Enforce an in-flight guard** so double-submits are impossible — wasted calls burn the 3/60 s (design) and 5/60 s (generate) budgets fast.
- Set a generous client timeout for design (≥ 90 s).

#### 7.6.3 Preview the result

- On success, render `GeneratedCircuitPreview` from `response.circuit`: a read-only mini-schematic (reuse the editor's render components in read-only mode — same `CircuitJson` schema from the Shared Data Model & Types, §6) or, as a v1 fallback, a structured summary (component list with designators/values + net count), plus the `explanation` text.
- **Re-validate before insert.** Even though the server already validated, run `safeValidateCircuitJson(response.circuit)` from `@circuit-forge/eda-core` (see the Shared Data Model & Types, §6) before loading it into the editor — never cast `as CircuitJson`. On the rare failure, show a toast and do not insert.
- **Optionally run ERC** — `runErc(circuit)` from eda-core — on the preview to surface warnings (floating nets, missing ground) before insertion. Informational, not blocking.
- For **`/design-circuit`**: render the waveform from `simulation.result` immediately (reuse §5's plotter on `simulation.result.series`), show the `history` timeline (`DesignHistoryTrace`), and on `ok:false` show the `warning` plus the best-effort circuit with an option to re-run at higher `maxRounds`.
- Provide two committing actions:
  - **Insert into editor** — load `response.circuit` into the active editor document (default: a scratch/unsaved state so nothing is overwritten silently). Since `CircuitJson` carries no coordinates, generate a default `uiJson` auto-layout so components don't stack at the origin. Immediately editable and simulatable via §5.
  - **Open as new version** — `POST /projects/:projectId/versions` with `{ circuitJson: response.circuit, uiJson: <auto-laid-out positions> }` (see the Backend Integration Contract, §4), then navigate to the created version.

#### 7.6.4 Edit & explain entry points

- **Edit** (`EditCircuitDialog`): from the editor, an "AI edit" action sends the **current** circuit + an instruction string to `/edit-circuit`. Validate the current circuit client-side first (input-invalid → server `400`). On success, preview the diff/result and offer Insert (replace current) — re-validate first.
- **Explain** (`ExplainPanel`): an on-demand "Explain this circuit" action POSTs the current circuit to `/explain-circuit` and renders the prose read-only. Label it clearly as AI-generated, not a verified calculation.

#### 7.6.5 Quality bar

- **Error toasts mounted once at the app root.** The old app declared toasts but never mounted the container, so failures were silent. Mount the toast provider in the root layout on day one and add a smoke test that a toast actually appears. Map every status per §7.3.
- **Error boundary** around the AI feature subtree so a render crash in the preview never takes down the editor; show a recoverable fallback ("Something went wrong rendering the result" + Dismiss/Retry).
- **Memoization:** `React.memo` the preview/schematic and waveform so typing in an unrelated field doesn't re-render them (the old app had zero `React.memo`).
- **Typed end-to-end, zero unsafe casts** on the API boundary — request/response types generated from `/docs-json` or shared; the `prompt`/`instruction`/`circuit` keys are compiler-enforced.
- **Single state source:** request/response state lives in the mutation hooks (and the editor store for the inserted document) — no parallel dead store + local `useState` split-brain.
- **Tests:** dialog (states + a11y: role/aria-modal/labelled title/focus trap/Esc), each mutation hook (success + `400`/`401`/`422`/`429`/`502`/`503` → toast mapping), the **contract test** that the request body is keyed `prompt`/`instruction`, the `/design-circuit` `ok:false` branch, the re-validation step, and the toast-mounted smoke test. SDK/network are mocked — no real AI calls in CI.

#### 7.6.6 Acceptance criteria (definition of done)

- [ ] User can open the AI dialog, choose **Generate** or **Design**, pick an example chip or type a prompt (≤ 2000 chars, live counter), optionally add a `constraints` string, and submit; submit shows a loading state with `aria-busy` and an in-flight guard prevents double-submit.
- [ ] **`/design-circuit`** is the headline flow: on `ok:true` the preview shows the verified circuit **and** the waveform from `simulation.result.series`, plus the `history` timeline; on `ok:false` the `warning` + best-effort circuit are shown with a re-run option — never a blank failure state.
- [ ] On success, `response.circuit` is re-validated with `safeValidateCircuitJson` (no `as` cast); **Insert into editor** loads it (with an auto-layout `uiJson`) and it simulates with no transform; **Open as new version** creates a `ProjectVersion` and navigates to it.
- [ ] `repaired:true` is surfaced subtly (auto-corrected badge), not as an error.
- [ ] Edit and Explain entry points work against the current circuit, validating the input circuit client-side first.
- [ ] Every error class (`400/401/422/429/502/503`/network) produces a distinct, **mounted** toast; `429` applies a cooldown; `502/503`/network offer **Retry**; `401` routes through token refresh.
- [ ] An error boundary wraps the feature; a thrown render error shows a fallback, not a white screen.
- [ ] **No AI provider key or LLM SDK anywhere in the web app**; a CI grep for `anthropic`/`zentio`/`LLM_API_KEY`/`*_PUBLIC_*` AI vars in client source/bundle finds nothing; the only AI calls are the four authenticated endpoints.
- [ ] Preview and waveform are `React.memo`'d; feature has unit tests including the `prompt`/`instruction`-keyed contract test and the toast-mounted smoke test.


## 8. Frontend Architecture & Stack

This section is the build contract for the **greenfield** Circuit Forge web client. It is written for an AI coding agent: every recommendation is concrete, justified, and paired with acceptance criteria. The frontend is a fresh app that talks to the existing NestJS API (`http://localhost:3001`, Swagger UI at `/docs`, OpenAPI JSON at `/docs-json`, **no global route prefix**) and reuses the shared `@circuit-forge/eda-core` package. Do **not** port the old `circuit-simulator` code — only learn from its mistakes (see [Anti-Patterns to Avoid](#86-anti-patterns-to-avoid-non-negotiable)).

> **Ground-truth references** used throughout this section: `apps/api/src/**` (controllers/DTOs/guards), `packages/eda-core/src/types/circuit.ts` (`CircuitJson`, `UiJson`), `packages/eda-core/src/types/simulation.ts` (`SimulationResult`), `packages/eda-core/src/types/analysis.ts` (`AnalysisConfig`), `packages/eda-core/src/index.ts` (the public export surface), `tsconfig.base.json` (compiler bar), and `docs/{ARCHITECTURE,SECURITY,API,DATA_MODEL,EDA_CORE,SIMULATION}.md`.
>
> **The frontend is a SEPARATE project that you (the reader) set up yourself.** It is not built inside this monorepo. Where this section references repo paths (e.g. `apps/api/src/...`), those are the backend you consume, not files you create. Cross-references to other sections (Backend Integration Contract, Shared Data Model, AI Circuit Generation, Product Scope) use their names rather than reproducing their contracts here.

---

### 8.1 Recommended stack (with justification)

| Concern | Choice | Justification |
|---|---|---|
| **Framework** | **Next.js 16 (App Router) + React 19** (`next`, `react`, `react-dom`) | The product is an **auth-gated editor tool** hitting a *separate* NestJS API, so build it as a **client-first Next app**: a thin App-Router shell with every interactive tree marked `'use client'`. Do **not** fetch the Bearer-token API from Server Components / RSC — the browser calls the API directly with the in-memory access token (RSC running on the server has no access to it). What you *do* use from Next: file-based routing with nested layouts, `error.tsx` / `loading.tsx` / `not-found.tsx` per segment, route groups, first-class code-splitting, and a mature deploy story. Since there is nothing to SSR or SEO-index, you may set `output: 'export'` for a fully static bundle (serve from any CDN) **or** run the standard Node server — either is fine. Heavy browser-only libs (React Flow, uPlot) must be loaded with `next/dynamic` `{ ssr: false }` (or live strictly under a `'use client'` boundary that never renders on the server). React 19 ships with Next 16 — the named libs (React Flow/@xyflow, Radix/shadcn, uPlot, TanStack Query/Table, react-hook-form) support React 19; pin React-19-compatible versions. |
| **Language / compiler bar** | **TypeScript, `strict` + extras** | Mirror the backend's `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`. `noUncheckedIndexedAccess` is mandatory — it is what makes the `Map<id, …>` lookups (§8.5) safe by forcing `undefined` handling. **Zero `any`. Zero unchecked `as` casts.** All boundary data is *validated* with Zod, never asserted. |
| **Editor document state** | **Zustand** (single store; `immer` + `subscribeWithSelector` middleware) | The editor document (`CircuitJson` + `UiJson`) is **the single source of truth** and must support undo/redo, autosave, and fine-grained subscriptions. Zustand gives O(1) selector subscriptions (one glyph re-renders, not the tree) and ergonomic mutations via `immer`. **One store, no split-brain.** Local `useState` is allowed *only* for ephemeral, non-shared UI (a hover flag inside one component). |
| **Server cache / data fetching** | **TanStack Query v5** over a typed API client | Server cache (orgs, projects, versions, templates, assets, simulation status/result) is a *different* concern from the editor document — never store it in Zustand. TanStack Query handles caching, retries, background refetch, and is the right primitive for the **simulation polling loop** (`refetchInterval` driven by job status). Add `@tanstack/react-query-devtools` (dev only). |
| **Forms + validation** | **react-hook-form + Zod** (`@hookform/resolvers/zod`) | Every form (login, register, create org/project, save version, analysis config, AI prompt) uses RHF for uncontrolled-input performance and Zod for one schema shared by validation and TS types. Reuse `eda-core` Zod schemas (`AnalysisConfigSchema`, `SpiceValueSchema`, `ProbeSchema`) directly so a form cannot submit a payload the backend will `400`. |
| **UI kit** | **shadcn/ui + Radix primitives + TailwindCSS** | Radix gives **accessible-by-default** primitives (focus management, ARIA roles, keyboard nav) — directly fixing the old app's zero-accessibility audit. shadcn/ui is copy-in (no opaque dependency; fully ownable/themeable). Add `class-variance-authority` + `tailwind-merge` for variants. |
| **Schematic editor** | **React Flow / @xyflow** (MIT) as the default engine — render **custom SVG/HTML nodes** for the component symbols (one per palette `ComponentType`) and **custom orthogonal edges** for wires | See §8.4. React Flow is the FOSS standard for node/port editors: MIT-licensed (only Pro examples/support/attribution-removal are paid) and **DOM-based (HTML/SVG, not canvas)**, so it keeps native hit-testing/focus/ARIA — the accessibility the old audit punished — while giving pan/zoom, selection, viewport, and a `Handle` (port) API for free. You still own the *schematic* look: each component is a custom node (declarative SVG symbol; pins = uniquely-id'd `Handle`s seeded from `COMPONENT_PINS`) and each wire a custom **orthogonal/step** edge (React Flow's default edges are bezier — schematics want Manhattan routing). Note: a `Handle`'s `type` is source/target **direction**, not a datatype, so enforce pin compatibility with `isValidConnection`. Scale via memoized custom nodes + `onlyRenderVisibleElements` (no fixed node-count threshold is documented — profile your circuits). **Alternative (max control):** a from-scratch custom SVG renderer — full control of symbols/routing, but you build pan/zoom, selection, hit-testing and wiring yourself; the §8.4 guidance applies to either path. **Commercial alternative:** GoJS (paid) is the most EDA-proven option (official Circuit Designer sample, typed ports with link-count limits, built-in palette, orthogonal routing). **Open alternative:** maxGraph (framework-agnostic mxGraph successor, orthogonal routing, still pre-1.0). Canvas (react-konva/WebGL) is justified for *one* thing only: the waveform plot. |
| **Routing** | **Next.js App Router** (file-based, in `src/app/`) | Routes are folders with `page.tsx`; nested `layout.tsx` carry the app chrome + providers; `error.tsx` per segment gives per-route error boundaries for free; `loading.tsx` gives Suspense fallbacks. Guard the authenticated area with a client auth-check in the `(app)` route group's layout (redirect to `/login` when there is no token) — or Next middleware if you later move to cookie auth. Prefetch via the TanStack Query client inside client components/effects (not RSC loaders). |
| **Icons** | **lucide-react** | Pairs with shadcn/ui; tree-shakeable. **Every icon-only control gets an `aria-label`** (§8.4 a11y). |
| **Charts / waveforms** | **uPlot** via a thin React wrapper | The server returns `SimulationResult { meta, series: DataSeries[] }` with potentially tens of thousands of `{x,y}` points. uPlot is the fastest large-series time/frequency plotter — far lighter than Recharts/Chart.js at this volume. Map `meta.analysisType` → axis labels using `meta.xLabel` / `meta.xUnit` already provided by the parser (`tran`→time/s, `ac`→freq/Hz with log option, `dc`→sweep var, `op`→single point). |
| **Toasts** | **sonner** (or shadcn `useToast`) — **mounted once at the app root** | The old app declared toasts but never mounted the provider, so nothing fired. Mount `<Toaster />` in the root layout on day one (§8.4 resilience). |
| **Tables / lists** | **TanStack Table** (headless) for project/version/job/asset lists | Headless and accessible; integrates with TanStack Query data. |
| **Tooling** | Vitest, React Testing Library, Playwright, ESLint (`eslint-config-next` + typescript-eslint + `eslint-plugin-jsx-a11y`), Prettier, `@axe-core/playwright` | a11y lint and a bundle-size budget are enforced in CI (§8.4 testing). Vitest runs with jsdom + a React plugin alongside Next; Playwright runs against `next dev`/`next start` (or the exported static `out/`). |

#### Sharing types with the backend (this is a separate repo)

Because the frontend is a *separate* project, the domain contract must be shared rather than hand-transcribed. Use **two complementary mechanisms**:

1. **OpenAPI codegen for the HTTP surface.** Generate a typed client from the live spec at `http://localhost:3001/docs-json` (served by `SwaggerModule.setup('docs', …)`). Use **`openapi-typescript`** (emits `types` only) paired with **`openapi-fetch`** as the tiny typed runtime, or **`@hey-api/openapi-ts`** / **`orval`** for a full generated SDK (operationId-based functions, interceptors, `throwOnError`, TanStack Query + Zod plugins) if you want batteries-included client code. The request/response shapes in the **Backend Integration Contract** section are authoritative; do not hand-type endpoint field names — generate them so they stay in lockstep with the backend. Re-run codegen in CI and fail if the committed client drifts from the live spec.
2. **`@circuit-forge/eda-core` for the domain model + validators.** Import `CircuitJson`, `Component`, `Net`, `PinConnection`, `UiJson`, `Position`, `Wire`, `AnalysisConfig`, `SimulationResult`, `DataSeries`, `ErcResult`, plus the constants `COMPONENT_PINS` / `SPICE_PREFIXES`, the Zod schemas `CircuitJsonSchema` / `UiJsonSchema` / `AnalysisConfigSchema` / `SpiceValueSchema` / `ProbeSchema`, the `safeValidate*` helpers, and the pure functions `runErc` / `generateNetlist` / `parseNetlist` / `parseSpiceValue` — **all of these are exported from `packages/eda-core/src/index.ts`.** Do **not** redefine any of them in the frontend.

> **Why eda-core and not just OpenAPI?** The API validates `circuitJson` / `uiJson` only as generic `@IsObject()` at the HTTP edge (it does not run `CircuitJsonSchema` on the versions endpoints), so OpenAPI types alone do **not** capture the real circuit shape or its runtime constraints. eda-core is the canonical model *and* the runtime validator. The OpenAPI client types the envelopes; eda-core types and validates the payloads inside them. This split is deliberate.

**How to obtain eda-core in a separate repo:** it is published to **public npm** as `@circuit-forge/eda-core` — just `pnpm add @circuit-forge/eda-core` (no registry/token setup; it is a pure-TS library with no server deps — safe in a browser bundle). It uses Zod 3, which the frontend already depends on for forms; align the Zod major version to avoid duplicate copies. If the user instead chooses to co-locate the web app *inside* this monorepo as a new `apps/web` workspace (their call, not this brief's), they would use `"@circuit-forge/eda-core": "workspace:*"` — and the repo is **pnpm-only** (`npm install` cannot resolve `workspace:*`).

---

### 8.2 Suggested folder structure

```
circuit-forge-web/                     # standalone Next.js repo (App Router)
├─ next.config.ts                      # output: 'export' (static) OR default Node server
├─ tsconfig.json                       # mirror tsconfig.base.json's strict flags
├─ .env.local                          # NEXT_PUBLIC_API_URL=http://localhost:3001  (NO secrets — see §8.3)
├─ src/
│  ├─ app/                             # App Router — routes are folders with page.tsx
│  │  ├─ layout.tsx                    # root layout: <Providers/> + <Toaster/> mounted here
│  │  ├─ providers.tsx                 # 'use client': QueryClientProvider, theme, toast, auth
│  │  ├─ error.tsx  global-error.tsx   # top-level error boundaries (recoverable fallback)
│  │  ├─ (auth)/login/page.tsx   (auth)/register/page.tsx
│  │  ├─ (app)/layout.tsx              # 'use client' auth guard (redirect to /login if no token) + chrome
│  │  ├─ (app)/dashboard/page.tsx   (app)/projects/[projectId]/page.tsx
│  │  ├─ (app)/editor/[versionId]/page.tsx    # schematic editor shell (client)
│  │  ├─ (app)/editor/[versionId]/error.tsx   # dedicated boundary around the editor
│  │  └─ (app)/templates/page.tsx  (app)/assets/page.tsx  (app)/settings/page.tsx
│  ├─ lib/
│  │  ├─ env.ts                        # Zod-validated process.env.NEXT_PUBLIC_*; ONLY NEXT_PUBLIC_API_URL
│  │  ├─ api/
│  │  │  ├─ client.ts                  # fetch wrapper: base URL, auth header, refresh-on-401, typed errors
│  │  │  ├─ generated.ts               # openapi-typescript output (DO NOT edit by hand)
│  │  │  ├─ errors.ts                  # ApiError class + { statusCode, message, error } envelope parser
│  │  │  └─ endpoints/                 # one module per API area (auth, orgs, projects, versions,
│  │  │                                #   templates, assets, simulation, generation)
│  │  ├─ query/                        # TanStack Query hooks (useProjects, useVersion, useSimulationJob, …)
│  │  └─ utils/                        # geometry, snapping, id-gen (eda-core owns spice/units/erc)
│  ├─ store/
│  │  ├─ editorStore.ts                # Zustand: { circuit, ui, selection, dirty, lastSavedVersionId } + actions
│  │  ├─ authStore.ts                  # access token (in memory), refresh token, current user, active orgId
│  │  ├─ history.ts                    # undo/redo (command stack over circuit+ui)
│  │  └─ selectors.ts                  # memoized selectors + Map<id,…> indices
│  ├─ features/
│  │  ├─ editor/
│  │  │  ├─ Canvas.tsx                 # 'use client' React Flow root (next/dynamic ssr:false); nodes=symbols, edges=wires
│  │  │  ├─ ComponentGlyph.tsx         # React.memo per component (static geometry only)
│  │  │  ├─ symbols/                   # one pure SVG symbol per ComponentType (7 today)
│  │  │  ├─ Pin.tsx  Wire.tsx  Net.tsx
│  │  │  ├─ Palette.tsx                # palette (drag/click to place); driven by COMPONENT_PINS/SPICE_PREFIXES
│  │  │  ├─ SelectionLayer.tsx  MarqueeLayer.tsx
│  │  │  ├─ PropertiesPanel.tsx        # edit selected component value/model/designator (RHF + Zod)
│  │  │  └─ useEditorShortcuts.ts      # keyboard map
│  │  ├─ simulation/
│  │  │  ├─ AnalysisConfigForm.tsx     # tran/ac/dc/op (RHF + AnalysisConfigSchema)
│  │  │  ├─ ProbePicker.tsx            # choose probes  (ProbeSchema; mandate explicit probes)
│  │  │  ├─ useSimulationJob.ts        # submit → poll status → fetch result
│  │  │  └─ WaveformChart.tsx          # 'use client' uPlot wrapper (next/dynamic ssr:false) over SimulationResult.series
│  │  ├─ erc/ErcPanel.tsx              # runErc(circuit) from eda-core, client-side (pure, no secrets)
│  │  ├─ ai/                           # consumes the BUILT AI endpoints (see AI Circuit Generation section)
│  │  │  ├─ GenerateCircuitDialog.tsx  # prompt → POST /generate-circuit → validated CircuitJson
│  │  │  ├─ DesignCircuitFlow.tsx      # POST /design-circuit → circuit + ready-made waveform
│  │  │  └─ useGenerateCircuit.ts      # typed mutation hook
│  │  └─ io/ImportExport.tsx           # netlist import (parseNetlist) / export (generateNetlist) / CSV / JSON
│  ├─ components/ui/                    # shadcn/ui components (button, dialog, input, …)
│  └─ components/                       # app-level shared (ErrorBoundary, QueryBoundary, EmptyState, Spinner)
└─ tests/
   ├─ unit/                            # Vitest: store ops, geometry, hit-testing, api client, Zod boundaries
   └─ e2e/                             # Playwright: auth → build → save → simulate → render
```

---

### 8.3 Secrets boundary (hard rule — fixes the worst old-app bug)

> **SECURITY CARDINAL RULE.** No provider/LLM keys, JWT secrets, S3 credentials, or DB URLs ever appear in client code or the shipped bundle. The **only** permitted client-visible config is the API base URL. The old frontend's worst bug was leaking the LLM key via a `NEXT_PUBLIC_`-prefixed env var, exposing it in the JS bundle. In Next.js this is exactly the footgun to respect: **anything prefixed `NEXT_PUBLIC_` is inlined into the client bundle and is public** — never give a secret that prefix.

- **The only allowed `NEXT_PUBLIC_*` value is `NEXT_PUBLIC_API_URL`** (a public endpoint, `http://localhost:3001` in dev). Validate it at boot in `lib/env.ts` with a Zod schema and fail fast.
- **No model API keys, no `JWT_SECRET`, no S3 credentials, no `LLM_API_KEY` ever exist in the frontend.** AI configuration is **server-side only** (`LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL=claude-sonnet-4-6` live in the API environment). All AI generation goes through the authenticated backend endpoints in `apps/api/src/generation/` (`POST /generate-circuit`, `/edit-circuit`, `/explain-circuit`, `/design-circuit`) — the frontend **consumes** them and never imports an LLM SDK or fetches an LLM provider directly. Asset uploads use **backend-issued presigned URLs** (`POST /orgs/:orgId/assets/models/presign` → direct `PUT` to S3), so the client never sees S3 credentials.
- **CI grep guard (required, must block the build):** add a check that fails if any client source or build output contains a client secret. Concretely:

  ```bash
  # ci/check-no-secrets.sh — fail the build if a client secret leaks.
  set -euo pipefail
  # 1) Source: no NEXT_PUBLIC_* env that smells like a secret, and no LLM SDK / provider host.
  if grep -REn 'NEXT_PUBLIC_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)' src/; then
    echo "FAIL: a NEXT_PUBLIC_*_KEY/SECRET/TOKEN appeared in client source"; exit 1; fi
  if grep -REn '@anthropic-ai/sdk|api\.anthropic\.com|LLM_API_KEY|JWT_SECRET|S3_SECRET_KEY' src/; then
    echo "FAIL: an LLM SDK / provider host / server secret name appeared in client source"; exit 1; fi
  # 2) Build output: scan the emitted client bundle too (catches transitive leaks).
  if grep -REn 'api\.anthropic\.com|sk-ant-|AKIA[0-9A-Z]{16}' .next/ out/ 2>/dev/null; then
    echo "FAIL: a secret-shaped string appeared in the built bundle"; exit 1; fi
  echo "OK: no client secrets detected"
  ```

  **Acceptance:** a deliberately added fake secret (e.g. `NEXT_PUBLIC_LLM_KEY=sk-ant-xxx`) in code or env must fail CI.

**Token storage** (full strategy lives in the Backend Integration Contract section; the boundary rule here): the **access token stays in memory only** (the `authStore`, never `localStorage`) — it is a 15-minute, non-revocable bearer credential, so keeping it out of persistent storage removes the highest-value XSS target. The **refresh token** is kept in memory for v1 (a same-origin BFF cookie is the v2 upgrade); avoid `localStorage` for it because it is a 7-day, server-non-revocable credential. The API client (`lib/api/client.ts`) attaches `Authorization: Bearer <accessToken>` and, on `401`, transparently calls `POST /auth/refresh` once (single-flight), rotates **both** tokens, retries the original request once, and on failure clears the store and redirects to login. `POST /auth/logout` is a server no-op (no blocklist) — the client simply discards tokens.

---

### 8.4 Editor approach, performance, state, a11y, resilience, testing

#### The schematic editor

The editor document = **`CircuitJson` (electrical truth) + `UiJson` (layout)**, exactly the two JSON blobs persisted on `ProjectVersion.circuitJson` / `uiJson`. Connectivity lives **only** in `Component.pins[].netId` → `Net.id`; there is no flat node list. Layout (`UiJson.positions: Record<id,{x,y,rotation?}>`, `UiJson.viewport`, `UiJson.wires`) is kept **separate** from `CircuitJson` so geometry edits never invalidate electrical state and vice-versa.

**Rendering engine (see §8.1).** Default to **React Flow / @xyflow**: each component is a custom node (an SVG symbol + uniquely-id'd `Handle`s for pins), each wire a custom **orthogonal** edge, and React Flow supplies the pan/zoom, grid, selection, viewport, and connection plumbing that the bullets below would otherwise require you to build by hand. If you instead choose the **from-scratch SVG renderer** (the max-control alternative), implement the pan/zoom, hit-testing, and wiring bullets below yourself. **Either way the rest is identical** — the connectivity model, ERC, undo/redo, and import/export operate on `CircuitJson`/`UiJson`, not on the renderer — so map React Flow's node/edge changes back onto `UiJson.positions`/`UiJson.wires` and the pin→net model below.

- **Palette & placement.** The v1 palette MAY expose a curated subset of `ComponentType`s (e.g. resistor, capacitor, inductor, voltage_source, current_source, diode, ground); the engine supports many more — active devices, `subckt` macromodels, and the full digital family (see §6.2). Drive the type list, pin names/counts from `COMPONENT_PINS`, and designator prefixes from `SPICE_PREFIXES` — **never hardcode a type or pin list.** On placement: generate a unique `Component.id`, a designator using the type's prefix + next free integer (`R1`, `C2`, …) that satisfies the regex `^[A-Z][A-Z0-9]*[0-9]+$` (**must end in a digit**), seed `pins[]` from `COMPONENT_PINS[type]`, and record `UiJson.positions[id] = { x, y, rotation: '0' }` snapped to grid.
- **Wiring / nets.** Click a pin → drag → release on another pin: create a new `Net` if neither pin has one; otherwise merge onto the existing `netId`. Wire polylines live in `UiJson.wires[] = { netId, points: {x,y}[] }`. Net `name` is required by the schema; auto-generate readable names (`N1`, `VOUT`) and let users rename. A `ground` component maps its net to SPICE node `0`.
- **Live ERC.** Run `runErc(circuit)` from eda-core **client-side** (a pure function, no secrets) and surface `ErcIssue[]` in the ERC panel. Render issues GENERICALLY from `{ code, severity, message, relatedIds }` — do not hardcode the code list (it grows). `error`-severity issues (e.g. `NO_GROUND`, `MISSING_VALUE`, `VOLTAGE_SOURCE_SHORT`, and the digital errors `DIGITAL_PIN_SHAPE`/`FLOATING_DIGITAL_INPUT`/`DIGITAL_BUS_CONTENTION`/`MIXED_DRIVER_CONFLICT`) block simulation; warnings/infos (e.g. `MIXED_LOGIC_LEVELS`, `UNRESOLVED_MODEL`) are advisory. `ErcCode`/`ERC_DESCRIPTIONS`/`ERC_SEVERITIES` are exported from eda-core if you want labels. Highlight `relatedIds` on the canvas.
- **Correct hit-testing (fixes the old origin-only bug).** Hit-testing must use the full rendered **bounding box / geometry**, not the component origin point. With SVG this is mostly free: rely on the rendered glyph's pointer target plus a computed bbox (component bounds, pin radius, wire-segment distance) for marquee selection. Support single-click, shift-click (add/remove), and rubber-band selection that intersects each element's **bbox**. Selection state lives in the store as a `Set<id>`, separate from geometry, so highlighting one element does not re-render others.
- **Pan/zoom, grid, snap.** One SVG root `<g transform="translate(x,y) scale(zoom)">` driven by `UiJson.viewport` (`{ x, y, zoom>0 }`); wheel = zoom-to-cursor, space/middle-drag = pan, clamp zoom. Configurable grid (default 10 units) rendered as a single SVG `<pattern>` (not per-cell); all placements/moves/vertices snap to grid.
- **Undo/redo & copy/paste.** A command/transaction stack in `store/history.ts` over `{ circuit, ui }`; every mutation pushes one undoable entry; coalesce rapid drags. Copy serializes selected components + internal nets + positions; paste deep-clones with **fresh ids, fresh net ids, regenerated designators** offset by a grid step (never duplicate an existing id/designator).
- **Import/export.** Reuse eda-core client-side: `parseNetlist(text)` → `{ circuit, analysis?, warnings, errors }` (synthesize a `UiJson` auto-layout), and `generateNetlist(circuit, analysisConfig, { probes, title })` for `.cir` export. Native JSON export/import is a direct `{ circuitJson, uiJson }` serialize, validated with `safeValidateCircuitJson` / `validateUiJson` on import. Results CSV is a client-side serialize of `SimulationResult.series`. (Detailed in the Product Scope import/export tables.)

#### Performance mandate (counters the old audit directly)

The old app had **0 `React.memo`** (full-tree re-render on every change), did per-component `Array.find` lookups, and mixed sim results into static geometry. Mandate the opposite:

1. **Memoize every glyph.** `ComponentGlyph`, `Pin`, `Wire`, `Net` are wrapped in `React.memo`. Each subscribes (via a Zustand selector) only to *its own* slice: its `Component`, its `Position`, and its selection flag. Editing R1's value re-renders **only R1**.
2. **O(1) lookups via `Map<id,…>`.** Build derived `Map<componentId,…>` / `Map<netId,…>` indices in `store/selectors.ts` once per change. **No `components.find(c => c.id === …)` inside render or per-frame loops.** With `noUncheckedIndexedAccess`, every `map.get(id)` is `T | undefined` and must be handled.
3. **Stable references.** Zustand actions are stable; never inline new objects/arrays/closures into memoized children; use `useCallback`/`useMemo` only where they protect a memoized boundary.
4. **Separate sim-driven state from static geometry.** Waveform/probe overlay state lives in a different store slice (or the TanStack Query cache) than `CircuitJson`/`UiJson`. A new simulation result must **not** re-render schematic geometry.
5. **Virtualize large circuits.** Cull elements whose bbox does not intersect the visible rect (recomputed on pan/zoom end). Target smooth interaction up to the schema's hard ceiling of **1000 components / 1000 nets** (`CircuitJsonSchema` `.max(1000)`).
6. **Waveform rendering** uses uPlot (canvas) for the *plots only* (large numeric series), keeping the *schematic* in accessible SVG. The worker caps captured output at 5 MB and results >1 MB spill to S3 (and are re-hydrated server-side on read); downsample/decimate for display and target 60 fps pan/zoom on ~50k points.

**Performance budgets (acceptance):** glyph value edit re-renders only that glyph (assert via profiler / `why-did-you-render`); drag-move at 60 fps with 200 components; initial editor interactive < 2 s on a mid-tier laptop with a CI-enforced bundle-size budget; pan/zoom stays ≥ 50 fps at 500 components (virtualized).

#### State, autosave & dirty handling

- **Single source of truth:** the Zustand `editorStore` holds `{ circuit, ui, selection, dirty, lastSavedVersionId }`. Nothing else holds a copy of the document. Server state stays in TanStack Query. **No split-brain.**
- **Hydrate once:** on opening a version, `GET /versions/:versionId` returns `circuitJson` + `uiJson`; validate with `CircuitJsonSchema` / `UiJsonSchema` *before* hydrating the store.
- **Autosave = new immutable version (debounced):** mutating the document sets `dirty = true`; a debounced (~1.5–3 s idle) effect calls `POST /projects/:projectId/versions` with `{ circuitJson, uiJson }`. The backend creates a **new version** (monotonic `versionNumber`) — autosave *is* version history, not in-place mutation (there is no `PATCH` on versions). Validate `circuitJson` with `safeValidateCircuitJson` **before** POSTing (the API only checks `@IsObject()` here, so an invalid shape would otherwise persist silently).
- **Optimistic + resilient:** local edits apply instantly; the version POST runs in the background. On success, set `lastSavedVersionId`, clear `dirty`, show "Saved vN". On failure, keep `dirty`, toast a typed error, retry with backoff, and **do not roll back** in-progress edits. Warn on `beforeunload` while `dirty`; persist an emergency local snapshot (IndexedDB/`localStorage`) keyed by project so a crash never loses work; reconcile on next successful save.

#### Accessibility mandate (old app had zero a11y attributes)

WCAG 2.1 AA target. Non-negotiable baseline:

- **Every icon-only button has an `aria-label`** (palette tools, toolbar, zoom controls, run-sim). `jsx-a11y` lint enforces it.
- **Interactive SVG is accessible:** canvas root has `role="application"` (or `img` + description where appropriate); selectable components are focusable (`tabIndex`, `role="button"`/`group`, `aria-label` like "Resistor R1, 10k"); pins/wires expose accessible names; keyboard users can Tab to a component and operate it.
- **Full keyboard nav:** every editor operation is reachable without a mouse (palette placement + arrow-key move + Enter to confirm wiring). Dialogs trap focus (Radix handles this) and restore focus to the trigger on close; `Esc` closes.
- **Accessible alternatives for visual surfaces:** provide a tabular data view of `SimulationResult.series` alongside the waveform plot, and ARIA descriptions for ERC issues. The schematic canvas needs at minimum a structured description of its contents.
- **Color & motion:** ERC/sim status never communicated by color alone (icon + text); contrast ≥ 4.5:1 via Tailwind tokens; respect `prefers-reduced-motion`; visible focus rings everywhere (never `outline: none` without a replacement).
- **Acceptance:** `eslint-plugin-jsx-a11y` passes with zero warnings; an `@axe-core/playwright` scan of login, dashboard, and editor reports no critical violations.

#### Resilience (error boundaries, typed errors, loading/empty/error states)

- **Error boundaries:** root `app/error.tsx` + `app/global-error.tsx` + **per-segment `error.tsx`** (App Router) + a **dedicated React error boundary around the canvas** so a render glitch in one glyph never white-screens the editor. Boundaries show a recoverable fallback ("reload editor"), not a blank page.
- **Toasts mounted once** at the root (`<Toaster />`) — verified by a test that triggers a toast and asserts it renders. (Old app never mounted it.)
- **Loading / empty / error states everywhere:** every async surface renders explicit `isLoading` (skeleton), `isError` (typed message + retry), and **empty** states ("No projects yet — create one"). No silent blank panels. Enforce via reusable `<QueryBoundary>` / `<EmptyState>`.
- **Typed errors:** `lib/api/errors.ts` defines `ApiError` parsing the backend envelope `{ statusCode, message, error }` (`message` may be a `string` or `string[]` from the global `ValidationPipe`). Map: `400`→field errors (the pipe runs `forbidNonWhitelisted`, so send only documented fields), `401`→refresh-then-retry-then-login, `403`→"insufficient permissions" (role-gated deletes need OWNER/ADMIN), `404`→not-found, `409`→"email already registered", `429`→"slow down" (quick-sim is throttled 10/60s; the AI endpoints are throttled 3–10/60s). No raw error objects reach the UI.
- **Simulation resilience (documented quirks).** Simulation is **server-batch only** (no client solver): submit → poll `GET /simulations/:jobId` until terminal (`SUCCEEDED|FAILED|TIMED_OUT`; `CANCELED` is never emitted and there is no cancel endpoint, so do not offer a cancel action) → `GET /simulations/:jobId/result`. **Always submit explicit `probes`** — a version sim with no probes can return `SUCCEEDED` with an **empty `series`**; render "no probed signals — pick probes and re-run" rather than a blank chart. Large results spilled to S3 are **re-hydrated server-side**; `result` is `null` (with an `error` field) only when that S3 fetch/parse fails — treat that as transient and offer **Retry**, not "too large". On `FAILED`/`TIMED_OUT` (default 10 s worker timeout) show the `error`/`stderr` from the result endpoint.

#### Testing strategy

| Layer | Tool | What to test (must-have) |
|---|---|---|
| **Unit** | **Vitest** | Editor store ops (place/move/delete/wire/rotate/copy-paste produce correct `CircuitJson`+`UiJson`); **undo/redo** invariants; **hit-testing** (bbox vs point — regression-guard the old origin-only bug); snapping/geometry; `Map<id,…>` index builders; API client (auth header, **401→refresh→retry**, typed-error parsing); Zod boundary validation. |
| **Component** | **Vitest + React Testing Library** | Glyph renders per type and reflects selection; **re-render isolation** (editing one glyph does not re-render siblings — assert via profiler/`why-did-you-render`); forms validate via shared eda-core Zod schemas; ERC panel renders `ErcIssue[]`; **a11y** (roles/labels present, keyboard operable) via `jest-dom` + `axe`. |
| **E2E** | **Playwright** | Happy path: **login → create project → place R/C/V → wire → save version → configure transient + explicit probes → submit sim → poll → render waveform**. Plus: AI-generate dialog produces a loadable circuit; `/design-circuit` returns a circuit with a ready-made waveform; netlist import round-trips; **error paths** (401 refresh, 403 on MEMBER deleting a project, empty-series sim message, timed-out sim, S3-rehydrate-failure retry). Run against the real API + worker (ngspice) in CI or a mocked API for fast PR runs. Seed login: `demo@circuitforge.io` / `demo123456`. |

**CI gates:** typecheck (strict), ESLint (incl. `jsx-a11y`, a rule banning `as any`/unsafe casts, and the §8.3 secret-leak guard), Vitest with coverage thresholds, Playwright smoke, a bundle-size budget, and an OpenAPI-client drift check. The old app shipped **0 tests** — coverage thresholds are enforced from the first PR.

---

### 8.5 Roadmap

#### v1 — MVP (core design + server-sim + persistence + auth land first)
- [ ] Typed API client generated from `/docs-json`; domain types/validators imported from `@circuit-forge/eda-core` (no hand-rolled `fetch` strings, no redefined model).
- [ ] Auth: login, register, token refresh (single-flight 401 retry), logout; route guards; org switcher seeded from `GET /orgs`.
- [ ] Dashboard + projects CRUD (create/list/open; role-gated delete hidden for MEMBER).
- [ ] Project + version history (list summaries, open version, save-as-new-version).
- [ ] Schematic editor over the palette's component types (driven by `COMPONENT_TYPES`/`COMPONENT_PINS`, not a hardcoded list); pins→nets model; `UiJson` layout; undo/redo; bbox hit-testing; client-side ERC (`runErc`).
- [ ] Simulation panel: TRAN/AC/DC/OP config + **explicit probe picker**; submit + poll lifecycle.
- [ ] Waveform viewer: multi-trace plot, zoom/pan, cursors, basic measurements; error/timeout/empty-series/S3-rehydrate states.
- [ ] Templates browser (public + org), use-as-project (treat ids opaquely; non-UUID seed ids must not crash).
- [ ] Import SPICE `.cir` (`parseNetlist`); export `.cir`, native JSON, results CSV.
- [ ] **AI dialog** wired to `POST /generate-circuit` (and optionally `/design-circuit` for one-shot generate+simulate+waveform); client-side re-validation + preview-before-insert; graceful Retry on unreachable backend. These endpoints are **built** — do not ship a "coming soon" placeholder.
- [ ] Error boundaries, mounted toasts, loading/empty/error states everywhere; a11y baseline (axe green).

#### Phase 2
- [ ] Asset/model manager (presign → PUT → commit, download, delete) and **wiring `modelAssets` into sim runs** (requires the API to populate the worker payload first).
- [ ] AI edit/explain flows (`POST /edit-circuit`, `/explain-circuit`) integrated into the editor as inline assist.
- [ ] Org creation UI + role-aware affordances; richer settings/preferences.
- [ ] Version diff/compare; duplicate-into-new-project; rename/branch UX.
- [ ] PNG/PDF schematic export; PNG waveform export; print views.
- [ ] Advanced waveform measurements (FFT, THD, trace math); same-origin BFF cookie for the refresh token.

#### Later
- [ ] KiCad and LTspice `.asc` import/export (**backend** converters; further `ComponentType` growth beyond today's set — keep eda-core canonical).
- [ ] Real-time/collaborative editing; presence.
- [ ] Member-management UI (blocked until invite/role-change endpoints exist).
- [ ] Cancel-simulation UX (blocked until a cancel endpoint exists; `CANCELED` is currently never emitted).

---

### 8.6 Acceptance criteria & Definition of Done

#### Acceptance criteria per major feature
- **Auth:** register (auto-org created), login, and a `401` triggers single-flight refresh + one retry; logout clears all tokens; DTO validation errors render inline; no token ever appears in a URL or log.
- **Projects/Versions:** create/list/open scoped to the active org; saving the editor creates a new `ProjectVersion` whose `circuitJson` round-trips through `safeValidateCircuitJson`; the version list shows summaries without fetching full JSON; MEMBER cannot see delete.
- **Editor:** build an RC low-pass circuit (R + C + V + ground) from scratch; designators validated against `^[A-Z][A-Z0-9]*[0-9]+$`; live ERC flags `NO_GROUND`/`MISSING_VALUE` and highlights `relatedIds`; undo/redo works; `UiJson` persists positions/rotation/wires; selection uses bbox, not origin.
- **Simulation:** submitting a TRAN with explicit probes returns a `jobId`, polling reaches `SUCCEEDED`, and the result has non-empty `series`; `FAILED`/`TIMED_OUT` render `error`/`stderr`; a null `result` on a succeeded job shows a retry state.
- **Waveform viewer:** multi-trace render with correct X-axis label/unit per analysis type (from `meta`); zoom/pan/cursor delta and at least min/max/pk-pk/RMS measurements; empty-series and S3-rehydrate states handled; accessible tabular alternative present.
- **Templates:** list public templates (no `orgId`) works; org templates require active org; "use as project" opens the circuit in the editor; non-UUID seeded ids do not crash the UI.
- **AI generate:** prompt → `POST /generate-circuit` → client-re-validated `CircuitJson` preview → insert; invalid/failed responses never mutate the editor; `/design-circuit` shows the returned `simulation.result` waveform; no client secret involved.
- **Import/Export:** importing a SPICE `.cir` produces a valid editable circuit (parser warnings surfaced); export `.cir` / native JSON / results CSV round-trip.
- **Assets (Phase 2):** presign → PUT → commit uploads a model ≤ 10 MB with a correct client-computed `sha256`; download returns a working URL; MEMBER cannot delete.

#### Definition of Done / guardrails checklist
- [ ] **Typed API client** derived from `/docs-json`; all endpoints typed end-to-end; client-drift check in CI.
- [ ] **Shared schema:** import domain types/validators from `@circuit-forge/eda-core`; never redefine `CircuitJson`/analysis/simulation types in the frontend.
- [ ] **Validation at boundaries:** every server/AI/import payload passes the relevant eda-core Zod validator before use; **no unsafe `as` casts** (old app had 159 — target zero in domain code).
- [ ] **Tests present:** unit (stores, eda-core integration, CSV/SPICE round-trips, hit-testing), component (editor/sim/waveform, re-render isolation, a11y), and e2e for the happy path + error paths. (Old app had 0 tests.)
- [ ] **a11y pass:** `jsx-a11y` + axe green in CI; keyboard + screen-reader smoke test for each screen.
- [ ] **Error boundaries** around the editor, waveform viewer, and route shells; **toasts mounted** at the root and test-verified.
- [ ] **Single source of truth state** — one Zustand editor store; server state only in TanStack Query; no dead store + local-`useState` split-brain.
- [ ] **No secrets client-side** — verified by the §8.3 CI grep guard; AI/secret calls only via backend; Bearer auth on every business call; only `NEXT_PUBLIC_API_URL` is public.
- [ ] **No client-side solver** — simulation is strictly submit → poll → render; **no un-memoized full-tree re-renders** — every glyph `React.memo`'d with narrow selectors and `Map<id,…>` lookups.
- [ ] **No dead code / phantom imports**; lint + typecheck clean; bundle-size budget enforced.
- [ ] **Loading/empty/error states** for every async surface; resilient to the documented backend quirks (empty series, S3-rehydrate failure, non-UUID seed ids, no cancel/no member API, role-gated deletes returning `403`/`400`).

---

### 8.7 Anti-patterns to avoid (non-negotiable)

Derived directly from the abandoned `circuit-simulator` audit — each maps to a mandate above:

1. **No client-exposed secrets.** Never put API/LLM keys in `NEXT_PUBLIC_*` or any bundled code; all secret/AI/signed calls go through the backend (presigned S3 URLs, server-held `LLM_API_KEY`). (Old: key leaked via a `NEXT_PUBLIC_` var.) → §8.3.
2. **No untested code.** Tests required from PR #1 (Vitest + RTL + Playwright), coverage gated in CI. (Old: 0 tests.) → §8.4 testing.
3. **No un-memoized full-tree re-renders.** Every glyph is `React.memo` with narrow selectors; no inline objects/closures into memoized children. (Old: 0 `React.memo`.) → §8.4 performance.
4. **No accessibility gaps.** `aria-label` on every icon button, ARIA roles on interactive SVG, full keyboard nav, focus management; `jsx-a11y` + axe gated. (Old: 0 a11y attributes.) → §8.4 a11y.
5. **No missing error boundaries / unmounted toasts.** Top-level + per-route + canvas boundaries; `<Toaster />` mounted and test-verified. (Old: no boundaries, toasts never mounted.) → §8.4 resilience.
6. **No split-brain state.** One Zustand store is the document's single source of truth; server state only in TanStack Query; local `useState` only for ephemeral non-shared UI. (Old: dead Zustand + live `useState`.) → §8.1, §8.4 state.
7. **No duplicated/drifted domain model.** Import `CircuitJson`/`UiJson`/`AnalysisConfig`/Zod schemas from `@circuit-forge/eda-core`; never redefine. (Old: duplicated, drifted model.) → §8.1.
8. **No unsafe `as` casts.** Validate at boundaries with Zod; rely on `noUncheckedIndexedAccess`; ban `as any` in lint. (Old: 159 unsafe casts.) → §8.1, §8.4 performance.
9. **No origin-only hit-testing.** Selection/marquee uses full element bbox/geometry, regression-tested. (Old: tested only the origin point.) → §8.4 editor + testing.
10. **No client-side solver.** Simulation is server-batch only (submit → poll → render). (Old: client 10 Hz MNA solver — abandoned.) → §8.4 resilience.
11. **No mixing sim results into static geometry.** Sim/probe state is a separate slice; never re-renders the schematic. → §8.4 performance.

---

### Closing

A "done" Circuit Forge frontend is: a **client-first Next.js (App Router) app** where (1) every API call goes through a **typed, auth-aware client**; (2) the editor document is **eda-core `CircuitJson` + `UiJson`** with no drifted/duplicated model and Zod validation at every boundary; (3) simulation is strictly **server-batch** (submit → poll → render — no client solver) and the **built** AI endpoints (`/generate-circuit`, `/edit-circuit`, `/explain-circuit`, `/design-circuit`) are consumed with no client-side secret; (4) glyphs are **memoized** with O(1) `Map` lookups and virtualized to the 1000-component ceiling; (5) **WCAG 2.1 AA accessibility**, error boundaries, and a mounted toast system are in place; (6) **tests** (Vitest/RTL + Playwright) and CI gates (lint, typecheck, a11y, secret-scan, bundle budget) are green. When this section conflicts with the running server, the **live API + `/docs-json` win** — regenerate the client and reconcile.


