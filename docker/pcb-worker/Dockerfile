# pcb-worker SERVICE image (LAYOUTJOB_PLAN.md M3/M4) — the pcb-runtime toolchain (kicad-cli + Temurin JRE
# + freerouting.jar + Node 22) with a self-contained @circuitforge/pcb-worker baked in. It consumes the
# 'pcb-layout' BullMQ queue and runs pcb-core's quality pipeline natively (freerouting + kicad-cli),
# uploading GLB/Gerbers to S3 and landing the LayoutJob row — the whole path proven in M3a.
#
# Build (context = repo root, so the pnpm workspace + lockfile + the API Prisma schema are all visible):
#   docker build -f docker/pcb-worker/Dockerfile -t pcb-worker:local .

# ---- builder: install pcb-worker + deps, generate the Prisma client, build, then deploy self-contained ----
FROM node:22-bookworm-slim AS builder
# openssl: Prisma needs it to pick the query-engine libssl variant (silences the detect warning + wrong engine).
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@8.14.1 --activate
WORKDIR /src
COPY . .
# Retry: a transitive dep (sharp) fetches a platform binary in postinstall and flakes on the network.
RUN for i in 1 2 3; do \
      pnpm install --frozen-lockfile --filter "@circuitforge/pcb-worker..." && exit 0; \
      echo "pnpm install attempt $i failed — retrying in 5s"; sleep 5; \
    done; echo "pnpm install failed after 3 attempts"; exit 1
# Build the workspace deps in order, generate the Prisma client from the API schema (the worker imports
# @prisma/client), build the worker, then `pnpm deploy` a symlink-free, prod-only bundle (INCLUDES the
# generated .prisma/client since generate ran first).
RUN pnpm --filter "@circuit-forge/eda-core" build \
 && pnpm --filter "@circuit-forge/pcb-core" build \
 && pnpm --filter "@circuitforge/pcb-worker" exec prisma generate --schema=../../apps/api/prisma/schema.prisma \
 && pnpm --filter "@circuitforge/pcb-worker" build \
 && pnpm --filter "@circuitforge/pcb-worker" deploy --prod /deploy

# ---- runtime: toolchain + the deployed worker ----
FROM pcb-runtime:local
WORKDIR /app/pcb-worker
COPY --from=builder /deploy /app/pcb-worker
# The Prisma client must be (re)generated INTO the deployed bundle: `pnpm deploy` copies @prisma/client
# from the store WITHOUT the generated `.prisma/client` output (generate had mutated the source copy, not
# the store) → the bundle throws "@prisma/client did not initialize". Regenerating here also produces the
# query engine for the RUNTIME OS (kicad base), not the builder's. The schema must live UNDER the worker
# dir so Prisma infers the project root as /app/pcb-worker (nearest package.json) and finds @prisma/client
# in its node_modules — a sibling /app/prisma makes root=/app with no node_modules → "Could not resolve".
COPY --from=builder /src/apps/api/prisma /app/pcb-worker/prisma
RUN npx --yes prisma@5.22.0 generate --schema=prisma/schema.prisma
# NODE_ENV=production → pino JSON logs (no pino-pretty dep needed at runtime).
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
