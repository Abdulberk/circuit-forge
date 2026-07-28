# Validation & Test Results

How Circuit Forge is tested, and the results of the **real-services validation campaign** (verified
2026-06-16, no mocks). Every live result below is tied to the command that produced it so it is reproducible.

Testing is layered: fast deterministic **unit/regression** suites (CI-friendly, no external deps) +
**real-ngspice** suites (gated on `NGSPICE_PATH`) + **live** suites that hit real ngspice / the real TME parts
catalog / the real LLM provider (`LLM_PROTOCOL` selects Anthropic or an OpenAI-compatible gateway) (gated behind explicit env flags so they never run by accident in CI).

| Layer | Needs | Runs in CI |
|-------|-------|------------|
| Unit / regression (Jest) | nothing | ✅ |
| ngspice coverage harness (matrix/sweep/fuzz) | `NGSPICE_PATH` | ⚠️ local |
| Real-ngspice live specs | `NGSPICE_PATH` | ⚠️ local |
| Live design loop (real TME) | `SIMLOOP_LIVE=1` + `TME_TOKEN` + `NGSPICE_PATH` | ❌ opt-in |
| Live AI (real Anthropic) | `AI_LIVE=1` + `LLM_API_KEY` + `TME_TOKEN` | ❌ opt-in |
| Monte-Carlo queue e2e | live worker + Redis + `NGSPICE_PATH` | ❌ manual |

---

## 1. Unit / regression suites (deterministic, no external deps)

| Package | Command | Result (2026-06-16) |
|---------|---------|---------------------|
| `packages/eda-core` | `pnpm --filter @circuit-forge/eda-core test` | **320 passed** / 19 suites |
| `apps/api` (generation + netlist) | `pnpm --filter api exec jest src/generation src/netlist` | **151 passed**, 7 skipped (live), 0 failed |
| `apps/worker-sim` | `pnpm --filter @circuitforge/worker-sim test` | **22 passed** / 2 suites |
| `packages/llm-core` | `pnpm --filter @circuitforge/llm-core test` | **14 passed** |

These cover the pure domain logic with **no mocks of the logic under test** — assertion evaluation
(`evaluateAssertions`), the −3 dB cutoff locator, SPICE round-trip (`parse(generate(x))`), Monte-Carlo
perturbation + the `runMonteCarlo` orchestrator (adaptive-N, Wilson CI, three-way accounting), E-series
snapping, and the ERC rules. The Anthropic SDK + the simulation queue are mocked ONLY where the test's subject
is the surrounding logic (e.g. the design-loop control flow), and the design loop is additionally exercised
end-to-end by the live suites below.

## 2. ngspice coverage harness (real ngspice)

```bash
NGSPICE_PATH=".../ngspice_con.exe" pnpm -w run test:matrix   # 73/73 cells green (2026-06-16)
pnpm -w run test:sweep   # pairwise CircuitJson→SPICE combinations
pnpm -w run test:fuzz    # seeded safety-invariant fuzz
```

`test:matrix` runs the whole **CircuitJson → SPICE → ngspice** pipeline across a curated matrix (current-probe
remap `i(R)`→`@r[i]`, AC sweeps, analog↔digital bridges, ERC interactions, regression cases): **73/73 green**.

> ⚠️ Windows: `NGSPICE_PATH` MUST point at the real console build
> (`.../Spice64/bin/ngspice_con.exe`) — the chocolatey `bin` shim can be a GUI build that produces empty
> output silently. Set `SIM_SANDBOX=none` on the dev host (the rlimit/bwrap wrapper is Linux-only).

## 3. Real-services validation campaign (2026-06-16)

All of the following ran against real services with **no mocks**. Docker infra (Postgres / Redis / MinIO /
OTel-LGTM) was up and healthy.

| # | Suite / step | Real components exercised | Result |
|---|--------------|---------------------------|--------|
| 1 | `__live__/spec-satisfaction-live` | ngspice | **5/5** — `verified = meets-intent` on real measured numbers (divider = 5 V, sine pp, current i(R1) = 16.67 mA) |
| 2 | `__live__/verify-design-live` | ngspice | **2/2** — verify-design service over real ngspice |
| 3 | `test:matrix` | ngspice | **73/73** — full netlist pipeline |
| 4 | `__live__/sim-loop-integration.live` | TME catalog + ngspice | **1/1** — design loop: BROKEN RC (ERC001 no-ground) → fed back → fixed → re-verified clean |
| 5 | `__live__/ai-grounding-live` | **Anthropic `claude-opus-4-8`** + TME | **3/3** — the model generated an RC low-pass, an NPN common-emitter amp, and a D-flip-flop ripple counter; each grounded in real parts + server-sourced + netlist-validated (passive / active / digital). ~111 s |
| 6 | Monte-Carlo **queue e2e** | Redis + live worker + ngspice | **PASS** — a `mode:'monte-carlo'` job was enqueued on the `simulations` queue; the running worker's `handleMonteCarlo` → `runMonteCarloBatch` ran **60 perturbed variants over real ngspice** and persisted `metrics.monteCarlo` = `{ yield: 1.0, ci95: [0.94, ~1.0], evaluated: 60 }`, status `SUCCEEDED` |

Together these prove the core promise end-to-end on a running stack: the **AI generation mechanism**, the
**design loop + ERC-feedback fix**, **grounding** against the real parts catalog, **simulation** via real
ngspice, **spec-satisfaction** verdicts, and the **Monte-Carlo yield path** through the real queue.

### Reproducing the live suites

Load the secrets from the root `.env`, then (PowerShell — shell state does NOT persist between invocations, so
set env + run in ONE command; the `.env` has duplicate later lines for `NGSPICE_PATH`/`LLM_API_KEY`, so set
`NGSPICE_PATH` explicitly):

```powershell
$env:NGSPICE_PATH='.../Spice64/bin/ngspice_con.exe'; $env:SIM_SANDBOX='none'
pnpm --filter api exec jest "src/generation/__live__/spec-satisfaction-live.spec.ts"   # gate: NGSPICE_PATH
$env:SIMLOOP_LIVE='1'  # + TME_TOKEN  → sim-loop-integration.live
$env:AI_LIVE='1'       # + LLM_API_KEY + TME_TOKEN → ai-grounding-live  (spends real Anthropic tokens)
```

Monte-Carlo queue e2e: start the worker (`node apps/worker-sim/dist/main.js` with DB/Redis/S3/NGSPICE env —
run it UNFILTERED; a `Select-Object -First N` pipe closes stdout and kills the process), obliterate stale queue
jobs, then enqueue a `mode:'monte-carlo'` job and poll the `SimulationJob.metrics.monteCarlo`.

## 4. What is NOT yet covered (honest residual)

- **Full HTTP user journey** (register → login → create project → design via HTTP) — needs the API process
  booted + auth; not yet run end-to-end. The underlying design loop / grounding / simulation / Monte-Carlo are
  all validated above, so this is integration-surface coverage rather than new logic.
- **Sandbox containment on Linux** (rlimit/bwrap actually killing an over-budget process under concurrency) —
  the wrapper is verified at the argv/string level only; not live-tested on a Linux host (see SECURITY.md).
- **Security / authorization (IDOR)** — cross-tenant isolation has `checkMembership` wired but no negative
  integration test yet (the next planned hardening pass).
- **Load / concurrency** behavior under many simultaneous design+MC batches is not yet measured.
