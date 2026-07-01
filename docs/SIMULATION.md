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
| Netlist round-trip import (§15) | [packages/eda-core/src/parser/netlist-parser.ts](../packages/eda-core/src/parser/netlist-parser.ts) |
| CSV / output parser | [packages/eda-core/src/parser/csv-parser.ts](../packages/eda-core/src/parser/csv-parser.ts) |
| Fourier/THD, `.meas`, `.tf`, `.noise`, `.sens` parsers (§10) | [packages/eda-core/src/analysis/](../packages/eda-core/src/analysis/) |
| Verdict-gating assertions (§11) | [packages/eda-core/src/analysis/assertions.ts](../packages/eda-core/src/analysis/assertions.ts) |
| Monte-Carlo orchestration (§12) | [packages/eda-core/src/montecarlo.ts](../packages/eda-core/src/montecarlo.ts) |
| Monte-Carlo batch runner (§12) | [simulation/montecarlo-runner.ts](../apps/worker-sim/src/simulation/montecarlo-runner.ts) |
| Design queue worker (§13) | [design/processor.ts](../apps/worker-sim/src/design/processor.ts) |
| Orphan design-job reaper (§13) | [design/reaper.ts](../apps/worker-sim/src/design/reaper.ts) |
| Job that enqueues work | [apps/api/src/simulation/simulation.service.ts](../apps/api/src/simulation/simulation.service.ts) |
| Simulation queue options (§3) | [apps/api/src/simulation/simulation.module.ts](../apps/api/src/simulation/simulation.module.ts) |
| Design queue options (§13) | [apps/api/src/generation/generation.module.ts](../apps/api/src/generation/generation.module.ts) |
| Readiness probe (§14) | [apps/api/src/health/health.controller.ts](../apps/api/src/health/health.controller.ts) |
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
  analysisType: string;                  // 'tran' | 'ac' | 'dc' | 'op' | 'noise' | 'sens'
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
> as failed and fires the `failed` event.
>
> **Retry is configured, but it is infra-only.** The `'simulations'` queue's `defaultJobOptions`
> (set on the API side in
> [apps/api/src/simulation/simulation.module.ts](../apps/api/src/simulation/simulation.module.ts)) give BullMQ
> `attempts: 3` with `backoff: { type: 'exponential', delay: 1000 }` (retries at ~1 s, then ~2 s). This
> only matters for a **thrown** job — i.e. the "Unhandled exception (catch)" row above, which re-throws
> after marking `FAILED`. A genuine simulation fault (non-convergence, bad circuit, `ngspice exited with
> code N`) is *returned* by the runner, not thrown, so `handleFailure` completes the job normally and
> BullMQ never retries it — re-running a deterministically-bad deck would just waste a worker slot. Only
> transient infrastructure hiccups (ngspice couldn't spawn, a momentary S3/DB/Redis blip) throw and get
> the retry. The same queue also sets `removeOnComplete: { age: 3600, count: 1000 }` and
> `removeOnFail: { age: 24 * 3600, count: 1000 }` so Redis doesn't accumulate finished job records
> forever — the API always reads job status/results from Postgres, never from the BullMQ record, so the
> queue entry is disposable once terminal.

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

## 10. ngspice-native analyses beyond tran/ac/dc/op

Besides the four base analysis types, the worker surfaces five ngspice-native analyses/features. All
are **report-only**: a parse miss never fails the run, and — with the exception of THD/gain feeding the
verdict-gating framework in §11 — none of them gate pass/fail on their own.

| Analysis / feature | Config type (eda-core) | Parser | Surfaced on `SimulationResult` |
|---|---|---|---|
| Fourier / THD | `TranAnalysis.fourier: { fundamentalFreq, probes }` | `parseFourierLog` | `fourier?: FourierResult[]` |
| `.meas` measurements | `TranAnalysis.measurements?: MeasureSpec[]` | `parseMeasurements` | `measurements?: MeasurementResult[]` |
| `.tf` transfer function | `OpAnalysis.tf: { output, inputSource }` | `parseTransferFunction` | `transferFunction?: TransferFunctionResult` |
| `.noise` | `NoiseAnalysis` (own `analysisType: 'noise'`) | `parseNoise` (+ `parseNoiseTotals`) | `noise?: NoiseResult`; spectrum in `series` as `onoise_spectrum`/`inoise_spectrum` |
| `.sens` | `SensAnalysis` (own `analysisType: 'sens'`) | `parseSensitivity` | `sensitivity?: SensitivityResult` |

All five types live in [packages/eda-core/src/types/analysis.ts](../packages/eda-core/src/types/analysis.ts);
the parsers live under [packages/eda-core/src/analysis/](../packages/eda-core/src/analysis/) (`fourier.ts`,
`measure.ts`, `tf.ts`, `noise.ts`, `sens.ts`).

- **Fourier/THD and `.tf`** ride on an existing `tran`/`op` run — no extra simulation. `runner.ts`
  detects them from the generated netlist itself (`fourier` / `tf` control commands, or a `.meas` card)
  via regex against the netlist text, reads the ngspice **listing** (`stdout` + the `-o stdout.log` file
  concatenated), and parses both. This is deliberate: a `.four` card printed under the generator's
  `quit`-terminated `.control` block emits nothing — only the `fourier`/`tf` *commands* inside `.control`
  produce output, so the parsers read the listing rather than `output.csv`.
- **`.meas`** measurement names are read back out of the netlist (`/^\s*\.meas\s+\w+\s+(\w+)\b/gim`) so
  the parse is scoped to the measures actually requested. A failed measure (e.g. a `when` threshold never
  reached) is returned as `{ value: null, failed: true }` rather than failing the job.
- **`.noise`** and **`.sens`** are their own `analysisType` values (not overlays on `tran`/`op`). `.sens`
  is scalar-only — ngspice prints a table to the listing and writes **no** `output.csv` — so `runner.ts`
  special-cases it before the "no output file ⇒ fail" guard that every other analysis relies on. `.noise`
  is parsed from **both** the CSV (the per-frequency spectrum) and the listing (the integrated totals)
  together, since ngspice splits the two outputs across the two channels.

---

## 11. Verdict-gating framework (assertions)

A "verified" verdict is decided by `evaluateAssertions` in
[packages/eda-core/src/analysis/assertions.ts](../packages/eda-core/src/analysis/assertions.ts) — the one
place a measurable spec is checked against a simulation result. It is shared by verify-design
(user-supplied assertions), the AI design loop (model-emitted acceptance criteria), and the Monte-Carlo
batch runner (§12), so all three paths agree on what "pass" means.

- **Metric enum.** The API's `AssertionDto` (and eda-core's structurally-identical `AcceptanceCriterion`)
  exposes nine metrics: `min | max | final | pp | avg | rms | cutoff | thd | gain`. `min`/`max`/`final`/
  `pp`/`avg`/`rms` are read straight off a node's summarized series (`avg`/`rms` are **time-weighted** —
  trapezoidal over the adaptive timesteps, not sample-averaged). `cutoff` is the −3 dB corner of an AC
  magnitude sweep. `thd` and `gain` are **not** derivable from the series at all — they only exist if the
  analysis explicitly requested a Fourier/`.tf` overlay (§10).
- **How THD/gain get onto a measurement.** `attachFourierThd(measurements, fourier)` and
  `attachTransferFunction(measurements, tf)` fold the `FourierResult`/`TransferFunctionResult` from §10
  onto the matching per-node `SimMeasurement` (matched by canonical node key) **before**
  `evaluateAssertions` runs. This means a `thd`/`gain` criterion rides on the design's **own** analysis
  config — a `thd` criterion requires the same design's `tran` analysis to also carry a `fourier` request
  on that probe; a `gain` criterion requires its `op` analysis to carry a `tf` request to that probe.
  Without the matching overlay, `m.thd`/`m.gain` stay `undefined` and the criterion resolves
  `actual: null, pass: false` — never a silent pass.
- Both `runner.ts` (nominal sim) and `montecarlo-runner.ts` (§12, per-variant) call `attachFourierThd`/
  `attachTransferFunction`, so THD/gain gate identically at nominal and across tolerance variants.

---

## 12. Monte-Carlo yield orchestration

Real components vary within a tolerance; a design that passes at its nominal value can fail once R is
+5% and C is −5%. The Monte-Carlo subsystem answers "what fraction of real-world builds would actually
pass?" instead of just "does the nominal value pass?".

**Pure orchestration (eda-core, no ngspice):**
[packages/eda-core/src/montecarlo.ts](../packages/eda-core/src/montecarlo.ts) —

- `perturbValue`/`perturbCircuit` sample each toleranced component's value (gaussian ±tol as 3σ,
  hard-clamped, or uniform ±tol) with a seeded PRNG (`mulberry32`), so a given seed reproduces the exact
  same variant set.
- `monteCarloVariants` draws N perturbed `CircuitJson` clones from one seed.
- `computeYield` aggregates per-variant outcomes (`'pass' | 'fail' | 'errored'`) into a **Wilson 95%
  confidence interval** on the yield. `errored` (a variant ngspice couldn't even run — spawn/infra fault,
  not a spec failure) is excluded from the yield denominator so an infra blip never masquerades as a low
  yield.
- `runMonteCarlo(circuit, criteria, runVariant, opts)` is the orchestrator: draws a variant, calls the
  injected `runVariant` (real ngspice in production, a fake in tests), evaluates `criteria` against the
  returned measurements via `evaluateAssertions`, and repeats up to `opts.n` (hard-capped at 300). It
  supports **adaptive-N**: once `minRuns` (default 24) evaluated variants have run, it stops early once
  the Wilson CI half-width is ≤ `ciStopHalfWidth` (default 0.03 = ±3%) — a clearly-robust or clearly-bad
  design converges in far fewer than N runs. `opts.shouldStop` lets a caller impose a wall-clock budget;
  `opts.onProgress` lets it checkpoint partial progress.

**Real-ngspice batch runner (worker):**
[apps/worker-sim/src/simulation/montecarlo-runner.ts](../apps/worker-sim/src/simulation/montecarlo-runner.ts)
supplies the `VariantRunner` that plugs into `runMonteCarlo`:

- Reuses **one** job dir across all variants (`<SIM_TEMP_DIR>/<jobId>-mc`) rather than one per variant.
  Before every spawn it deletes `output.csv`/`stdout.log` from the prior variant — otherwise a variant
  that produces no file could silently read the previous variant's leftover result.
- Immediately reduces each variant's result to `summarizeSeries` scalars and discards the raw series
  (OOM guard — 300 full `SimulationResult`s would never accumulate).
- Folds THD/gain onto each variant's measurements via `attachFourierThd`/`attachTransferFunction` (§11)
  when the analysis requests them, so THD/gain gate **per variant**, not just at nominal.
- Enforces a per-batch wall-clock budget (`config.MC_BATCH_BUDGET_MS`, default 60 s) via `shouldStop`; on
  a hit it returns an honest partial (`budgetHit: true`, real counts — never a claimed N).
- Config knobs (worker `config.ts`): `MC_N_DEFAULT` (default 300, the variant cap), `MC_CI_HALFWIDTH_STOP`
  (default 0.03), `MC_BATCH_BUDGET_MS` (default 60000).
- `apps/worker-sim/src/simulation/processor.ts` and `apps/worker-sim/src/design/local-sim.ts` both call
  `runMonteCarloBatch` — the former as an informational batch attached to a plain simulation job
  (`metrics.monteCarlo`), the latter as part of the agentic design loop's robustness pass.

---

## 13. Durable design queue + orphan reaper

The agentic design loop (AI-driven circuit generation + fix loop) runs on its own durable BullMQ `'design'`
queue + worker, consumed only by worker-sim instances (not the API). This replaced an earlier in-process
detached runner (removed).

- **Worker.** `createDesignWorker()` in
  [apps/worker-sim/src/design/processor.ts](../apps/worker-sim/src/design/processor.ts) is started from
  `main.ts` **only when `LLM_API_KEY` is configured** — a sim-only deployment (no LLM key) deliberately
  never consumes the `'design'` queue, since it would just fail every job.
- **Job options** on the `'design'` queue (set in
  [apps/api/src/generation/generation.module.ts](../apps/api/src/generation/generation.module.ts)):
  `attempts: 1` (deliberately **no retry** — the design loop is not idempotent/checkpointed, so a BullMQ
  redelivery would restart from round 1 and re-bill the LLM; a crash surfaces as a terminal `FAILED` the
  user can explicitly retry, never a silent re-run), plus the same `removeOnComplete: { age: 3600, count:
  1000 }` / `removeOnFail: { age: 24 * 3600, count: 1000 }` cleanup as the simulation queue (§3) — the
  `DesignJob` row in Postgres is the source of truth the client polls, so the queue record is disposable.
- **Orphan reaper.** [apps/worker-sim/src/design/reaper.ts](../apps/worker-sim/src/design/reaper.ts) runs
  alongside the design worker (boot sweep + every `REAPER_INTERVAL_MS`, default 60 s) and reconciles
  `DesignJob` rows stuck in `QUEUED`/`RUNNING` past a grace window (`DESIGN_REAP_GRACE_MS`, default 60 s)
  against the queue's ground truth (`queue.getJob(rowId)` — the BullMQ job id is set equal to the
  `DesignJob` row id). It recovers two failure modes every distributed job system has: a worker dying
  mid-job (row stuck `RUNNING` forever) and the insert↔enqueue gap (a row inserted `QUEUED` just before an
  API crash, so no worker ever picks it up). A row whose queue job is still legitimately `waiting`/
  `delayed`/`active` (within `DESIGN_REAP_RUNNING_DEADLINE_MS`, default 30 min) is never touched — every
  reap is a **conditional** `updateMany` gated on the row still being `QUEUED`/`RUNNING`, so it can't
  clobber a row the worker already finalized, and concurrent reaper instances race harmlessly.
- **Graceful shutdown order (worker-sim).** `apps/worker-sim/src/main.ts` closes the simulation worker and
  the design worker first (letting in-flight jobs drain), **then** stops the reaper, **then** disconnects
  Prisma, and flushes OpenTelemetry **last** — so the final spans/metrics from the draining job still
  export before the process exits. (The API's own shutdown in `apps/api/src/main.ts` is simpler — it owns
  no worker or reaper, just `app.close()` then `shutdownTelemetry()`.)

---

## 14. Readiness probe

The API exposes `GET /health/ready` ([apps/api/src/health/health.controller.ts](../apps/api/src/health/health.controller.ts)),
which concurrently pings Postgres (`SELECT 1`), Redis, and S3/MinIO — the three hard dependencies the API
needs to actually enqueue/serve a simulation. Each check is isolated (one dead dependency never masks the
others) and the endpoint returns **503** with a `status: 'degraded'` body plus a per-check breakdown when
any check fails, so an orchestrator (k8s readiness probe) pulls the pod from rotation instead of routing
traffic to an API that can't reach the queue or storage. `GET /health/live` is a separate, dependency-free
liveness check — the process being alive is orthogonal to its dependencies being reachable. Both endpoints
are exempted from the global rate limiter (`@SkipThrottle()`), since orchestrator probes poll frequently.

---

## 15. SPICE netlist round-trip import

`parseNetlist` in
[packages/eda-core/src/parser/netlist-parser.ts](../packages/eda-core/src/parser/netlist-parser.ts) parses
a raw SPICE deck back into structured form — the inverse of `generateNetlist`. It handles both analog and
digital/XSPICE (`CFD_*` model) components, preserves `.model`/`.subckt`/`.options`/`.ic` cards, and
re-merges nets that a mixed-signal circuit's analog/digital bridging had split apart during generation.

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
