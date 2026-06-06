# Simulation Engine Reference

The simulation engine is **ngspice** driven by the **worker-sim** service. The worker
is a standalone Node process that pulls simulation jobs off a BullMQ/Redis queue,
runs ngspice in an isolated per-job temp directory, parses the output, and writes the
result back to Postgres (or S3/MinIO for large payloads).

This document describes the worker as it is actually implemented in
[apps/worker-sim/src](../apps/worker-sim/src). Netlist generation and CSV parsing live in
the `@circuit-forge/eda-core` package and are referenced where relevant.

---

## Pipeline overview

```
 API (SimulationService)            worker-sim                              ngspice
 ───────────────────────            ──────────                              ───────
 generateNetlist()                  Worker (BullMQ)
   ↓                                  ↓ processJob
 simulationJob row (QUEUED)  ──────▶ status = RUNNING
 queue.add('simulation', {...})       ↓ download model assets (S3)
                                      ↓ runSimulation()
                                        write circuit.cir  ─────────────▶  spawn ngspice -b -o stdout.log circuit.cir
                                        read output.csv    ◀─────────────  (writes output.csv via wrdata)
                                        parseSimulationOutput()
                                      ↓
                                    status = SUCCEEDED | FAILED | TIMED_OUT
                                    resultJson (DB) or resultS3Key (S3 if > 1 MB)
                                    rm -rf job dir (finally)
```

Source files:

| Concern | File |
|---------|------|
| Bootstrap / lifecycle | [main.ts](../apps/worker-sim/src/main.ts) |
| Config (env vars) | [config.ts](../apps/worker-sim/src/config.ts) |
| Queue + job processing + DB writes | [simulation/processor.ts](../apps/worker-sim/src/simulation/processor.ts) |
| ngspice execution + parsing | [simulation/runner.ts](../apps/worker-sim/src/simulation/runner.ts) |
| S3/MinIO I/O | [storage/s3-client.ts](../apps/worker-sim/src/storage/s3-client.ts) |
| Prisma client | [prisma/client.ts](../apps/worker-sim/src/prisma/client.ts) |
| Logger | [logger.ts](../apps/worker-sim/src/logger.ts) |
| Netlist generator | [packages/eda-core/src/netlist/generator.ts](../packages/eda-core/src/netlist/generator.ts) |
| Netlist sanitizer | [packages/eda-core/src/netlist/sanitizer.ts](../packages/eda-core/src/netlist/sanitizer.ts) |
| CSV / output parser | [packages/eda-core/src/parser/csv-parser.ts](../packages/eda-core/src/parser/csv-parser.ts) |
| Job that enqueues work | [apps/api/src/simulation/simulation.service.ts](../apps/api/src/simulation/simulation.service.ts) |
| DB schema | [apps/api/prisma/schema.prisma](../apps/api/prisma/schema.prisma) |

---

## 1. Worker bootstrap

`main()` in [main.ts](../apps/worker-sim/src/main.ts) does the following, in order:

1. Logs `Starting worker-sim` with the resolved `NODE_ENV`.
2. **Connects Prisma** via `prisma.$connect()`. On failure it logs and calls
   `process.exit(1)` — the worker will not start without a reachable database.
3. **Creates the worker** by calling `createSimulationWorker()` (from
   [processor.ts](../apps/worker-sim/src/simulation/processor.ts)), which opens the Redis
   connection and starts consuming jobs. The returned `Worker` is held in a
   module-level `worker` variable so it can be closed on shutdown.
4. **Registers graceful-shutdown handlers** for `SIGTERM` and `SIGINT`.
5. Logs `Worker-sim is running`.

A top-level `main().catch(...)` logs a `fatal` and exits `1` on any unhandled startup
error.

### Graceful shutdown

`shutdown(signal)` (triggered by `SIGTERM`/`SIGINT`):

1. Logs the received signal.
2. If a worker exists, `await worker.close()` (lets in-flight jobs drain per BullMQ
   semantics) and logs `Worker closed`.
3. `await disconnectPrisma()` (calls `prisma.$disconnect()` and logs `Prisma disconnected`).
4. Logs `Shutdown complete` and exits `0`. Any error during shutdown logs and exits `1`.

### Prisma client

[prisma/client.ts](../apps/worker-sim/src/prisma/client.ts) exports a singleton
`PrismaClient`. It is cached on `globalThis` outside production (to survive HMR/repeated
imports). Query logging is wired as events: any query taking **> 100 ms** is logged at
`warn` as `Slow query detected`. `error` and `warn` Prisma levels are emitted to stdout.

### Logger

[logger.ts](../apps/worker-sim/src/logger.ts) is a `pino` logger with `base.service =
'worker-sim'` and level = `config.LOG_LEVEL`. In `development` it pipes through
`pino-pretty` (colorized, `SYS:standard` time, `pid`/`hostname` ignored); otherwise it
emits raw JSON.

---

## 2. Queue (BullMQ on Redis)

The worker is a BullMQ `Worker` created in `createSimulationWorker()`:

- **Transport:** Redis, via `new Redis(config.REDIS_URL, { maxRetriesPerRequest: null })`.
  `maxRetriesPerRequest: null` is required by BullMQ for blocking commands.
- **Queue name:** `config.QUEUE_NAME` (default **`simulations`**). The API side enqueues
  to the same queue — `SimulationService` injects `@InjectQueue('simulations')` and adds
  jobs named `'simulation'` to it.
- **Concurrency:** `config.CONCURRENCY` (default **`2`**). Up to N jobs run in parallel.
- **Events logged:** `completed` (info, with `jobId`), `failed` (error, with `jobId` +
  message), and worker-level `error` (error, with message).

### Job payload — `SimulationJobPayload`

Defined in [processor.ts](../apps/worker-sim/src/simulation/processor.ts):

```ts
interface SimulationJobPayload {
  jobId: string;                         // SimulationJob.id (DB row to update)
  orgId: string;
  netlist: string;                       // full SPICE netlist text
  probeNames: string[];                  // names passed to the CSV parser (see quirk §9)
  analysisType: string;                  // 'tran' | 'ac' | 'dc' | 'op' | ...
  analysisConfig: Record<string, unknown>;
  modelAssets?: string[];                // optional S3 keys of model files to download
}
```

The API populates this in `SimulationService.createFromVersion` / `createQuickSim`
(job name `'simulation'`). Both paths accept an optional `modelAssetIds: string[]` (uploaded
SPICE_MODEL asset IDs); `resolveModelAssets` scopes them to the request's org, validates each
filename (sandbox-safe, non-reserved, collision-free, capped at 32), and:
- populates `payload.modelAssets` with the resolved S3 keys (the worker downloads them into the
  job dir), and
- for version-based sims, passes the filenames as `includeFiles` so `generateNetlist` emits a
  `.include "<file>"` for each. (Quick-sim takes a raw netlist, so the caller must already
  `.include` the model by filename; only `modelAssets` is wired there.)
A component's `model` must match a name defined *inside* the uploaded file; the filename only
drives the `.include`.

---

## 3. Job lifecycle and DB status transitions

The DB enum is `SimJobStatus { QUEUED, RUNNING, SUCCEEDED, FAILED, CANCELED, TIMED_OUT }`
on the `SimulationJob` model in
[schema.prisma](../apps/api/prisma/schema.prisma) (`engine` defaults to `NGSPICE`).

```
QUEUED ──▶ RUNNING ──▶ SUCCEEDED
                   ├──▶ FAILED
                   └──▶ TIMED_OUT
```

`CANCELED` exists in the schema but is **not** set by the worker.

`processJob()` performs the transitions:

| Step | Status written | Fields written |
|------|----------------|----------------|
| API creates row | `QUEUED` | `analysisConfig`, `netlist`, `engine=NGSPICE` (set by API) |
| Job picked up | `RUNNING` | `startedAt = now()` |
| Success (`handleSuccess`) | `SUCCEEDED` | `stdout`, `stderr` (each truncated to 10 000 chars), `resultJson` **or** `resultS3Key`, `finishedAt`, `metrics` |
| Failure (`handleFailure`) | `FAILED` or `TIMED_OUT` | `stdout`, `stderr` (+ error, truncated to 10 000), `finishedAt`, `metrics` |
| Unhandled exception (catch) | `FAILED` | `stderr = error.message`, `finishedAt`, `metrics = { error }`, then re-throws |

Status decision in `handleFailure`: it is `TIMED_OUT` when the runner's `error` string
**includes `'timed out'`** (the runner emits `'Simulation timed out'` on timeout),
otherwise `FAILED`.

`metrics` shape (matches the schema comment `{ runtimeMs, peakMemBytes, pointsCount }`):

- Success: `{ runtimeMs, outputSizeBytes, pointsCount }` (`pointsCount` from
  `result.meta.pointsCount`). `peakMemBytes` is not currently measured.
- Failure/timeout: `{ runtimeMs, error }`.
- Catch path: `{ error }` only.

> The catch block re-throws after marking the row `FAILED`, so BullMQ also sees the job
> as failed and fires the `failed` event. There is no automatic retry configured.

---

## 4. ngspice execution (runner.ts)

`runSimulation(input)` in [runner.ts](../apps/worker-sim/src/simulation/runner.ts):

1. Computes `jobDir = path.join(config.SIM_TEMP_DIR, input.jobId)` and
   `await fs.mkdir(jobDir, { recursive: true })`.
2. Runs the netlist through `sanitizeNetlist(netlist, jobDir)` (blocks `.shell` /
   `.system` directives and validates any `.include` paths against traversal/absolute
   paths — see [sanitizer.ts](../packages/eda-core/src/netlist/sanitizer.ts)).
3. Writes the sanitized netlist to **`circuit.cir`** in `jobDir`.
4. Writes any downloaded model files into `jobDir` (one file per `modelFiles[]` entry,
   named by the basename of its S3 key).
5. Calls `executeNgspice(netlistPath)`.

### Spawn details

```ts
const args = ['-b', '-o', 'stdout.log', netlistPath];
const cwd  = path.dirname(netlistPath);            // == jobDir
spawn(config.NGSPICE_PATH, args, {
  cwd,
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: config.SIM_TIMEOUT_MS,
});
```

- `-b` runs ngspice in **batch mode**; `-o stdout.log` redirects the ngspice log file.
  The netlist is passed positionally. Because `cwd` is the job dir, the netlist's
  `.control` block writes `output.csv` (and `stdout.log`) **into the job dir**.
- `stdin` is ignored; `stdout`/`stderr` are captured into in-memory strings.
- **Timeout:** a manual `setTimeout(config.SIM_TIMEOUT_MS)` sets `timedOut = true` and
  sends **`SIGKILL`** to the process. (The `spawn({ timeout })` option is also passed,
  but the explicit timer is what flags `timedOut`.) On timeout the runner returns
  `{ success: false, error: 'Simulation timed out' }`, which the processor maps to
  `TIMED_OUT`.
- **`error` handler quirk:** if the process fails to spawn at all (e.g. the ngspice
  binary is missing / not on PATH), the `'error'` handler resolves with
  **`exitCode: 1`** (not a distinct "spawn failed" signal). The runner then returns
  `error: \`ngspice exited with code ${exitCode}\``. **So a missing/uninstalled ngspice
  surfaces as `"ngspice exited with code 1"`, not an ENOENT.** Keep this in mind when
  diagnosing — see §8.
- The `'close'` handler resolves with the real exit `code`. A non-zero, non-timeout exit
  returns `error: \`ngspice exited with code ${exitCode}\``.

### After the run

1. If `timedOut` → return timeout failure.
2. If `exitCode !== 0` → return `ngspice exited with code N` failure.
3. Read **`output.csv`** (`fs.readFile(path.join(jobDir, 'output.csv'), 'utf-8')`). If it
   does not exist → return `error: 'Simulation output file not found'`.
4. Enforce output size cap (see §5). 
5. Parse with `parseSimulationOutput(outputContent, input.probeNames, input.analysisType)`
   and return `{ success: true, result, stdout, stderr, runtimeMs, outputSizeBytes }`.

`runtimeMs` is wall-clock time measured from the start of `runSimulation` (includes file
I/O and parsing, not just the ngspice process).

---

## 5. Output handling

- **Size cap.** After reading `output.csv`, `outputSizeBytes = Buffer.byteLength(content)`.
  If it exceeds **`config.SIM_MAX_OUTPUT_BYTES`** (default 5 MiB) the run fails with
  `Output too large: <n> bytes (max: <cap>)`. This guards memory before parsing.
- **Parsing.** `parseSimulationOutput` (from
  [csv-parser.ts](../packages/eda-core/src/parser/csv-parser.ts)) auto-detects the
  format. ngspice `wrdata` ASCII output is whitespace-separated columns: column 0 is the
  X axis; remaining columns map positionally to `probeNames`. Crucially, the parser
  builds `series` by **iterating over `probeNames`** — if `probeNames` is empty, `series`
  is empty and `pointsCount` is `0` regardless of how much data `output.csv` contains
  (this drives the quirk in §9).
- **DB vs S3 storage.** In `handleSuccess`, the result is JSON-stringified and measured.
  If `resultSize > 1 MiB` (`1024 * 1024`), it is uploaded to S3 via
  `uploadJsonResult(jobId, simResult)` → key **`results/<jobId>/result.json`**, and the
  DB `resultJson` is left undefined with `resultS3Key` set. Otherwise the result is
  stored inline in `resultJson`. (`stdout`/`stderr` are always truncated to 10 000 chars
  before storage.)

  > Note: the 1 MiB inline-vs-S3 threshold is independent of the 5 MiB
  > `SIM_MAX_OUTPUT_BYTES` raw-CSV cap. The CSV is rejected above 5 MiB; the *parsed
  > JSON* spills to S3 above 1 MiB.

- **Model file download.** Before running, if `modelAssets[]` is present, each S3 key is
  fetched with `downloadFile(key)` (streams the body into a `Buffer`) and added to
  `modelFiles` with `name = basename(key)`; the runner writes each into the job dir so
  the netlist can `.include` it by filename. The S3 client
  ([s3-client.ts](../apps/worker-sim/src/storage/s3-client.ts)) is configured with
  `S3_ENDPOINT`, `S3_REGION`, credentials, and `forcePathStyle = S3_FORCE_PATH_STYLE`
  (required for MinIO).

### API read-back of S3-spilled results

`SimulationService.getResult` returns small results inline from `job.resultJson`. When a
result spilled to S3 (`resultS3Key` set, `resultJson` null), the API **re-hydrates** it via
`fetchResultFromS3`: it `GetObject`s `results/{jobId}/result.json` from the same `S3_BUCKET`
(a per-service `S3Client` configured exactly like `AssetsService`), `JSON.parse`s the
`{ meta, series }` payload, and returns it as `result`. On a fetch/parse failure it logs the
error and returns `result: null` plus an `error` field, so callers can tell "temporarily
unavailable from storage" apart from a genuinely empty dataset.

---

## 6. Per-job temp dir cleanup

`runSimulation` wraps the entire body in `try/finally`. The `finally` always runs
`fs.rm(jobDir, { recursive: true, force: true })` and logs `Job directory cleaned up`
(or a `warn` `Failed to cleanup job directory` if removal throws). So `circuit.cir`,
`stdout.log`, `output.csv`, and any model files are deleted on **every** outcome —
success, ngspice failure, timeout, or thrown exception. Cleanup happens *after* the
output has been read and parsed, so the parsed result is unaffected.

---

## 7. Configuration (env vars)

All worker config is validated by a Zod schema in
[config.ts](../apps/worker-sim/src/config.ts); invalid/missing required vars cause the
process to print errors and `exit(1)`. The worker loads env from the **monorepo root
`.env`** (`dotenv.config({ path: resolve(cwd, '../../.env') })`) and then an optional
per-package `.env` (which does not clobber already-set values). In Docker, vars are
injected directly, so a missing file is a no-op.

| Variable | Type / parse | Default | Required | Purpose |
|----------|--------------|---------|----------|---------|
| `DATABASE_URL` | string (URL) | — | **yes** | Postgres connection for Prisma. |
| `REDIS_URL` | string | `redis://localhost:6379` | no | BullMQ/Redis connection. |
| `S3_ENDPOINT` | string (URL) | — | **yes** | S3/MinIO endpoint. |
| `S3_ACCESS_KEY` | string | — | **yes** | S3 access key. |
| `S3_SECRET_KEY` | string | — | **yes** | S3 secret key. |
| `S3_BUCKET` | string | — | **yes** | Bucket for model downloads + large result uploads. |
| `S3_REGION` | string | `us-east-1` | no | S3 region. |
| `S3_FORCE_PATH_STYLE` | string → bool (`'true'`) | `true` | no | Path-style addressing; needed for MinIO. |
| `SIM_TIMEOUT_MS` | string → number | `10000` (10 s) | no | ngspice wall-clock timeout; on expiry the process is SIGKILLed and the job is `TIMED_OUT`. |
| `SIM_MAX_OUTPUT_BYTES` | string → number | `5242880` (5 MiB) | no | Max size of `output.csv`; larger output fails the job. |
| `SIM_TEMP_DIR` | string | `/tmp/sim` | no | Base dir for per-job working directories (`<SIM_TEMP_DIR>/<jobId>`). See Windows note below. |
| `NGSPICE_PATH` | string | `ngspice` | no | Path/command for the ngspice binary; default relies on PATH. |
| `QUEUE_NAME` | string | `simulations` | no | BullMQ queue name (must match the API). |
| `CONCURRENCY` | string → number | `2` | no | Max concurrent jobs. |
| `LOG_LEVEL` | enum: `trace`/`debug`/`info`/`warn`/`error`/`fatal` | `info` | no | pino log level. |
| `NODE_ENV` | enum: `development`/`production`/`test` | `development` | no | Toggles pretty logging and the Prisma global cache. |

> **`SIM_TEMP_DIR` on Windows.** The default `/tmp/sim` is a POSIX-style absolute path.
> On Windows it resolves relative to the **current drive root** (e.g. `E:\tmp\sim` when
> the worker runs from the `E:` drive), not a real `/tmp`. This is harmless but
> surprising; set `SIM_TEMP_DIR` explicitly on Windows if you want a known location.

---

## 8. ngspice requirement & installation

ngspice is **required** by worker-sim. With no binary on PATH (and `NGSPICE_PATH`
unset), spawning fails and — per the §4 quirk — every job fails with
**`ngspice exited with code 1`**. Install it and ensure it is on `PATH`, or point
`NGSPICE_PATH` at the binary.

| OS | Install command | Notes |
|----|-----------------|-------|
| **Windows** | `choco install ngspice -y` | Run in an **Administrator** shell (Chocolatey needs elevation). Re-open the terminal afterward so PATH refreshes. |
| **Linux (Debian/Ubuntu)** | `sudo apt-get update && sudo apt-get install -y ngspice` | — |
| **macOS** | `brew install ngspice` | — |

Verify with `ngspice --version`. If ngspice is installed but not on PATH, set
`NGSPICE_PATH=/full/path/to/ngspice` (or the `.exe` on Windows) in the root `.env`.

> Verified live (2026-05-29): a version-based **transient** simulation ran end-to-end on
> Windows with ngspice installed via `choco install ngspice -y`, and ngspice produced a
> real `output.csv`.

---

## 9. Resolved quirk — version sims without explicit probes

**✅ Fixed** (in [runner.ts](../apps/worker-sim/src/simulation/runner.ts), lines ~118-123). This
section documents the original quirk and the implemented fix.

Previously, when a version-based simulation was created **without** explicitly supplying probes, the
job SUCCEEDED and ngspice produced a valid `output.csv`, but the stored result had an **empty
`series` and `metrics.pointsCount === 0`**.

### Why it happened

1. The API's `SimulationService.createFromVersion`
   ([simulation.service.ts](../apps/api/src/simulation/simulation.service.ts)) calls
   `generateNetlist(circuitJson, analysisConfig, { probes })` and then enqueues the job
   with `probeNames: probes || []`.
2. Inside `generateNetlist`
   ([generator.ts](../packages/eda-core/src/netlist/generator.ts)), the `wrdata` line is
   built from `options.probes || generateDefaultProbes(circuit, nodeMap)`. So when
   `probes` is `undefined`/empty, the **netlist still gets default probes** (all
   non-ground node voltages) and ngspice writes real data to `output.csv`.
3. But the worker calls `parseSimulationOutput(content, input.probeNames, analysisType)`
   with `probeNames === []`. `parseCsv`
   ([csv-parser.ts](../packages/eda-core/src/parser/csv-parser.ts)) builds `series` by
   mapping over `probeNames`; with an empty array, `series = []` and
   `pointsCount = series[0]?.points.length || 0 === 0`.

Net effect: the netlist used **default** probe names that were never communicated to the
worker's parser, so the CSV columns have no series to attach to. The transient sim still
runs and the job is marked `SUCCEEDED` with a real `output.csv` — only the parsed
`series` is empty. (`createQuickSim` always sends `probeNames: []` as well, but quick-sim
callers typically pass an explicit netlist; the mismatch bites the version path where
the netlist's default probes diverge from the empty `probeNames`.)

### Fix (implemented)

The worker now derives `probeNames` from the netlist when the payload doesn't supply them, instead
of trusting the (possibly empty) field. In [runner.ts](../apps/worker-sim/src/simulation/runner.ts):

```ts
const probeNames =
    input.probeNames.length > 0 ? input.probeNames : extractProbes(sanitizedNetlist);
const result = parseSimulationOutput(outputContent, probeNames, input.analysisType);
```

`extractProbes` (eda-core) parses the names out of the netlist's `wrdata` line, so the parser's
`probeNames` stay in lockstep with whatever probes the netlist actually wrote — version/default sims
now return populated `series`.

---

## See also

- [README.md](../README.md)
- [docs/ARCHITECTURE.md](ARCHITECTURE.md)
- [docs/API.md](API.md)
- [docs/DATA_MODEL.md](DATA_MODEL.md)
- [docs/EDA_CORE.md](EDA_CORE.md)
- [docs/SIMULATION.md](SIMULATION.md)
- [docs/SECURITY.md](SECURITY.md)
- [LOCAL_SETUP.md](../LOCAL_SETUP.md)
