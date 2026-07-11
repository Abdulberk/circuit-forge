# Worker Simulation Dockerfile with ngspice
# Alpine base PINNED to a minor (3.23) so the ngspice the worker ships is DETERMINISTIC — a bare `node:20-alpine`
# floats the Alpine repo and silently changed the ngspice version under us (the repo has been burned by
# only-in-CI ngspice drift before). alpine 3.23 ships ngspice-45.2 (KLU solver); CI's `matrix-alpine` job runs
# the real-ngspice coverage matrix against THIS exact base, so a bump here is an explicit, matrix-verified change.
FROM node:20-alpine3.23 AS base

# ngspice + bash (the rlimit wrapper uses bash); curl for local debugging; openssl for the Prisma query
# engine (musl needs libssl to be detectable); bubblewrap for the OPTIONAL namespace isolation of the
# ngspice child (only active when SIM_BWRAP=1 + the host allows unprivileged userns). No su-exec: the
# worker runs entirely as a single non-root user (see the production stage), so there is no second-user drop.
RUN apk add --no-cache \
    ngspice \
    bash \
    curl \
    openssl \
    bubblewrap

# Install pnpm
RUN npm install -g pnpm@8.14.1

WORKDIR /app

# Copy workspace files
COPY pnpm-workspace.yaml ./
COPY package.json ./
COPY pnpm-lock.yaml* ./
COPY turbo.json ./
COPY tsconfig.base.json ./

# Copy package directories
COPY packages/ ./packages/
COPY apps/worker-sim/ ./apps/worker-sim/
# The Prisma schema lives in the API package; the worker shares the generated client and has no schema of
# its own. Copy it into the worker's OWN default location (apps/worker-sim/prisma) so `prisma generate`
# infers the worker package as the project root — which lists prisma + @prisma/client, so Prisma's
# auto-install-on-generate does not trip (it would, and fail, if the schema sat under apps/api with no
# package.json beside it).
COPY apps/api/prisma/ ./apps/worker-sim/prisma/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Generate the Prisma client explicitly. The @prisma/client postinstall couldn't find the schema during
# install, so without this the worker's `tsc` fails — Prisma.InputJsonValue / Prisma.JsonNull don't exist
# on an ungenerated client. `--filter` runs it in the worker package dir, where prisma + @prisma/client
# resolve and the schema is at the default ./prisma/schema.prisma.
RUN pnpm --filter @circuitforge/worker-sim exec prisma generate --schema=prisma/schema.prisma

# Development stage
FROM base AS development
ENV NODE_ENV=development
WORKDIR /app/apps/worker-sim
CMD ["pnpm", "run", "dev"]

# Build stage
FROM base AS builder
RUN pnpm run build --filter=@circuitforge/worker-sim

# Production stage
# Same PINNED Alpine minor as the base stage above — the running container's ngspice must be the deterministic
# one the coverage matrix is verified against (see the base-stage note + CI's matrix-alpine job).
FROM node:20-alpine3.23 AS production

# ngspice + bash (the rlimit wrapper uses bash); openssl for the Prisma query engine (musl libssl);
# bubblewrap for the OPTIONAL ngspice-child namespace isolation (active only when SIM_BWRAP=1 + the host
# permits unprivileged userns). No su-exec — the whole worker runs as one non-root user.
RUN apk add --no-cache \
    ngspice \
    bash \
    openssl \
    bubblewrap

# Single dedicated NON-ROOT user the ENTIRE worker (and therefore the ngspice child it spawns) runs as.
# Running the worker process itself unprivileged is stronger than the old model (root worker dropping only
# the child to a second user via su-exec). With one uid there is no su-exec, so SIM_SANDBOX_USER is
# intentionally NOT set — setting it would make the spawn wrapper attempt a privilege drop a non-root
# process cannot perform.
RUN adduser -D -H -s /sbin/nologin ngsim
# RLIMIT_NPROC headroom: with a single uid the node worker's own threads share the per-uid process budget
# with the sim (the old dropped 'simrunner' had its own budget). The container-level pids_limit
# (docker-compose.yml) is the real hard ceiling; this just keeps the per-process cap from false-tripping.
ENV SIM_SANDBOX_NPROC=256

RUN npm install -g pnpm@8.14.1

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/pnpm-lock.yaml* ./
COPY --from=builder /app/packages/ ./packages/
COPY --from=builder /app/apps/worker-sim/dist ./apps/worker-sim/dist
COPY --from=builder /app/apps/worker-sim/package.json ./apps/worker-sim/

RUN pnpm install --frozen-lockfile --prod

# The --prod install omits the prisma CLI (a devDep) and so can't regenerate the client. Bring the client
# generated in the builder stage instead (same locked versions → identical pnpm virtual-store path). This
# includes the linux-musl query engine; `openssl` (installed above) lets it load libssl at runtime.
COPY --from=builder /app/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/.prisma /app/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/.prisma

ENV NODE_ENV=production
WORKDIR /app/apps/worker-sim

# Per-job temp root, OWNED BY the unprivileged worker user (default perms — the same uid writes both
# circuit.cir and output.csv, so the old world-writable 0777 two-user workaround is gone). A read-only-root
# deploy overlays this with a tmpfs at runtime (see docker-compose.yml); the chown covers deploys that don't.
RUN mkdir -p /tmp/sim && chown ngsim:ngsim /tmp/sim

# Verify ngspice installation
RUN ngspice --version

# Drop privileges for the running container: everything above needed root (apk, pnpm, chown); the worker
# process does not. From here the worker — and the ngspice it spawns — run as the unprivileged ngsim.
USER ngsim
CMD ["node", "dist/main.js"]