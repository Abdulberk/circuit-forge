# Local Setup (Windows)

Verified working setup for running Circuit Forge locally. **This repo is pnpm-only — never use `npm`** (the `workspace:*` deps crash npm).

## Prerequisites

- Node.js **≥ 22**, pnpm 8 (`pnpm -v`)
  Node 22 is not optional: `pnpm dev` starts `apps/pcb-worker`, which declares `engines.node >= 22`, and
  tscircuit's autorouter (used by the PCB pipeline) calls iterator-helper methods that only exist in 22+.
- Docker Desktop (running)
- ngspice — required only for simulations to actually produce results (see below)

## First-time setup

```powershell
cp .env.example .env                      # REQUIRED — .env is gitignored, a fresh clone has none
pnpm install                              # never `npm install`
docker compose up -d postgres redis minio create-bucket
pnpm db:migrate:dev                       # see the note below if this fails with P1012
pnpm db:seed                              # demo data (optional)
pnpm dev
```

Two things in that block are easy to skip and both stop the stack dead:

**`.env` is mandatory, and its secrets are validated.** The API refuses to boot unless `JWT_SECRET` and
`JWT_REFRESH_SECRET` are each **≥ 32 characters and different from each other** — a shared secret would let
an access token be replayed as a refresh token. It exits with `Invalid environment configuration — refusing
to start` rather than running in a weak state (`apps/api/src/config/env.validation.ts`). Generate them with
`openssl rand -base64 48`.

**`create-bucket` is not optional.** Nothing in the application code ever creates the `circuitforge` bucket;
that one-shot compose service does it and exits. Without it `/health/ready` returns 503 and every upload
fails against a bucket that does not exist.

### If `pnpm db:migrate:dev` fails with Prisma P1012

The Prisma CLI runs with its cwd inside `apps/api` and does **not** read the monorepo-root `.env`, so it
cannot see `DATABASE_URL`. Either create `apps/api/.env` with just that line, or export it in the shell
first. This affects the `db:migrate*` / `db:studio` family only — `pnpm db:seed` works, because
`prisma/seed.ts` hand-parses the root `.env` itself.

Demo credentials (from seed): `demo@circuitforge.io` / `demo123456`

## Daily run

Once the infra containers exist, just:

```powershell
docker compose up -d postgres redis minio   # if not already running
pnpm dev
```

`pnpm dev` starts **six** workspace packages: `api`, `worker-sim`, `pcb-worker`, and the three
libraries in watch mode (`eda-core`, `llm-core`, `pcb-core`).

`pcb-viewer` is NOT among them. It is deliberately excluded from the pnpm workspace so its React 18
never meets the React 19 that tscircuit requires, which also means turbo cannot see it. Run it on its
own:

```bash
cd apps/pcb-viewer
pnpm install --ignore-workspace   # once
pnpm dev                          # http://localhost:3100
```

## PCB layout worker (optional)

The PCB pipeline runs in its own container because it needs KiCad and freerouting (~3 GB of image). Build it
in **this order** — compose cannot infer it, and building `pcb-worker` first fails with a missing-image
error that reads like a registry problem:

```powershell
docker compose build pcb-runtime pcb-worker
docker compose up -d pcb-worker
```

`pcb-runtime` is a build stage, not a service: it carries the digest-pinned kicad-cli and freerouting that
`pcb-worker` is built `FROM`, and it is behind the `build-only` compose profile so it never runs.

## Endpoints

The API port comes from `PORT` in `.env`. **`.env.example` ships `PORT=3000`**, so the URLs below use 3000;
if you set `PORT=3001` (see Port conflicts), substitute accordingly. `API_PORT` in code is unused.

- API: http://localhost:3000
- Swagger: http://localhost:3000/docs — in production this is gated behind `ENABLE_SWAGGER`
- Liveness: `/health/live` · Health: `/health` · Readiness: `/health/ready`
  Readiness probes **Postgres, Redis and S3** and returns **503** when any of them is down — it is not a
  DB-only check.
- MinIO console: http://localhost:9001  (minioadmin / minioadmin)

## ngspice (simulations)

The simulation worker shells out to `ngspice`. Without it, jobs run end to end and come back
**inconclusive, not failed**: the runner reports `ngspice could not be launched (check NGSPICE_PATH /
sandbox)` and flags the result as infrastructure (`infra: true`), so a missing binary never masquerades as a
design fault.

Install it in an **Administrator** PowerShell:

```powershell
choco install ngspice -y
```

**Then set `NGSPICE_PATH` explicitly — this step is not optional on Windows:**

```
NGSPICE_PATH=C:\ProgramData\chocolatey\lib\ngspice\tools\Spice64\bin\ngspice_con.exe
```

The `ngspice` that chocolatey puts on `PATH` is a **shim for the GUI build**. It launches, exits 0, and
writes no output — so simulations "succeed" with empty results. That is the worst failure mode in this
stack, because it looks like success. `ngspice_con.exe` is the console build and is the one that works.

Restart the terminal after installing, then re-run `pnpm dev`.

## Port conflicts

Defaults collide with some other local projects:

| Port | Service        | Notes |
|------|----------------|-------|
| 5432 | Postgres       | also used by another project's `streaming-postgres` |
| 6379 | Redis          | also used by another project's `streaming-redis` |
| 3000 | api (default)  | if something else holds it (e.g. `my-portfolio`), set `PORT=3001` in `.env` |

Two projects can't bind the same host port simultaneously. To switch back to the other stack:
`docker stop circuitforge-postgres circuitforge-redis` then `docker start streaming-postgres streaming-redis`.

## Troubleshooting

- **api exits with `Invalid environment configuration`** — `.env` is missing, or the two JWT secrets are
  short/identical. See First-time setup.
- **`/health/ready` returns 503** — Postgres, Redis or S3 is unreachable. If everything is up, you probably
  skipped `create-bucket`.
- **`npm error Cannot read properties of null (reading 'matches')`** — you ran `npm`. Use `pnpm`.
- **`EEXIST ... @pnpm\exe\pnpm.exe` on `pnpm dev`** — intermittent race in the standalone pnpm
  self-install when turbo starts all `dev` tasks at once. Run a single `pnpm install` first, then `pnpm dev`.
- **worker-sim `Configuration validation failed`** — it must load the monorepo root `.env`
  (already wired up in `apps/worker-sim/src/config.ts`).
- **api `EADDRINUSE :::3000`** — something else holds 3000; set a different `PORT` in `.env`.
- **Simulations return empty results on Windows** — the choco `ngspice` GUI shim. Set `NGSPICE_PATH` to
  `ngspice_con.exe` as above.
