# Worker Simulation Dockerfile with ngspice
FROM node:20-alpine AS base

# ngspice + bash (the rlimit wrapper uses bash); curl for local debugging. No su-exec: the worker now
# runs entirely as a single non-root user (see the production stage), so there is no second-user drop.
RUN apk add --no-cache \
    ngspice \
    bash \
    curl

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

# Install dependencies
RUN pnpm install --frozen-lockfile

# Development stage
FROM base AS development
ENV NODE_ENV=development
WORKDIR /app/apps/worker-sim
CMD ["pnpm", "run", "dev"]

# Build stage
FROM base AS builder
RUN pnpm run build --filter=@circuitforge/worker-sim

# Production stage
FROM node:20-alpine AS production

# ngspice + bash (the rlimit wrapper uses bash). No su-exec — the whole worker runs as one non-root user.
RUN apk add --no-cache \
    ngspice \
    bash

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