# Worker Simulation Dockerfile with ngspice
FROM node:20-alpine AS base

# Install ngspice and required tools
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

# Install ngspice in production image
RUN apk add --no-cache \
    ngspice \
    bash

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

# Create temp directory for simulations
RUN mkdir -p /tmp/sim && chmod 777 /tmp/sim

# Verify ngspice installation
RUN ngspice --version

CMD ["node", "dist/main.js"]