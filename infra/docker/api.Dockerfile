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

# Copy package directories — only the shared packages + api itself (the same partial-workspace layout
# worker-sim.Dockerfile uses; a plain frozen install links api's full dependency tree from the lockfile).
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/

# Install dependencies (partial workspace + frozen lockfile — identical shape to worker-sim.Dockerfile).
RUN pnpm install --frozen-lockfile

# Build api's WORKSPACE DEPENDENCIES so their dist (*.js + *.d.ts) exists in the image. The .dockerignore
# excludes **/dist, so only source is copied; without a build @circuit-forge/eda-core has no dist → its
# types resolve to `any` and `require('zod')` from its dist fails at runtime. Only api's ACTUAL deps are
# built (eda-core + llm-core), NOT ./packages/* — that would also build pcb-core's heavy tscircuit/React
# toolchain, which api never imports. Baking these lets the compose service drop the ./packages bind-mount,
# whose pnpm junction symlinks (Windows host) don't resolve in the Linux container — the break's root cause.
RUN pnpm --filter @circuit-forge/eda-core --filter @circuitforge/llm-core run build

# Generate the Prisma client IN BASE so every downstream stage has it (this was the load-bearing bug:
# generate lived only in the prod stage, AFTER the builder's `nest build` had already compiled against an
# ungenerated @prisma/client → "did not initialize" / "has no exported member" → build failed outright).
# Matches worker-sim.Dockerfile, which likewise generates in its base stage before the builder.
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