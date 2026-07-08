#!/bin/sh
# API dev-container entrypoint. Regenerates the Prisma client against the (source-mounted) schema before
# starting, so a schema change on the host is picked up WITHOUT rebuilding the image — the exact pain that
# made `docker compose up api` fail after a schema-changing merge (stale baked client → "did not initialize"
# / 98 phantom type errors). Idempotent and fast; if it fails we log and continue so nest surfaces the real
# error rather than the entrypoint masking it. WORKDIR is /app/apps/api (set in the Dockerfile).
set -e
echo "[api-dev-entrypoint] prisma generate (sync client to current schema)…"
# Fail fast (set -e) — a broken schema surfaces HERE with the real Prisma error, instead of being swallowed
# and re-appearing later as a confusing nest bootstrap failure.
pnpm exec prisma generate
exec "$@"
