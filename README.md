# Circuit Forge — AI Circuit Generator & Simulator (Backend)

A backend system for AI-assisted circuit design and **SPICE-based simulation**. This pnpm + Turborepo monorepo contains the REST API, the simulation worker, and the core EDA libraries (circuit modeling, netlist generation, SPICE sanitization, ERC, result parsing).

> **Heads up — this repo is pnpm-only.** Internal packages use the `workspace:*` protocol, which `npm install` cannot parse. Always use `pnpm`. See [LOCAL_SETUP.md](LOCAL_SETUP.md).

---

## ✨ Features

- **Multi-tenant REST API** (NestJS) — organizations, projects, versioned circuits, templates, model assets, and simulations, secured with JWT + RBAC.
- **Async simulation pipeline** — API enqueues jobs on a BullMQ/Redis queue; a dedicated worker runs **ngspice** in an isolated, sandboxed per-job directory and stores results in Postgres or S3/MinIO. Simulation jobs retry with backoff and clean themselves up on completion/failure; jobs are capped by a sim timeout and output-size/point limits.
- **Durable AI design queue** — the AI design loop runs on its own durable BullMQ queue (not an in-process detached runner), with graceful shutdown (workers close → orphan reaper stops → DB disconnects → telemetry flushes, on both API and worker `SIGTERM`/`SIGINT`) and an orphan-design reaper that reconciles rows stuck `QUEUED`/`RUNNING` against the queue's real state after a crash.
- **EDA core library** (`@circuit-forge/eda-core`):
  - Circuit-JSON → SPICE **netlist generation** for a broad device set — R/L/C, transformers & lossless transmission lines, independent + controlled (E/G) + arbitrary behavioral (B) sources, diodes/Zener, BJT/MOSFET/JFET, voltage-controlled switches, thyristors/SCR, IGBTs, and op-amp/IC `.subckt` macromodels — backed by a curated generic **model library**, plus control block and probes.
  - **SPICE security/sanitization** — reserved-word & node-name sanitization, shell-metacharacter rejection, `.include` path whitelisting.
  - **ERC** (Electrical Rule Check) with coded findings.
  - **Result parsing** — ngspice CSV / raw ASCII → typed series, plus five report-only ngspice-native analyses: `.four`/THD (Fourier), `.meas` measurements, `.tf` DC transfer function, `.noise`, and `.sens` DC sensitivity.
  - **Zod schemas** for circuit and analysis config (transient / AC / DC / operating point), including per-analysis `fourier`/`measurements` (transient) and `tf` (operating point) config plus dedicated noise/sensitivity analysis types.
- **LLM core** (`@circuitforge/llm-core`) — AI circuit generation via Claude using a native **tool-use loop grounded in the live parts catalog** (the model searches/inspects real parts before specifying components, so outputs carry real MPNs + sourcing), plus a simulate-in-the-loop design endpoint that runs ngspice and self-repairs until the circuit verifies.
- **Verdict-gating spec assertions** — the AssertionDto metric enum (`min | max | final | pp | avg | rms | cutoff | thd | gain`) lets a spec gate the "verified" verdict on THD and small-signal gain, not just raw voltage/current levels; both are also evaluated for robustness across component-tolerance variants via the Monte-Carlo yield engine (informally "robust-THD"/"robust-gain" — pass at nominal AND across tolerance draws, not nominal alone).
- **Live component catalog** (`parts`) — TME-backed search over 1.3M+ real manufacturer parts (stock, pricing tiers, datasheets), structured classification, and CircuitJson component mapping; OAuth tokens + responses cached. Feeds AI grounding and per-version **BOM** export.
- **SPICE netlist interchange** (`netlist`) — import/export standard SPICE decks (LTspice/KiCad round-trip), covering both analog and digital/XSPICE (flip-flops, latches, gates, tristate) circuits, with generic model bodies inlined on export.
- **Usage metering & quotas** (`usage`) — always-on metering with default-unlimited quotas (per `QUOTA_*` env): multi-tenant simulation fairness (concurrent/monthly), per-user catalog-call ceilings, and per-org storage caps; drift-free on-demand aggregation, structured `429 QUOTA_EXCEEDED`.
- **Auth & security** — Argon2 password hashing, JWT access + refresh token rotation, login brute-force lockout, email verification + password reset, per-org roles (OWNER/ADMIN/MEMBER), `class-validator` + Zod input validation, global rate limiting, CORS allowlist, security headers.
- **Production robustness** — a `/health/ready` readiness probe pings DB + Redis + S3 concurrently and reports 503 on degradation; LLM calls carry a per-call timeout, a token budget, and retry-on-timeout; simulation jobs are capped by output-size and point limits (see the durable-queue bullet above for retry/cleanup).
- **Local infra via Docker Compose** — Postgres, Redis, MinIO (+ auto bucket creation).
- **Demo seed** — ready-to-use user, org, 10 circuit templates, and a sample project.

---

## 🏗️ Architecture

```
                         ┌──────────────────────────────────────────────┐
        client  ───────► │                 API (NestJS)                 │
                         │  auth · orgs · projects · versions · parts ·  │
                         │  templates · assets · simulation · generation │
                         │  · netlist · usage · health                   │
                         └───┬───────────────┬───────────────┬──────────┘
                             │ Prisma        │ BullMQ         │ S3 SDK
                             ▼               ▼               ▼
                      ┌────────────┐  ┌────────────┐  ┌────────────┐
                      │  Postgres  │  │   Redis    │  │   MinIO    │
                      │ (database) │  │  (queue)   │  │  (S3 obj)  │
                      └────────────┘  └─────┬──────┘  └─────▲──────┘
                                            │ consume       │ results / models
                                            ▼               │
                                   ┌────────────────────────┴───┐
                                   │      worker-sim (BullMQ)    │
                                   │   ┌──────────────────────┐  │
                                   │   │  ngspice (-b) runner  │  │
                                   │   └──────────────────────┘  │
                                   └─────────────────────────────┘
```

Full details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## 📂 Project Structure

```
circuit-forge/
├─ apps/
│  ├─ api/                         # NestJS REST API
│  │  ├─ __tests__/                # integration + e2e smoke tests
│  │  ├─ prisma/
│  │  │  ├─ migrations/            # SQL migrations (init → usage_records → usage_tune)
│  │  │  ├─ schema.prisma          # data model
│  │  │  └─ seed.ts                # demo data seeder
│  │  └─ src/
│  │     ├─ auth/                  # JWT + local strategies, guards, decorators
│  │     ├─ orgs/                  # organizations + membership/RBAC
│  │     ├─ projects/              # projects (org-scoped)
│  │     ├─ versions/              # versioned circuit snapshots + BOM (sourcing)
│  │     ├─ templates/             # public/org circuit templates
│  │     ├─ assets/                # S3 model-file upload (presign/commit)
│  │     ├─ simulation/            # enqueue & query simulations (+ downsampling)
│  │     ├─ generation/            # AI circuit generate/edit/explain/design (catalog-grounded)
│  │     ├─ parts/                 # TME component catalog (search, detail, mapping, cache)
│  │     ├─ netlist/               # SPICE deck import / export (LTspice/KiCad interchange)
│  │     ├─ usage/                 # usage metering + quota gates (sim, parts, storage)
│  │     ├─ health/                # health / ready / live
│  │     ├─ prisma/                # PrismaService module
│  │     ├─ app.module.ts
│  │     └─ main.ts                # bootstrap (reads PORT, Swagger /docs)
│  └─ worker-sim/                  # BullMQ simulation worker
│     └─ src/
│        ├─ simulation/            # processor (queue) + runner (ngspice)
│        ├─ storage/               # S3 client (download models / upload results)
│        ├─ prisma/                # Prisma client
│        ├─ config.ts              # zod-validated env config
│        ├─ logger.ts
│        └─ main.ts
├─ packages/
│  ├─ eda-core/                    # circuit & netlist library
│  │  ├─ __tests__/                # unit + coverage-matrix / sweep / fuzz harnesses (live ngspice)
│  │  └─ src/
│  │     ├─ netlist/               # generator.ts + sanitizer.ts (security)
│  │     ├─ models/                # curated generic SPICE model library (diodes, BJT/FET, digital, …)
│  │     ├─ parser/                # csv-parser.ts + netlist-parser.ts
│  │     ├─ erc/                   # checker.ts + codes.ts (rule checks)
│  │     ├─ schemas/               # analysis.schema.ts + circuit.schema.ts (zod)
│  │     ├─ types/                 # circuit / analysis / erc / simulation
│  │     ├─ utils/                 # unit-parser.ts
│  │     └─ index.ts               # public API surface
│  └─ llm-core/                    # AI generation (Claude tool-use + catalog grounding)
│     └─ src/index.ts
├─ infra/
│  └─ docker/                      # api.Dockerfile + worker-sim.Dockerfile
├─ docs/                           # ← detailed documentation (see index below)
├─ plans/
│  └─ IMPLEMENTATION_PLAN.md       # original implementation plan (historical)
├─ .env / .env.example             # environment variables
├─ docker-compose.yml              # local infra (postgres, redis, minio, …)
├─ turbo.json                      # Turborepo pipeline
├─ pnpm-workspace.yaml             # workspaces: apps/*, packages/*
├─ tsconfig.base.json
├─ LOCAL_SETUP.md                  # ← verified local setup & troubleshooting
└─ README.md                       # this file
```

---

## 🧰 Tech Stack

| Layer | Technology |
|-------|-----------|
| API framework | NestJS 10, Express |
| ORM / DB | Prisma 5, PostgreSQL 15 |
| Queue | BullMQ 5 on Redis 7 (ioredis) |
| Object storage | AWS S3 SDK → MinIO |
| Simulation | ngspice (batch mode) |
| Validation | Zod, class-validator / class-transformer |
| Auth | JWT (`@nestjs/jwt`, passport), Argon2 |
| Logging | pino / pino-http / pino-pretty |
| Tooling | pnpm 8, Turborepo, TypeScript 5, tsx, Jest, ESLint, Prettier |

---

## 🚀 Quick Start

> Verified, step-by-step instructions (incl. Windows specifics and port-conflict handling) live in **[LOCAL_SETUP.md](LOCAL_SETUP.md)**.

```powershell
pnpm install                                # never `npm install`
docker compose up -d postgres redis minio   # Postgres 5432 / Redis 6379 / MinIO 9000
pnpm db:migrate:dev                          # apply schema  (first run creates it)
pnpm db:seed                                 # demo data (optional)
pnpm dev                                     # start all 4 packages
```

- **API:** http://localhost:3001  · **Swagger:** http://localhost:3001/docs
- **MinIO console:** http://localhost:9001 (`minioadmin` / `minioadmin`)
- **Demo login:** `demo@circuitforge.io` / `demo123456`

> The API port is set by `PORT` in `.env` (default 3000; this repo uses **3001** locally). The `API_PORT` variable is currently **not read** by the code — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#environment-variables).

### ngspice (required for simulation results)

Without ngspice the pipeline runs end-to-end but jobs fail with `ngspice exited with code 1`. Install it:

```powershell
# Windows (run in an Administrator PowerShell)
choco install ngspice -y
# Linux:  sudo apt-get install ngspice     |     macOS:  brew install ngspice
```

See [docs/SIMULATION.md](docs/SIMULATION.md) for the full pipeline and a known result-parsing quirk.

---

## 📡 API Summary

JWT-protected REST API (base `http://localhost:3001`, interactive docs at `/docs`). Modules: **auth, orgs, projects, versions, templates, assets, simulation, generation (AI), parts (catalog), netlist (import/export), usage (metering/quotas), health**.

Full per-endpoint reference (methods, paths, auth, request/response): **[docs/API.md](docs/API.md)**.

---

## 🛠️ Scripts (root)

| Script | Purpose |
|--------|---------|
| `pnpm dev` | Start all apps/packages in watch mode (Turbo) |
| `pnpm build` | Build all packages and apps |
| `pnpm test` / `pnpm test:cov` / `pnpm test:e2e` | Run tests / with coverage / e2e |
| `pnpm lint` / `pnpm lint:fix` | ESLint |
| `pnpm format` / `pnpm format:check` | Prettier |
| `pnpm typecheck` | TypeScript type-check |
| `pnpm db:migrate` / `db:migrate:dev` | Apply migrations (deploy / dev) |
| `pnpm db:generate` | Generate Prisma client |
| `pnpm db:seed` | Seed demo data |
| `pnpm db:studio` | Open Prisma Studio |
| `pnpm clean` | Clean build artifacts |

---

## 📚 Documentation

| Doc | Contents |
|-----|----------|
| [LOCAL_SETUP.md](LOCAL_SETUP.md) | Verified local setup, daily run, port conflicts, troubleshooting |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture, data flow, infra, Turbo pipeline, **all env vars** |
| [docs/API.md](docs/API.md) | Complete REST API reference (every endpoint) |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Prisma schema — every model, enum, relation (ER diagram) |
| [docs/EDA_CORE.md](docs/EDA_CORE.md) | `eda-core` & `llm-core`: circuit JSON, netlist gen, sanitizer, ERC, parsers, schemas |
| [docs/SIMULATION.md](docs/SIMULATION.md) | Worker pipeline, ngspice execution, result storage, known quirks |
| [docs/SECURITY.md](docs/SECURITY.md) | Auth, RBAC, validation, rate limiting, simulation sandboxing |
| [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) | OpenTelemetry traces + metrics, enabling it, custom sim metrics, recommended alerts |
| [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) | Design decisions & assumptions (historical) |
| [plans/IMPLEMENTATION_PLAN.md](plans/IMPLEMENTATION_PLAN.md) | Original implementation plan (historical) |

---

## 🧪 Demo Data

`pnpm db:seed` creates:
- **User:** `demo@circuitforge.io` / `demo123456`
- **Organization:** "Demo Organization"
- **10 templates:** RC Low-Pass Filter, Voltage Divider, Diode Rectifier, LC Oscillator, RC Integrator, Buck Converter, Sallen-Key Low-Pass, 555-style Astable, Class-AB Push-Pull, R-2R Ladder DAC
- **Project:** "My First Circuit" (version 1)

---

Built with NestJS, Prisma, BullMQ, ngspice, and Turborepo.
