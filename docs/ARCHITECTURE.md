# System Architecture

Circuit Forge is a multi-tenant backend for creating, versioning, and simulating
electronic circuits. It is a **pnpm + Turborepo monorepo** with two runnable apps
(`apps/api`, `apps/worker-sim`) and two shared libraries (`packages/eda-core`,
`packages/llm-core`). The HTTP API enqueues simulation jobs onto a Redis-backed
BullMQ queue; a separate worker process consumes those jobs and shells out to the
`ngspice` SPICE engine.

> Accuracy note: every statement below is derived from the source files in this
> repository (links are relative to the repo root `e:\circuit-forge`). Where a
> latent bug or environment quirk exists, it is explicitly called out rather than
> glossed over.

---

## 1. High-Level Architecture

### Components

| Component | Code | Role |
|-----------|------|------|
| **API** | [apps/api](../apps/api) (NestJS) | REST API, auth/RBAC, CRUD, enqueues simulation jobs, reads results |
| **worker-sim** | [apps/worker-sim](../apps/worker-sim) | BullMQ consumer that runs `ngspice` and writes results back |
| **PostgreSQL** | via Prisma ([schema.prisma](../apps/api/prisma/schema.prisma)) | Primary datastore (users, orgs, projects, versions, jobs, assets) |
| **Redis** | BullMQ queue `simulations` | Job queue between API (producer) and worker (consumer) |
| **MinIO / S3** | AWS SDK v3 (`@aws-sdk/client-s3`) | Object storage for asset files and large simulation results |
| **eda-core** | [packages/eda-core](../packages/eda-core) | Pure-TS library: CircuitJson types, netlist generation, output parsing, ERC |
| **llm-core** | [packages/llm-core](../packages/llm-core) | Stub library for future LLM circuit generation |

### Diagram

```
                            ┌──────────────────────────────┐
                            │           Clients            │
                            │  REST / Swagger / CLI / FE    │
                            └───────────────┬──────────────┘
                                            │ HTTP (JWT Bearer)
                                            ▼
        ┌───────────────────────────────────────────────────────────────┐
        │                       apps/api  (NestJS)                       │
        │  Auth · Orgs · Projects · Versions · Templates · Assets ·      │
        │  Simulation · Health                                           │
        │                                                                │
        │  uses @circuitforge/eda-core to turn CircuitJson -> netlist    │
        │  BullMQ producer  ──┐         AWS SDK ──┐    Prisma ──┐         │
        └─────────────────────┼──────────────────┼─────────────┼─────────┘
                              │ enqueue           │ presign/read│ R/W
                              ▼                   │             ▼
                      ┌───────────────┐           │     ┌───────────────┐
                      │     Redis     │           │     │  PostgreSQL   │
                      │ queue:        │           │     │  (Prisma)     │
                      │ "simulations" │           │     └───────▲───────┘
                      └───────┬───────┘           │             │ status/result
                              │ BullMQ job        │             │
                              ▼                   ▼             │
        ┌───────────────────────────────────────────────────────────────┐
        │                  apps/worker-sim  (BullMQ Worker)              │
        │   processor → runner (spawn ngspice) → eda-core output parse   │
        │   storage (S3 download models / upload large results)          │
        └───────────────────────────┬───────────────────────────────────┘
                                     │
                                     ▼
                            ┌────────────────┐
                            │   MinIO / S3   │
                            │  bucket:       │
                            │  circuitforge  │
                            └────────────────┘
```

### End-to-end simulation data flow

The simulation endpoints are defined in
[simulation.controller.ts](../apps/api/src/simulation/simulation.controller.ts):
`POST versions/:versionId/simulations`, `POST simulations/quick`, and
`GET simulations/:jobId`.

```
Client          API (NestJS)              Redis            worker-sim        ngspice        Postgres / S3
  │  POST .../simulations │                  │                 │               │                 │
  │──────────────────────▶│ validate JWT     │                 │               │                 │
  │                       │ check org RBAC   │                 │               │                 │
  │                       │ load version ─────────────────────────────────────────────────────▶ │ (read circuitJson)
  │                       │ eda-core: CircuitJson → SPICE netlist               │                 │
  │                       │ create SimulationJob (status) ────────────────────────────────────▶ │ (insert)
  │                       │ queue.add('simulations', payload)                                     │
  │                       │─────────────────▶│ enqueue         │               │                 │
  │  202 { jobId }        │                  │                 │               │                 │
  │◀──────────────────────│                  │                 │               │                 │
  │                       │                  │ deliver job ───▶│ processor     │                 │
  │                       │                  │                 │ update RUNNING ───────────────▶ │
  │                       │                  │                 │ download model assets ◀──────── │ S3
  │                       │                  │                 │ runner: spawn │                 │
  │                       │                  │                 │──────────────▶│ run netlist     │
  │                       │                  │                 │ parse output  │ writes CSV      │
  │                       │                  │                 │ (eda-core)    │                 │
  │                       │                  │                 │ store result ─────────────────▶ │ DB (small) or S3 (large)
  │                       │                  │                 │ update SUCCEEDED/FAILED ──────▶ │
  │  GET simulations/:id  │                  │                 │               │                 │
  │──────────────────────▶│ read job + result ──────────────────────────────────────────────── │
  │  200 { result }       │◀──────────────── (from DB; or presigned S3 link)                     │
  │◀──────────────────────│                  │                 │               │                 │
```

Key wiring evidence:
- API producer queue name `simulations` and Redis connection:
  [simulation.module.ts](../apps/api/src/simulation/simulation.module.ts) (BullMQ
  `connection.url = REDIS_URL`, `registerQueue({ name: 'simulations' })`) and
  [simulation.service.ts](../apps/api/src/simulation/simulation.service.ts)
  (`@InjectQueue('simulations')`).
- Worker consumer:
  [processor.ts](../apps/worker-sim/src/simulation/processor.ts) creates an `ioredis`
  connection to `config.REDIS_URL` and a BullMQ `Worker(config.QUEUE_NAME, ...)`
  with `config.CONCURRENCY`. The default queue name (`simulations`) and the
  API-side queue name match.
- ngspice execution: [runner.ts](../apps/worker-sim/src/simulation/runner.ts)
  ("Executes ngspice simulations in isolated job directories").
- S3 access on the API side (asset upload / presign):
  [assets.service.ts](../apps/api/src/assets/assets.service.ts).

---

## 2. Monorepo Layout & Turbo Pipeline

### Workspace layout

[pnpm-workspace.yaml](../pnpm-workspace.yaml) globs the workspace:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

```
circuit-forge/
├── apps/
│   ├── api/                 # "api"                     (NestJS REST API)
│   └── worker-sim/          # "@circuitforge/worker-sim" (BullMQ + ngspice)
├── packages/
│   ├── eda-core/            # "@circuitforge/eda-core"   (netlist/parse/ERC lib)
│   └── llm-core/            # "@circuitforge/llm-core"   (stub)
├── infra/docker/           # api.Dockerfile, worker-sim.Dockerfile
├── docs/                   # this file + API/DATA_MODEL/etc.
├── docker-compose.yml
├── turbo.json
├── tsconfig.base.json
├── pnpm-workspace.yaml
├── package.json            # root scripts + devDeps + packageManager
└── .env.example
```

Internal dependencies are declared with `workspace:*` (e.g. `apps/api` and
`apps/worker-sim` both depend on `"@circuitforge/eda-core": "workspace:*"`).
**This makes the repo pnpm-only** — running `npm install` cannot resolve
`workspace:*` and crashes. Always use `pnpm` (`packageManager` is pinned to
`pnpm@8.14.1` in [package.json](../package.json), `engines` requires Node ≥ 20 and
pnpm ≥ 8).

### Root scripts → Turbo

[package.json](../package.json) delegates most tasks to Turbo and the DB tasks to a
filtered `api` package:

| Root script | Command |
|-------------|---------|
| `dev` | `turbo run dev` |
| `build` | `turbo run build` |
| `test` / `test:cov` / `test:e2e` | `turbo run test*` |
| `lint` / `lint:fix` | `turbo run lint*` |
| `typecheck` | `turbo run typecheck` |
| `db:migrate` | `pnpm --filter api db:migrate` (`prisma migrate deploy`) |
| `db:migrate:dev` | `pnpm --filter api db:migrate:dev` (`prisma migrate dev`) |
| `db:generate` | `pnpm --filter api db:generate` (`prisma generate`) |
| `db:studio` | `pnpm --filter api db:studio` (`prisma studio`) |
| `db:seed` | `pnpm --filter api db:seed` (`ts-node prisma/seed.ts`) |
| `format` / `format:check` | Prettier over `**/*.{ts,tsx,js,jsx,json,md}` |
| `clean` | `turbo run clean && rm -rf node_modules` |

### Turbo pipeline ([turbo.json](../turbo.json))

`globalDependencies: [".env"]` — the root `.env` is a global input, so changing it
invalidates the Turbo cache across all tasks.

| Task | `dependsOn` | `outputs` (cached) | `cache` | `persistent` |
|------|-------------|--------------------|---------|--------------|
| `build` | `^build` (deps' build first) | `dist/**` | default (on) | — |
| `dev` | — | — | **false** | **true** |
| `lint` | — | `[]` (none) | default | — |
| `lint:fix` | — | `[]` | default | — |
| `test` | `build` | `coverage/**` | default | — |
| `test:cov` | `build` | `coverage/**` | default | — |
| `test:e2e` | `build` | `[]` | default | — |
| `typecheck` | `^build` | `[]` | default | — |
| `clean` | — | — | **false** | — |
| `db:migrate` | — | — | **false** | — |
| `db:migrate:dev` | — | — | **false** | — |
| `db:generate` | — | — | **false** | — |
| `db:seed` | — | — | **false** | — |

Notes:
- `^build` means "build all internal dependencies first" — so `eda-core` builds
  before `api`/`worker-sim` for `build` and `typecheck`.
- `test*` depend on `build` (the package's own build) before running Jest.
- `dev` is `persistent: true` and `cache: false` (long-running watchers, never
  cached). The per-package `dev` commands are `nest start --watch` (api) and
  `tsx watch src/main.ts` (worker-sim).
- All `db:*` tasks set `cache: false` because they have side effects on the
  database and must always run.

### Per-package task targets

These are the underlying scripts Turbo invokes:

| Package | build | dev | test | typecheck |
|---------|-------|-----|------|-----------|
| [apps/api](../apps/api/package.json) | `nest build` | `nest start --watch` | `jest` | `tsc --noEmit` |
| [apps/worker-sim](../apps/worker-sim/package.json) | `tsc` | `tsx watch src/main.ts` | (none) | `tsc --noEmit` |

`tsconfig.base.json` is the shared compiler base ([tsconfig.base.json](../tsconfig.base.json)):
`target/lib ES2022`, `module commonjs`, full `strict` (plus `noUnusedLocals`,
`noUnusedParameters`, `noImplicitReturns`, `noUncheckedIndexedAccess`,
`forceConsistentCasingInFileNames`), `declaration` + `declarationMap` + `sourceMap`,
`esModuleInterop`, `resolveJsonModule`, and `experimentalDecorators` +
`emitDecoratorMetadata` (required by NestJS / class-validator decorators).

---

## 3. Tech Stack

| Layer | Technology | Where | Notes |
|-------|-----------|-------|-------|
| Language / build | TypeScript 5.3 | root + all packages | Shared `tsconfig.base.json`, ES2022, strict |
| Monorepo | pnpm 8.14.1 + Turborepo 1.11 | [package.json](../package.json), [turbo.json](../turbo.json) | `workspace:*` internal deps |
| API framework | NestJS 10 | [apps/api](../apps/api/package.json) | `@nestjs/common/core/platform-express` |
| API docs | `@nestjs/swagger` 7 | [main.ts](../apps/api/src/main.ts) | Swagger UI mounted at `/docs` |
| ORM / DB | Prisma 5 + `@prisma/client` | [schema.prisma](../apps/api/prisma/schema.prisma) | PostgreSQL |
| Database | PostgreSQL 15 | docker-compose `postgres` | `postgres:15-alpine` |
| Queue | BullMQ 5 | api (`@nestjs/bullmq`) + worker (`bullmq`) | Queue `simulations` |
| Redis client | ioredis 5 | api + worker | BullMQ connection transport |
| Cache/queue store | Redis 7 | docker-compose `redis` | `redis:7-alpine` |
| Object storage SDK | `@aws-sdk/client-s3` 3, `@aws-sdk/s3-request-presigner` (api), `@aws-sdk/lib-storage` (worker) | api + worker | S3-compatible |
| Object storage | MinIO | docker-compose `minio` | `minio/minio`, path-style |
| SPICE engine | ngspice | worker-sim Docker image / local install | Required to run simulations |
| Schema validation | Zod 3 | eda-core, worker [config.ts](../apps/worker-sim/src/config.ts) | Circuit + env validation |
| DTO validation | class-validator + class-transformer | apps/api | Global `ValidationPipe` |
| Password hashing | argon2 0.31 | apps/api auth, [seed.ts](../apps/api/prisma/seed.ts) | Password hashing |
| Auth | `@nestjs/jwt`, `@nestjs/passport`, `passport-jwt`, `passport-local` | apps/api auth | JWT access + refresh |
| Rate limiting | `@nestjs/throttler` 5 | [app.module.ts](../apps/api/src/app.module.ts) | `short` + `medium` named limiters |
| Security headers | helmet 7 | apps/api dep | — |
| Logging | pino 8 (+ `pino-http`, `pino-pretty`) | api + worker [logger.ts](../apps/worker-sim/src/logger.ts) | Structured JSON logs |
| Dev runner | tsx 4 | worker-sim `dev` | TS watch mode |
| Tests | Jest 29 (+ ts-jest, supertest) | apps/api `__tests__` | Integration + e2e-smoke |

---

## 4. Infrastructure

### docker-compose services ([docker-compose.yml](../docker-compose.yml))

Compose file version `3.8`. Six services and three named volumes
(`postgres-data`, `redis-data`, `minio-data`).

| Service | Image | Ports | Healthcheck | depends_on |
|---------|-------|-------|-------------|------------|
| **postgres** | `postgres:15-alpine` | `5432:5432` | `pg_isready -U postgres` (5s/5s/5) | — |
| **redis** | `redis:7-alpine` | `6379:6379` | `redis-cli ping` (5s/5s/5) | — |
| **minio** | `minio/minio` | `9000:9000` (API), `9001:9001` (console) | `curl -f http://localhost:9000/minio/health/live` (5s/5s/5) | — |
| **create-bucket** | `minio/mc` | — | — | `minio` (service_healthy) |
| **api** | build `infra/docker/api.Dockerfile` | `3000:3000` | — | postgres, redis, minio (all service_healthy) |
| **worker-sim** | build `infra/docker/worker-sim.Dockerfile` | — | — | postgres, redis, minio (all service_healthy) |

Per-service detail:

- **postgres** — env `POSTGRES_USER=postgres`, `POSTGRES_PASSWORD=postgres`,
  `POSTGRES_DB=circuitforge`; data persisted to `postgres-data`.
- **redis** — no auth; data persisted to `redis-data`.
- **minio** — `command: server /data --console-address ":9001"`; root creds
  `MINIO_ROOT_USER=minioadmin` / `MINIO_ROOT_PASSWORD=minioadmin`; data in
  `minio-data`. Console at http://localhost:9001 (minioadmin/minioadmin).
- **create-bucket** — one-shot `minio/mc` init container. Waits for healthy MinIO,
  sets alias `myminio`, creates bucket `circuitforge` (`--ignore-existing`), sets
  anonymous `download` policy on it, then exits 0.
- **api** — env injected directly: `DATABASE_URL` (→ `postgres:5432/circuitforge`),
  `REDIS_URL` (→ `redis:6379`), `S3_ENDPOINT` (→ `http://minio:9000`),
  `S3_ACCESS_KEY`/`S3_SECRET_KEY=minioadmin`, `S3_BUCKET=circuitforge`,
  `S3_REGION=us-east-1`, `S3_FORCE_PATH_STYLE=true`, `JWT_SECRET`,
  `JWT_REFRESH_SECRET`, `NODE_ENV=development`, **`API_PORT=3000`**. Bind-mounts
  `./apps/api` and `./packages` for hot reload, with anonymous volumes preserving
  container `node_modules`.
- **worker-sim** — same DB/Redis/S3 env as api, plus `SIM_TIMEOUT_MS=10000` and
  `SIM_MAX_OUTPUT_BYTES=5242880`, `NODE_ENV=development`. No `JWT_*` (it serves no
  HTTP). Same bind-mount pattern for `./apps/worker-sim` and `./packages`.

> **PORT vs API_PORT (latent mismatch).** Compose sets `API_PORT: 3000` and maps
> `3000:3000`, but the API actually binds the port from **`process.env.PORT`**:
> [main.ts](../apps/api/src/main.ts) line 37 — `const port = process.env.PORT || 3000;`.
> No code reads `API_PORT` anywhere. In Docker it still works only because `PORT`
> is unset and the code falls back to `3000`, which happens to match the published
> port. If you ever set `API_PORT` to something else, the API ignores it. See
> §5 for the local-dev consequence (local `.env` uses `PORT=3001`).

### Dockerfiles

Both Dockerfiles are multi-stage (`base` → `development` / `builder` →
`production`), install `pnpm@8.14.1` globally, and use `pnpm install --frozen-lockfile`.
The compose stack builds the **base/development** stage by default (compose does
not set `target`, so the last-resolved default stage runs; the `CMD` of the
`development` stage is `pnpm run dev`).

**[api.Dockerfile](../infra/docker/api.Dockerfile)** — `node:20-alpine` base.
Copies workspace root files (`pnpm-workspace.yaml`, `package.json`,
`pnpm-lock.yaml*`, `turbo.json`, `tsconfig.base.json`), then `packages/` and
`apps/api/`, then installs deps. `development` stage `CMD ["pnpm","run","dev"]`
from `/app/apps/api`. `builder` runs `pnpm run build --filter=api`. `production`
stage copies the built `dist` + `prisma`, installs `--prod`, runs
`prisma generate`, `EXPOSE 3000`, `CMD ["node","dist/main.js"]`.

**[worker-sim.Dockerfile](../infra/docker/worker-sim.Dockerfile)** — `node:20-alpine`
base that additionally `apk add`s **`ngspice`**, `bash`, `curl` (the SPICE engine
is baked into the image). Copies workspace files + `packages/` + `apps/worker-sim/`,
installs deps. `development` stage `CMD ["pnpm","run","dev"]`. `builder` runs
`pnpm run build --filter=@circuitforge/worker-sim`. `production` stage re-installs
`ngspice` + `bash`, copies built `dist`, installs `--prod`, creates
`/tmp/sim` (`chmod 777`, matches default `SIM_TEMP_DIR`), runs `ngspice --version`
to verify the install, and `CMD ["node","dist/main.js"]`.

---

## 5. Environment Variables

### How env is loaded (important)

All apps run with **CWD = their own package directory** and treat the
**monorepo root `.env` as the single source of truth** (it is also Turbo's
`globalDependencies`). Loading is per-app:

- **worker-sim** — [config.ts](../apps/worker-sim/src/config.ts) does
  `dotenv.config({ path: path.resolve(process.cwd(), '../../.env') })` (root `.env`,
  two levels up), then `dotenv.config()` for an optional per-package override.
  Env is then validated by a Zod schema (process exits on failure).
- **api** — [app.module.ts](../apps/api/src/app.module.ts) `ConfigModule.forRoot`
  with `envFilePath: ['.env.local', '.env', '../../.env']` (per-package files win,
  root `.env` is the fallback).
- **seed** — [seed.ts](../apps/api/prisma/seed.ts) self-loads the root `.env`
  (`resolve(process.cwd(), '../../.env')`) because it runs outside Nest's
  ConfigModule. Existing process env is never clobbered.

In Docker, env vars are injected directly by compose, so the missing root `.env`
file is a harmless no-op.

### Complete reference (every var in [.env.example](../.env.example))

| Variable | Purpose | Default (`.env.example`) | Used by |
|----------|---------|--------------------------|---------|
| `DATABASE_URL` | Postgres connection string (Prisma) | `postgresql://postgres:postgres@localhost:5432/circuitforge` | api (Prisma), worker-sim, seed |
| `REDIS_URL` | Redis connection for BullMQ | `redis://localhost:6379` | api (producer), worker-sim (consumer) |
| `JWT_SECRET` | Signing/verify secret for **access** tokens | `your-super-secret-jwt-key-min-32-characters` | api ([auth.module.ts](../apps/api/src/auth/auth.module.ts), [jwt.strategy.ts](../apps/api/src/auth/strategies/jwt.strategy.ts)) |
| `JWT_REFRESH_SECRET` | Signing/verify secret for **refresh** tokens | `your-super-secret-refresh-key-min-32-characters` | api ([auth.service.ts](../apps/api/src/auth/auth.service.ts)) |
| `JWT_ACCESS_EXPIRES_IN` | Access token TTL | `15m` | api (auth) |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token TTL | `7d` | api (auth) |
| `S3_ENDPOINT` | S3/MinIO endpoint URL | `http://localhost:9000` | api ([assets.service.ts](../apps/api/src/assets/assets.service.ts)), worker-sim |
| `S3_ACCESS_KEY` | S3 access key | `minioadmin` | api, worker-sim |
| `S3_SECRET_KEY` | S3 secret key | `minioadmin` | api, worker-sim |
| `S3_BUCKET` | Bucket for assets + large results | `circuitforge` | api, worker-sim |
| `S3_REGION` | S3 region | `us-east-1` | api, worker-sim |
| `S3_FORCE_PATH_STYLE` | Path-style URLs (required for MinIO) | `true` | api, worker-sim (parsed `=== 'true'`) |
| `SIM_TIMEOUT_MS` | Max wall-clock per ngspice run | `10000` | worker-sim ([config.ts](../apps/worker-sim/src/config.ts)) |
| `SIM_MAX_OUTPUT_BYTES` | Cap on captured/parsed sim output (5 MB) | `5242880` | worker-sim |
| `SIM_TEMP_DIR` | Isolated job working dir | `/tmp/sim` | worker-sim |
| `RATE_LIMIT_TTL` | Rate-limit window (seconds) | `60` | api (see note) |
| `RATE_LIMIT_LIMIT` | Requests allowed per window | `120` | api (see note) |
| `LOG_LEVEL` | pino log level | `info` | api, worker-sim (Zod enum) |
| `NODE_ENV` | Runtime environment | `development` | api, worker-sim |
| `API_PORT` | Intended HTTP port (**not read** — see note) | `3000` | api (latent; see note) |
| `API_HOST` | Intended bind host | `0.0.0.0` | api (declared only) |

Notes / caveats verified against source:

- **`PORT` vs `API_PORT`.** The API binds `process.env.PORT || 3000`
  ([main.ts](../apps/api/src/main.ts)). `API_PORT` (and `API_HOST`) appear in
  `.env.example`/compose but are **not consumed by any code**. Locally,
  `PORT=3001` is set in the working `.env` (port 3000 was taken by another
  project), so the API serves on http://localhost:3001 and Swagger on
  http://localhost:3001/docs. `PORT` is the var that actually matters; treat
  `API_PORT` as documentation only until the code is reconciled.
- **Rate limiting.** `@nestjs/throttler` in
  [app.module.ts](../apps/api/src/app.module.ts) is configured with **hard-coded**
  limiters (`short`: ttl `1000`ms / limit `10`; `medium`: ttl `60000`ms / limit
  `120`). The `RATE_LIMIT_TTL` / `RATE_LIMIT_LIMIT` env vars are not wired into
  that config in the current source — the `medium` limiter mirrors the example
  values by coincidence.
- **Worker-only vars not in `.env.example`.** The worker's Zod schema
  ([config.ts](../apps/worker-sim/src/config.ts)) also accepts `NGSPICE_PATH`
  (default `ngspice`), `QUEUE_NAME` (default `simulations`), and `CONCURRENCY`
  (default `2`). These have working defaults, so they need not be set explicitly.

---

## 6. Local Dev vs Docker

| Concern | Local (pnpm + Turbo) | Docker (compose) |
|---------|----------------------|------------------|
| Package manager | `pnpm` only (`workspace:*`, `npm` breaks) | `pnpm@8.14.1` baked into images |
| Env source | Root `.env` (canonical), loaded by each app two levels up | Vars injected directly by compose; root `.env` file absent → harmless |
| API port | `PORT=3001` in local `.env` → http://localhost:3001 (3000 was taken) | Container binds `PORT` fallback `3000`, published `3000:3000` |
| ngspice | Must be installed on host (e.g. `choco install ngspice -y` on Windows, needs admin) | Baked into the worker-sim image via `apk add ngspice` |
| Backing services | Run `postgres`/`redis`/`minio` via compose (or local installs) and point `.env` at `localhost` | `postgres` / `redis` / `minio` run as compose services with internal DNS names |
| S3 endpoint | `http://localhost:9000` | `http://minio:9000` |
| Redis/DB hosts | `localhost:6379` / `localhost:5432` | `redis:6379` / `postgres:5432` |
| Bucket bootstrap | Create `circuitforge` bucket manually in MinIO console | `create-bucket` init container does it automatically |
| Run mode | `pnpm dev` → Turbo runs `nest start --watch` (api) and `tsx watch` (worker) | `development` stage `CMD pnpm run dev`, source bind-mounted for hot reload |
| DB schema | `pnpm db:migrate:dev` + `pnpm db:seed` against local Postgres | Run the same `db:*` tasks against the compose Postgres |

Demo seed data ([seed.ts](../apps/api/prisma/seed.ts)): user
`demo@circuitforge.io` / `demo123456`, org id `demo-org-id`, 5 templates, and a
project "My First Circuit" (v1).

A version-based transient simulation has been run end-to-end locally and
succeeded — `ngspice` produced an `output.csv` that the worker parsed via
`eda-core`.

---

## See also

- [README.md](../README.md)
- [API.md](API.md)
- [DATA_MODEL.md](DATA_MODEL.md)
- [EDA_CORE.md](EDA_CORE.md)
- [SIMULATION.md](SIMULATION.md)
- [SECURITY.md](SECURITY.md)
- [LOCAL_SETUP.md](../LOCAL_SETUP.md)
