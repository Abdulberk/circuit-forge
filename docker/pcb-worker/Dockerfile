# pcb-worker image (LAYOUTJOB_PLAN.md M3) — the toolchain image (pcb-runtime) with a self-contained
# pcb-core baked in, so layoutCircuit(router:'quality') runs the FULL native pipeline in-container:
# adapter → tscircuit eval → NATIVE freerouting (java -jar) → mergeSes → NATIVE kicad-cli DRC + GLB.
#
# Two stages:
#   • builder — node:22, pnpm-installs ONLY what pcb-core needs, builds eda-core+pcb-core, then
#     `pnpm deploy` produces a symlink-free, self-contained node_modules (portable across the stage
#     boundary — a plain COPY of pnpm's symlinked store would break).
#   • runtime — FROM pcb-runtime (kicad-cli + Temurin25 + Node22 + freerouting.jar, digest-pinned)
#     with the deployed pcb-core + the native runners copied in.
#
# Build (context = repo root, so the whole pnpm workspace + lockfile are visible):
#   docker build -f docker/pcb-worker/Dockerfile -t pcb-worker:local .

# ---- builder: deploy a self-contained pcb-core (dist + resolved prod deps, no symlinks) ----
FROM node:22-bookworm-slim AS builder
RUN corepack enable && corepack prepare pnpm@8.14.1 --activate
WORKDIR /src
COPY . .
# Retry the install: a transitive dep (sharp, via @tscircuit/eval) fetches a platform binary in
# postinstall and that download flakes/aborts on the network — one retry clears it.
RUN for i in 1 2 3; do \
      pnpm install --frozen-lockfile --filter "@circuit-forge/pcb-core..." && exit 0; \
      echo "pnpm install attempt $i failed — retrying in 5s"; sleep 5; \
    done; echo "pnpm install failed after 3 attempts"; exit 1
# eda-core FIRST (pcb-core resolves its types via the node_modules symlink → dist/index.d.ts), then pcb-core.
RUN pnpm --filter "@circuit-forge/eda-core" build \
 && pnpm --filter "@circuit-forge/pcb-core" build \
 && pnpm --filter "@circuit-forge/pcb-core" deploy --prod /deploy

# ---- runtime: toolchain + baked pcb-core + native runners ----
FROM pcb-runtime:local
WORKDIR /app
COPY --from=builder /deploy /app/pcb-core
COPY scripts/lib/freerouting-native.mjs scripts/lib/kicad-native.mjs /app/runners/
COPY scripts/verify-native-composition.mjs /app/verify-native-composition.mjs
ENV PCB_CORE_DIST=/app/pcb-core/dist/index.js \
    PCB_RUNNERS_DIR=/app/runners
