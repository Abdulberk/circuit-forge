# API Dockerfile
FROM node:20-alpine AS base

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

# Install dependencies
RUN pnpm install --frozen-lockfile

# Development stage
FROM base AS development
ENV NODE_ENV=development
WORKDIR /app/apps/api
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