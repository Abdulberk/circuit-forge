# Observability Reference

This document describes the telemetry Circuit Forge emits **as implemented in the source tree**, how to
turn it on, and what to alert on. Every claim is tied to a specific file.

Telemetry is built on [OpenTelemetry](https://opentelemetry.io/) and is **inert by default** — the SDK
does not start, and there is zero runtime overhead, until you configure it. This mirrors the rest of the
system's "configure to activate" philosophy (quotas, email, sandbox).

| Concern | Where it lives |
|---------|----------------|
| API bootstrap (traces + metrics) | [apps/api/src/observability/telemetry.ts](../apps/api/src/observability/telemetry.ts), started by [instrumentation.ts](../apps/api/src/observability/instrumentation.ts) |
| Worker bootstrap + custom sim metrics | [apps/worker-sim/src/observability/telemetry.ts](../apps/worker-sim/src/observability/telemetry.ts), started by [instrumentation.ts](../apps/worker-sim/src/observability/instrumentation.ts) |

---

## 1. Enabling it

The SDK starts only when **either** of these is set (see `telemetryEnabled()`):

- `OTEL_ENABLED=true`, or
- `OTEL_EXPORTER_OTLP_ENDPOINT=<url>` (a base OTLP/HTTP URL, e.g. `http://localhost:4318`).

With neither set, `startTelemetry()` returns immediately — no SDK, no exporters, no listeners.

| Variable | Default | Meaning |
|----------|---------|---------|
| `OTEL_ENABLED` | (unset) | `true` turns telemetry on without needing an endpoint (uses the OTLP default `http://localhost:4318`). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (unset) | Base OTLP/HTTP URL. The exporters append `/v1/traces` and `/v1/metrics`. Setting this alone also enables telemetry. |
| `OTEL_SERVICE_NAME` | `circuit-forge-api` / `circuit-forge-worker` | Overrides the per-app `service.name` on all spans/metrics. |
| `OTEL_METRIC_EXPORT_INTERVAL_MS` | `30000` | How often metrics are pushed to the collector. |
| `OTEL_DEBUG` | `false` | `true` logs OTel SDK diagnostics to the console (use when wiring up a collector). |

These are also documented in [.env.example](../.env.example). Standard OTLP env vars
(`OTEL_EXPORTER_OTLP_HEADERS` for auth, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, etc.) are honored by the
exporters directly — we don't intercept them.

### Load order

`startTelemetry()` must run **before any instrumented module is loaded**, otherwise auto-instrumentation
can't patch `http`/`express`/`ioredis`. That is why the side-effecting call lives in
`observability/instrumentation.ts`, which is the **first import** in each app's `main.ts`. Don't reorder
those imports. (Both apps compile to CommonJS, so the first `require` fully evaluates — SDK started —
before the next import runs.)

---

## 2. What it emits

### 2.1 Traces (auto-instrumented)

Via `getNodeAutoInstrumentations()`. With the SDK on you get spans for, among others:

- **HTTP / Express / NestJS** on the API — every REST request: route, status code, latency (plus the
  matching `http.server.duration` metric).
- **Outgoing HTTP** from the API — its calls to the TME parts catalog and the LLM provider (client spans).
- **ioredis / Redis commands** on both apps (incl. the BullMQ enqueue ops on the API side).
- **Simulation job span (distributed).** The worker opens a `sim.process` span per job
  ([processor.ts](../apps/worker-sim/src/simulation/processor.ts)), and the API injects W3C trace context
  into the queued job ([simulation.service.ts](../apps/api/src/simulation/simulation.service.ts)), so a
  verify-design / simulate is **one end-to-end trace**: `POST /verify-design` → ioredis enqueue → worker
  `sim.process` (with the ngspice run inside). **Verified live.**

The `fs` instrumentation is explicitly **disabled** — far too noisy.

**Partially wired:**
- **Prisma DB-query spans.** `@prisma/instrumentation` is registered in both apps' `telemetry.ts`, but on
  Prisma **5.22** the client must be (re)generated with `previewFeatures = ["tracing"]` for it to emit
  spans. Until `prisma generate` runs (with the dev stack stopped, to clear Windows file locks), DB-query
  spans don't appear — the instrumentation sits as a harmless no-op. Follow-up (see §5).

### 2.2 Metrics

**Auto-instrumentation** contributes runtime + HTTP metrics (e.g. `http.server.duration`) on the API.

**Custom simulation metrics** (worker only — the worker is what actually runs ngspice). Emitted by
`recordSim()` in [telemetry.ts](../apps/worker-sim/src/observability/telemetry.ts), called from
[processor.ts](../apps/worker-sim/src/simulation/processor.ts). The only attribute is `status`
(`succeeded` | `failed` | `timed_out`) — kept deliberately low-cardinality (no `jobId`/`orgId`, which
would explode a metrics backend).

| Metric | Type | Unit | What it tells you |
|--------|------|------|-------------------|
| `circuitforge.sim.runs` | Counter | `{run}` | Throughput and the **failure/timeout rate** (split by `status`). |
| `circuitforge.sim.duration` | Histogram | `ms` | ngspice wall-clock runtime → p50/p95/p99 latency, saturation. |
| `circuitforge.sim.points` | Histogram | `{point}` | The **TRUE pre-downsample** point count of a run — a direct **memory-pressure proxy**. A stiff/long transient that materializes a giant M×N result shows up here *before* it OOMs a worker. (The stored series is capped at `WORKER_MAX_POINTS`; this metric records the real size.) |

`recordSim()` is a no-op when telemetry is off and is wrapped in try/catch — metrics never break a job.

### 2.3 Logs

`pino` logs are exported as **OTLP logs** to the collector (→ Loki) via `logRecordProcessors` in
`telemetry.ts`; the pino auto-instrumentation injects `trace_id`/`span_id`, so a log line links to its
span in Grafana. **Worker log export is verified** (`{service_name="circuit-forge-worker"}` in Loki); the
API uses the same wiring (pino-http) — confirm its lines once it has served traffic.

---

## 3. Recommended alerts

Circuit Forge emits the signals; **wiring alerts is collector/vendor-specific** (Prometheus
Alertmanager, Grafana, Datadog, etc.) and intentionally not baked into the app. Recommended starting
points, mapped to the signals above:

| Alert | Signal | Suggested condition |
|-------|--------|---------------------|
| Sim failure rate high | `circuitforge.sim.runs{status="failed"}` / total | > 10% over 5m |
| Sim timeouts climbing | `circuitforge.sim.runs{status="timed_out"}` | > 5% over 5m (often a generation/convergence regression) |
| Sim latency regression | `circuitforge.sim.duration` p95 | > 2× the rolling baseline, or near `SIM_TIMEOUT_MS` |
| **Memory blow-up risk** | `circuitforge.sim.points` p99 | sustained near the OOM threshold for your worker memory — the early warning for the transient-memory bottleneck |
| Queue backlog | BullMQ `waiting` depth (auto-instr) | grows for > 5m → workers under-provisioned |
| API 5xx rate | `http.server.duration` count by status | 5xx > 1% over 5m |
| API latency | `http.server.duration` p95 | breaches your route SLO |
| Telemetry pipeline down | absence of any metric for > 2× `OTEL_METRIC_EXPORT_INTERVAL_MS` | collector or exporter is broken |

Page on the customer-facing SLO breaches (failure rate, API 5xx, latency); the memory-pressure and
queue-depth alerts are early-warning / capacity signals.

---

## 4. Failure & safety properties

- **Never crashes the app.** `startTelemetry()` and `recordSim()` are both wrapped in try/catch; an
  unreachable collector logs `[otel] init failed …` and the service continues without telemetry.
- **Graceful shutdown, app-owned.** Telemetry registers **no** signal handler of its own. Each app's
  existing shutdown path calls `shutdownTelemetry()` (flush `sdk.shutdown()`) **last** — the worker only
  after it has drained the in-flight job (`worker.close()`) and disconnected Prisma, the API after
  `app.close()`. This is deliberate: a telemetry-owned `process.exit()` would otherwise race the worker's
  drain and abandon a running simulation.
- **No secrets in telemetry.** We don't attach request bodies, credentials, or per-tenant identifiers to
  spans/metrics. Auth headers for the collector itself go via the standard `OTEL_EXPORTER_OTLP_HEADERS`.

---

## 5. Gaps / not yet done

Called out honestly rather than implied:

- **Prisma DB-query spans pending.** `@prisma/instrumentation` is wired (§2.1) but won't emit until the
  Prisma client is regenerated with `previewFeatures = ["tracing"]` (Prisma 5.22) — blocked by Windows
  file locks while `pnpm dev` runs. Do it with the dev stack stopped: add the preview flag to
  `schema.prisma`, `pnpm --filter api db:generate`, restart. (BullMQ/job tracing already works — §2.1.)
- **API log export unconfirmed.** Worker pino logs reach Loki; the API uses the same wiring but its lines
  weren't yet confirmed in Loki — verify after the API serves some traffic.
- **No collector / dashboards enabled by default.** The app only emits OTLP. For LOCAL viewing there's an
  opt-in Grafana stack (§6); for PRODUCTION you point it at a real backend (§7). Neither ships on by default.
- **API does not emit the custom sim metrics.** The API's inline verify-and-fix ngspice path (dev/
  fallback) is not instrumented with `recordSim` — those metrics come from the worker, which owns the
  production simulation path. If/when the inline path is used in prod, add `recordSim` there too.

---

## 6. Viewing it locally (Grafana)

A one-container viewer is wired into [docker-compose.yml](../docker-compose.yml) behind the
`observability` **profile** — the [`grafana/otel-lgtm`](https://github.com/grafana/docker-otel-lgtm)
all-in-one (Grafana UI + Tempo for traces + Prometheus/Mimir for metrics + a built-in OTel Collector).
It's **opt-in** (the default `docker compose up` stays lean) and **ephemeral** (no volume — a restart
clears the data, which is fine for dev).

1. **Start the viewer:**
   ```bash
   docker compose --profile observability up -d otel-lgtm
   ```
   It accepts OTLP on `4317` (gRPC) / `4318` (HTTP) and serves **Grafana on http://localhost:3030**
   (mapped off the container's 3000 so it never clashes with the API).

2. **Point the apps at it** — in your root `.env` (or exported before `pnpm dev`):
   ```
   OTEL_ENABLED=true
   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
   ```
   (Running the API/worker INSIDE docker instead? Uncomment the `OTEL_*` lines on those services in
   `docker-compose.yml` — they target `http://otel-lgtm:4318`.)

3. **Generate signal** — run the API + worker and hit `POST /verify-design` or queue a simulation. On
   boot the app logs `[otel] telemetry started …`.

4. **Open Grafana** → http://localhost:3030 (no login — anonymous Admin is enabled; if ever prompted,
   `admin`/`admin`). Use **Explore**:
   - **Traces** (Tempo): filter `service.name = circuit-forge-api` and open a `POST /verify-design` trace —
     it's ONE distributed trace: HTTP → Nest controller → ioredis enqueue → worker `sim.process` (with the
     ngspice run inside). The context is propagated through the BullMQ job (§2.1).
   - **Metrics** (Prometheus): search `circuitforge` for the custom sim metrics — they arrive as
     `circuitforge_sim_runs_total` (counter, label `status`), `circuitforge_sim_duration_milliseconds_{bucket,sum,count}`
     and `circuitforge_sim_points_{bucket,sum,count}` (histograms). (OTLP dots → underscores; Prometheus
     adds `_total` to counters, `_bucket/_sum/_count` to histograms, and the unit, e.g. `_milliseconds`.)
     Search `http_server` for API request latency. Example panels: failure rate
     `sum(rate(circuitforge_sim_runs_total{status!="succeeded"}[5m])) / sum(rate(circuitforge_sim_runs_total[5m]))`;
     p95 duration `histogram_quantile(0.95, sum by (le) (rate(circuitforge_sim_duration_milliseconds_bucket[5m])))`.

**Dashboard + alerts auto-provision** (no manual building / querying). A **"Circuit Forge — Simulations
& API"** dashboard (Dashboards menu) and two **alert rules** (Alerting → Alert rules → "Circuit Forge"
folder) load on every start from [infra/observability/grafana/](../infra/observability/grafana) (mounted
read-only into the container). Edit those files to change them; they survive restarts because they're
provisioned from disk, not stored in the (ephemeral) container.

> **Host dev note:** `instrumentation.ts` loads the root `.env` itself (via `process.loadEnvFile`) before
> starting telemetry, so once `OTEL_ENABLED`/`OTEL_EXPORTER_OTLP_ENDPOINT` are in `.env`, every `pnpm dev`
> emits automatically — no per-run env exporting. (The SDK starts before instrumented modules load, which
> is *why* the .env must be loaded there and not left to `@nestjs/config`.)

Stop it with `docker compose --profile observability down` (or `stop otel-lgtm`).

---

## 7. Production

**Do NOT run `otel-lgtm` in production** — it's a single-process dev/demo bundle with no HA, retention,
access control, or durable storage. In prod the app is unchanged (it still just emits OTLP); you change
WHERE it points and add a real backend. Two paths:

**A — Managed / SaaS (least ops).** Grafana Cloud, Honeycomb, Datadog, New Relic, or a cloud-native
backend (e.g. AWS via the ADOT collector). Set the endpoint + auth header and you're done:
```
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.<vendor>.example
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <token>   # standard OTLP env, honored by the exporters
```

**B — Self-hosted.** Run a standalone **OpenTelemetry Collector** as a gateway service that fans out to
Tempo (traces) + Mimir/Prometheus (metrics) [+ Loki for logs later], with Grafana for dashboards. The
apps point at the collector, not at storage.

**Best practices either way:**
- **Apps → Collector (gateway) → backends.** Don't point apps straight at storage. The collector
  centralizes batching, retry, attribute redaction, and sampling, and lets you swap backends without a redeploy.
- **Tail-based sampling** for traces at scale — storing 100% of spans gets expensive fast.
- **Secure the pipeline** — TLS + an auth header on the OTLP endpoint (`OTEL_EXPORTER_OTLP_HEADERS`);
  never expose Grafana or the collector publicly without SSO/auth.
- **Tag the environment** — `OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production,service.version=<git-sha>`
  (`service.name` is already set per app).
- **Wire the alerts** from §3 in Grafana Alerting / Alertmanager (sim failure rate, p95 `sim.duration`,
  the `sim.points` memory-pressure proxy, API 5xx, queue depth).
- **Mind retention + cost** and tune `OTEL_METRIC_EXPORT_INTERVAL_MS` to the backend's ingest model.
