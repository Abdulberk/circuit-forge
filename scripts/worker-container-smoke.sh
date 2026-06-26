#!/usr/bin/env bash
# Worker CONTAINER smoke test — proves the PRODUCTION worker image actually works under its hardened runtime
# (read-only root, non-root ngsim, cap-drop ALL, no-new-privileges), not just on a dev box. It builds the
# production stage, runs it joined to the running compose infra (Postgres/Redis/MinIO) with a real LLM key,
# verifies the hardening is active, then enqueues a real design job and asserts the CONTAINER verified it
# (real Claude + ngspice inside the cage).
#
# Why this exists: a hardened container can fail in ways a dev `node` run never will — a path assumed writable
# is read-only, a missing env var silently changes the LLM endpoint, ngspice can't spawn as non-root. This
# script is the pre-prod gate the Dockerfile asks for ("confirm read_only + USER ngsim with a smoke-test").
#
# Requires: Docker, the compose infra up (docker compose up -d postgres redis minio), and root .env with a
# valid LLM_API_KEY + LLM_BASE_URL matching that key's provider. Usage (from repo root):
#   bash scripts/worker-container-smoke.sh            # build + run + assert + teardown
#   SKIP_BUILD=1 bash scripts/worker-container-smoke.sh   # reuse an existing cf-worker-smoke:latest image
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=cf-worker-smoke:latest
NAME=cf-worker-smoke
fail=0
say() { printf '%s\n' "$*"; }
check() { if [ "$1" = "0" ]; then say "  PASS $2"; else say "  FAIL $2"; fail=1; fi; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# --- secrets/config from .env (first occurrence; the value is never printed) ---
KEY=$(grep -m1 '^LLM_API_KEY=' .env | sed 's/^LLM_API_KEY=//' | tr -d '\r"')
BASE=$(grep -m1 '^LLM_BASE_URL=' .env | sed 's/^LLM_BASE_URL=//' | tr -d '\r"')
MODEL=$(grep -m1 '^LLM_MODEL=' .env | sed 's/^LLM_MODEL=//' | tr -d '\r"')
[ -n "$KEY" ] || { say "ERROR: LLM_API_KEY missing from .env"; exit 1; }
say "config: keylen=${#KEY} base=${BASE:-<llm-core default>} model=${MODEL:-<default>}"
# LLM_BASE_URL MUST match the key's provider. llm-core defaults to a gateway when unset — pass it through so a
# direct-Anthropic key isn't silently sent to the gateway (the exact gap this smoke test originally caught).

# --- compose network (project-prefixed; detect it) ---
NET=$(docker network ls --format '{{.Name}}' | grep -E 'circuit.?forge_default' | head -1)
[ -n "$NET" ] || { say "ERROR: compose network not found — is the infra up?"; exit 1; }
say "network: $NET"

# --- build the production image ---
if [ "${SKIP_BUILD:-0}" = "1" ]; then
    say "build: skipped (SKIP_BUILD=1)"
else
    say "build: docker build --target production ..."
    docker build -f infra/docker/worker-sim.Dockerfile --target production -t "$IMAGE" . >/dev/null
fi

# --- run the hardened container (mirrors docker-compose.yml's hardening) ---
cleanup
docker run -d --name "$NAME" \
    --network "$NET" --read-only \
    --tmpfs /tmp:mode=1777 --tmpfs /tmp/sim:mode=1777 \
    --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 2g \
    -e DATABASE_URL=postgresql://postgres:postgres@postgres:5432/circuitforge \
    -e REDIS_URL=redis://redis:6379 \
    -e S3_ENDPOINT=http://minio:9000 -e S3_ACCESS_KEY=minioadmin -e S3_SECRET_KEY=minioadmin \
    -e S3_BUCKET=circuitforge -e S3_REGION=us-east-1 -e S3_FORCE_PATH_STYLE=true \
    -e LLM_MODEL="$MODEL" -e LLM_BASE_URL="$BASE" -e LLM_API_KEY="$KEY" \
    "$IMAGE" >/dev/null

# --- wait for boot (or early exit) ---
for _ in $(seq 1 30); do
    docker logs "$NAME" 2>&1 | grep -q "Design worker started" && break
    docker ps --format '{{.Names}}' | grep -q "$NAME" || { say "  FAIL container exited during boot"; docker logs "$NAME" 2>&1 | tail -20; exit 1; }
    sleep 1
done

say "== boot =="
logs=$(docker logs "$NAME" 2>&1)
echo "$logs" | grep -q "Database connected"     ; check $? "database connected"
echo "$logs" | grep -q "Simulation worker started"; check $? "simulation worker started"
echo "$logs" | grep -q "Design worker started"  ; check $? "design worker started (LLM key wired)"
echo "$logs" | grep -q "reaper started"         ; check $? "orphan reaper started"

say "== hardening =="
[ "$(docker exec "$NAME" id -u)" != "0" ]; check $? "runs as a non-root user"
docker exec "$NAME" sh -c 'echo x > /app/canary' 2>/dev/null && rc=1 || rc=0 ; check $rc "root filesystem is read-only (write to /app blocked)"
docker exec "$NAME" sh -c 'echo x > /tmp/sim/c && rm /tmp/sim/c' >/dev/null 2>&1; check $? "ngspice job dir /tmp/sim is writable (tmpfs)"

say "== real design job (container is the worker) =="
( cd apps/worker-sim && node scripts/enqueue-design.mjs ) ; check $? "container verified a real design job (Claude + ngspice in the cage)"

say ""
if [ "$fail" = "0" ]; then say "WORKER CONTAINER SMOKE: ALL CHECKS PASSED"; else say "WORKER CONTAINER SMOKE: FAILURES ABOVE"; fi
exit "$fail"
