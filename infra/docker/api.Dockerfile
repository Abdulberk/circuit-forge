# API Dockerfile
FROM node:20-alpine AS base

# openssl: the Prisma query engine needs libssl. Without it on Alpine (musl), Prisma "fails to detect the
# libssl version", defaults to the openssl-1.1.x musl engine, and then can't load it (libssl.so.1.1 absent)
# → PrismaClientInitializationError at $connect, crashing the app on boot. `apk add openssl` (3.x) lets
# Prisma pick the linux-musl-openssl-3.0.x engine. (worker-sim.Dockerfile installs openssl for the same reason.)
RUN apk add --no-cache openssl

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
COPY apps/api/ ./apps/api/
# Complete the workspace MANIFEST set (the other apps' package.json — packages/* already copied above) so
# `pnpm install` resolves the IDENTICAL dependency graph as a local full-workspace install. With a PARTIAL
# workspace (only api present), pnpm picks different peer-resolved variants of some type-only deps, and the
# container's tsc then widens them to `any` → `nest start --watch` reports phantom TS7006 errors a local
# build never sees AND leaves @opentelemetry/sdk-logs unlinked (runtime MODULE_NOT_FOUND). Manifests only —
# no source — since install just needs them for the graph (neither app has a prepare/postinstall script).
COPY apps/worker-sim/package.json ./apps/worker-sim/
COPY apps/pcb-worker/package.json ./apps/pcb-worker/

# Install dependencies (full graph → matches local exactly).
RUN pnpm install --frozen-lockfile

# Build the workspace PACKAGES so their dist (*.js + *.d.ts) exists IN THE IMAGE. The .dockerignore excludes
# **/dist, so only package SOURCE is copied — without a build, @circuit-forge/eda-core has no dist, so its
# types resolve to `any` (tsc cascade) and `require('zod')` from its dist fails at runtime. Baking the built
# packages also lets the compose service DROP the ./packages bind-mount: a Windows-host mount brings pnpm's
# junction symlinks, which don't resolve inside the Linux container (the root cause of the dev-container break).
RUN pnpm -r --filter "./packages/*" run build

# Generate the Prisma client IN BASE so every downstream stage has it. This was the load-bearing bug:
# generate lived only in the prod stage AFTER the build, so the `builder` stage's `nest build` (and dev's
# `nest start --watch`) compiled against an ungenerated @prisma/client → "@prisma/client did not initialize"
# / dozens of phantom "has no exported member" errors → `docker compose build api` failed outright.
RUN pnpm --filter api exec prisma generate

# Development stage
FROM base AS development
ENV NODE_ENV=development
WORKDIR /app/apps/api
# The dev entrypoint regenerates the client on start (base already generated it once) so a schema edited
# through the source mount is picked up without an image rebuild.
COPY infra/docker/api-dev-entrypoint.sh /usr/local/bin/api-dev-entrypoint.sh
RUN chmod +x /usr/local/bin/api-dev-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/api-dev-entrypoint.sh"]
CMD ["pnpm", "run", "dev"]

# Build stage
FROM base AS builder
RUN pnpm run build --filter=api

# Production stage
FROM node:20-alpine AS production
RUN npm install -g pnpm@8.14.1

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/pnpm-lock.yaml* ./
COPY --from=builder /app/packages/ ./packages/
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma

RUN pnpm install --frozen-lockfile --prod

ENV NODE_ENV=production
WORKDIR /app/apps/api

# Generate Prisma client
RUN pnpm exec prisma generate

EXPOSE 3000
CMD ["node", "dist/main.js"]