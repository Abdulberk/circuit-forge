# Local Setup (Windows)

Verified working setup for running Circuit Forge locally. **This repo is pnpm-only — never use `npm`** (the `workspace:*` deps crash npm).

## Prerequisites

- Node.js ≥ 20, pnpm 8 (`pnpm -v`)
- Docker Desktop (running)
- ngspice — required only for simulations to actually produce results (see below)

## First-time setup

```powershell
pnpm install                              # never `npm install`
docker compose up -d postgres redis minio # Postgres 5432 / Redis 6379 / MinIO 9000
pnpm db:migrate:dev                        # apply DB schema
pnpm db:seed                               # demo data (optional)
pnpm dev                                   # start all 4 packages
```

Demo credentials (from seed): `demo@circuitforge.io` / `demo123456`

## Daily run

Once the infra containers exist, just:

```powershell
docker compose up -d postgres redis minio   # if not already running
pnpm dev
```

## Endpoints

- API: http://localhost:3001  (port set via `PORT` in `.env`; `API_PORT` in code is unused)
- Swagger: http://localhost:3001/docs
- Health: http://localhost:3001/health  ·  readiness (DB): `/health/ready`
- MinIO console: http://localhost:9001  (minioadmin / minioadmin)

## ngspice (simulations)

The simulation worker shells out to `ngspice`. Without it, jobs run end-to-end but fail with
`ngspice exited with code 1` (spawn-not-found). Install it in an **Administrator** PowerShell:

```powershell
choco install ngspice -y
```

Then restart the terminal so `ngspice` is on `PATH`, and re-run `pnpm dev`.

## Port conflicts

Defaults collide with some other local projects:

| Port | Service        | Notes |
|------|----------------|-------|
| 5432 | Postgres       | also used by another project's `streaming-postgres` |
| 6379 | Redis          | also used by another project's `streaming-redis` |
| 3000 | (api default)  | taken by `my-portfolio` → api moved to **3001** via `PORT` in `.env` |

Two projects can't bind the same host port simultaneously. To switch back to the other stack:
`docker stop circuitforge-postgres circuitforge-redis` then `docker start streaming-postgres streaming-redis`.

## Troubleshooting

- **`npm error Cannot read properties of null (reading 'matches')`** — you ran `npm`. Use `pnpm`.
- **`EEXIST ... @pnpm\exe\pnpm.exe` on `pnpm dev`** — intermittent race in the standalone pnpm
  self-install when turbo starts all `dev` tasks at once. Run a single `pnpm install` first, then `pnpm dev`.
- **worker-sim `Configuration validation failed`** — it must load the monorepo root `.env`
  (already wired up in `apps/worker-sim/src/config.ts`).
- **api `EADDRINUSE :::3000`** — something else holds 3000; set a different `PORT` in `.env`.
