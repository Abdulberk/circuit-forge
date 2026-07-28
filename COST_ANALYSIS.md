# Circuit Forge — Cost Analysis

> Comprehensive unit-economics + infrastructure cost model. Last updated 2026-07-01.
> **Headline:** the LLM provider bills **per request** (flat $250/mo = 107,142 requests/mo on Opus 4.8), so
> token counts are irrelevant to cost — **the unit that matters is "requests per design"**. Compute (ngspice)
> is cheap and is **not** the bottleneck; the binding daily constraint is the LLM request cap. A small AWS
> footprint serves it. Marginal cost per design is **~$0.002–0.023** (LLM requests only); the real cost is the
> **fixed ~$320–430/mo baseline** amortized over volume, and it scales in **$250 steps** (one LLM subscription
> per ~10.7k multi-candidate or ~53k simple designs/month).

---

## 1. Method — what is measured vs assumed

| Input | Source | Confidence |
|---|---|---|
| LLM price: **$250/mo flat = 3,571 req/day (107,142/mo), Opus 4.8**; a "request" = one *successful completion* (tool-use does **not** add requests) | Founder-provided | **Exact** |
| ngspice CPU per sim + per Monte-Carlo batch | **Measured** on the real worker code (`scripts/cost-measure.mjs`) | High (dev box; see §10) |
| Requests per design | **Derived** from the loop (`runDesignLoop`) + the vetted multi-candidate plan | Exact (deterministic) |
| AWS EC2 / RDS / S3 prices | Live research, us-east-1 on-demand (×730 h/mo) | Exact us-east-1; eu-central-1 ≈ +14% compute / +11% RDS / +20% m-family |
| TME parts API | Verified: free with an API key (Token+Secret), sandbox, no published per-call fee | High |
| Per-segment usage volumes | **Assumed** (refine with real data) | Placeholder |

---

## 2. The LLM cost model (the dominant + binding cost)

Billing is **flat-rate by request count**, not tokens. One Opus-4.8 subscription:

- **$250 / month → 107,142 requests/month (3,571/day).**
- **Effective cost per request (at full utilization): $250 / 107,142 = `$0.002333`.**
- **Marginal cost within the daily cap ≈ $0** (you already paid the $250). Cost grows in **$250 steps**: each extra subscription adds 107,142 req/mo.
- The cap is **daily** (3,571/day) — a burst limit. Unused daily quota cannot be banked; peak-day load is what matters.

### Requests per design (the key multiplier)

Derived from the loop (1 generate + one request per AI-fix round; Monte-Carlo uses **zero** LLM requests — it is pure ngspice):

| Scenario | Requests / design | Notes |
|---|---|---|
| **N=1, best** (verifies first shot) | **1** | the common case for simple, well-specified circuits |
| **N=1, typical** (`maxRounds=2`) | 1–2 | one generate, maybe one fix |
| **N=1, worst** (`maxRounds=4`, never converges) | 4 | generate + 3 fixes |
| **Multi-candidate N=4 / K=2, typical** (`maxRounds=2`) | ~6 | 4 generates + 2 finalists × 1 fix |
| **Multi-candidate N=4 / K=2, worst** (`maxRounds=4`) | ~10 | 4 generates + 2 finalists × 3 fixes |
| **Multi-candidate N=5 / K=2, worst** | ~11 | hard cap of the plan |

### LLM cost + daily capacity per scenario (one $250 sub)

| Scenario | Req/design | **LLM $/design** | **Designs/day** (3,571 cap) | **Designs/month** (~per $250) |
|---|---|---|---|---|
| N=1 best | 1 | $0.0023 | 3,571 | ~107,000 |
| N=1 typical | 2 | $0.0047 | 1,785 | ~53,500 |
| N=1 worst | 4 | $0.0093 | 893 | ~26,800 |
| Multi-cand typical | 6 | $0.0140 | 595 | ~17,800 |
| **Multi-cand worst** | 10 | $0.0233 | 357 | ~10,700 |

> **Takeaway:** multi-candidate consumes the request budget ~5× faster than a simple design. That is its true
> cost — not dollars, but **how fast it burns the daily cap**. The vetted plan minimizes this by running the
> full fix-loop on only K=2 finalists and Monte-Carlo on the winner **only**.

> **Update (2026-07-01):** the adaptive-N + Wilson-CI Monte-Carlo-on-winner design described above is **shipped**,
> not just planned (`packages/eda-core/src/montecarlo.ts`, wired into the design loop; worker `runMonteCarloBatch`
> runs real ngspice per variant). Separately, the "verified" verdict is now **gated** on THD and small-signal GAIN
> (2026-06-30, `robust-THD` / `robust-GAIN`, evaluated at nominal + across tolerance variants via the same
> Monte-Carlo machinery). Both are **CPU-only** — they add ngspice work on the design's own analysis, **zero**
> additional LLM requests — so the request-billing unit economics in this section are unchanged.

---

## 3. Compute (ngspice) — measured, and why it is NOT the bottleneck

> **Update (2026-07-01):** 5 additional ngspice-native analyses have shipped since the table below was measured
> — fourier/THD, `.meas`, `.tf`, `.noise`, `.sens` — all **report-only** (surfaced on `SimulationResult`, never
> auto-run). They add a modest extra ngspice invocation **only when a design's config requests them**, and do
> **not** change the request-billing unit economics below: still **0 LLM requests**, CPU-only. The timing table
> below predates these analyses and has not been re-measured with them enabled; treat it as directionally valid,
> not exact, for designs that opt into the new analyses.

Measured on the real worker (`runSimulation` / `runMonteCarloBatch`):

| Operation | Measured time |
|---|---|
| `op` sim (divider) | ~36 ms warm (235 ms cold first-spawn) |
| `tran` sim (RC, 512 points) | ~45 ms |
| `ac` sim (101 points) | ~42 ms |
| Monte-Carlo **per variant** | ~36 ms |
| **Monte-Carlo batch (clean, high-yield design)** | **~381 variants** at the consumer bar. The old ~61-variant figure came from a fixed ±3% half-width stop that has been removed: it capped the Wilson lower bound at 0.9408, below every shipped `robustMin`, so a flawless design could never reach the top tier. Sizing now targets the bar (`requiredRunsForBar`), which is ~6× the CPU per batch — the numbers below predate that and understate it |
| Monte-Carlo batch (cap 300, op-class) | ~11 s |
| Monte-Carlo batch (slow/long-tran variants) | up to the **60 s** per-batch budget cap |

**CPU per design:** ~0.04–10 s with MC off; **~2–12 s typical with MC on** (op/ac/short-tran), up to ~60–70 s
worst (long transient + MC).

**Why compute is not the bottleneck:** with the plan's process-global ngspice semaphore at ~2–4 concurrent
spawns, a single small worker does **thousands–tens-of-thousands of designs/day** (e.g. 4 concurrent × 86,400 s
× 0.7 util ÷ 10 s ≈ ~24,000/day). That dwarfs the LLM cap (357–1,785 designs/day). **One modest worker keeps
up with the $250 LLM ceiling with room to spare.** Compute marginal cost per design ≈ **$0** (fixed box).

---

## 4. Recommended AWS footprint (cost-optimal, us-east-1)

Compute is not the constraint, so the worker is sized small; the API is light (I/O-bound); Redis is co-located
on the API box (founder choice — self-hosted); object storage uses S3 (cheaper + zero-ops than self-hosted
MinIO at this volume, and S3↔EC2 transfer is free in-region).

| Component | Pick | On-demand $/mo | 1-yr RI (no-upfront) $/mo |
|---|---|---|---|
| **LLM** (Opus 4.8, 107,142 req/mo) | custom provider | **$250** | $250 |
| **Worker** (ngspice, compute) | `c7g.large` 2 vCPU (lean) → `c7g.xlarge` 4 vCPU (comfortable) | $53 → $106 | $35 → $70 |
| **API + Redis** (self-hosted Redis co-located) | `t4g.medium` 2 vCPU / 4 GiB | $24.5 | $15.3 |
| **Postgres** | RDS `db.t4g.micro` Single-AZ (MVP) → `t4g.small` Multi-AZ (prod HA) | $11.7 → $47 | $7.4 → $30 |
| RDS storage (gp3, ~20 GB) | — | ~$2.3 | ~$2.3 |
| EBS gp3 for EC2 (root + /tmp sim, ~40 GB total) | $0.08/GB-mo | ~$3.2 | ~$3.2 |
| S3 (result JSON, small) | $0.023/GB-mo + tiny requests | ~$1–5 | ~$1–5 |
| **Graviton4 alt for worker** | `c8g.large` ($58) — +30% perf ≈ same price | optional | — |

**Baselines:**
- **Lean MVP (single AZ, on-demand):** $250 + 53 + 24.5 + 11.7 + ~8.5 ≈ **~$348/mo**
- **Lean MVP (1-yr RI on EC2/RDS):** ≈ **~$314/mo**
- **Comfortable/prod (xlarge worker + Multi-AZ RDS, RI):** ≈ **~$420/mo** (+ HA)

> Region note: **eu-central-1 (Frankfurt)** adds ~+14% on compute, ~+11% on RDS, ~+20% on the m-family vs
> us-east-1. If EU data residency matters, add ~10–15% to the infra (not LLM) portion.

---

## 5. Cost per circuit generation — best / typical / worst

Two numbers matter: **marginal** (the incremental cost of one more design within the paid capacity) and
**fully-loaded** (total monthly cost ÷ designs that month — what it "really" costs at a given volume).

### Marginal $/design (incremental; compute ≈ free within capacity)
| Case | Marginal $/design |
|---|---|
| **Best** — N=1 first-shot, MC off (1 req) | **$0.0023** |
| Typical — N=1, MC on, 2 req | $0.0047 |
| Multi-candidate typical (6 req) | $0.014 |
| **Worst** — multi-candidate N=5/K=2, MC on (~11 req) | **$0.026** |

### Fully-loaded $/design (lean ~$348/mo baseline ÷ monthly volume)
| Monthly design volume | Fully-loaded $/design | Comment |
|---|---|---|
| 500 / mo | **$0.70** | fixed cost dominates — paying for unused capacity |
| 2,000 / mo | $0.17 | |
| 10,000 / mo | $0.035 | |
| ~53,500 / mo (N=1-typical at the $250 cap) | **$0.0065** | LLM ceiling reached on one sub |
| Beyond cap | + $250 LLM step per +107k req | worker still fine |

> **Best case overall:** high utilization + simple designs → **~$0.006–0.0065/design** fully-loaded.
> **Worst case overall:** low volume (fixed dominates, up to ~$0.70/design) OR heaviest config (multi-candidate
> worst, ~$0.026 marginal). **Typical pro usage (~5k designs/mo, mixed):** **~$0.05–0.10/design** fully-loaded.

---

## 6. Sensitivity — how each parameter moves the cost

| Lever | Effect on cost | Magnitude |
|---|---|---|
| **Multi-candidate N** | linear in requests (each candidate = 1 generate) | N=4 → ~3–5× the requests of N=1 → 5× faster cap burn |
| **K finalists** | each finalist adds up to (maxRounds−1) fix requests | K=2→3 ≈ +3 requests/design |
| **maxRounds** | each extra round = at most +1 request (if it doesn't verify sooner) | 2→4 ≈ up to +2 requests on hard designs |
| **Monte-Carlo on/off** | **+0 LLM requests**; +CPU only (~2–60 s) | ≈ $0 marginal $ (compute is the fixed box) |
| **MC variant cap / adaptive-N** | clean designs stop ~60 variants regardless of cap | minimal — adaptive-N already protects cost |
| **Circuit complexity / analysis type** | bigger/long-tran → more CPU per sim & per MC variant | pushes MC toward the 60 s budget; still ~$0 marginal $ |
| **Grounding (TME tool-use)** | **+0 requests** (provider counts a successful completion, tools free) + TME calls (free) | ≈ $0 |
| **Prompt size / tokens** | **irrelevant** under request-based billing | $0 |

> The single biggest cost dial is **multi-candidate N** (request consumption). Everything that costs CPU (MC,
> complexity) is effectively free in dollars until the worker saturates — which it won't before the LLM cap.

---

## 7. Scaling — the $250 step model

Cost grows almost entirely in **LLM-subscription steps**, because one small worker outpaces the LLM cap:

| Monthly design volume (multi-candidate worst, ~10 req) | LLM subs | Worker | ~Total $/mo |
|---|---|---|---|
| ≤ 10,700 | 1 × $250 | 1 × c7g.large | ~$348 |
| ≤ 21,400 | 2 × $250 | 1 × c7g.large (still fine) | ~$598 |
| ≤ 53,500 | 5 × $250 | 1–2 × c7g.large | ~$1,600 |
| (simple N=1-typical, ~2 req) ≤ 53,500 | 1 × $250 | 1 × c7g.large | ~$348 |

> Mental model: **"+$250/mo per ~10.7k multi-candidate designs (or ~53k simple designs)."** Add a second
> worker only at multiple-subscription scale. RDS/S3 growth is negligible at this scale.

---

## 8. Cost by user segment (assumed profiles — refine with real data)

| Segment | Designs/user/mo | Profile | Req/user/mo | **LLM $/user/mo** (marginal) |
|---|---|---|---|---|
| **Free / hobby** | ~8 | N=1, MC off, ≤2 rounds | ~12 | ~$0.03 |
| **Pro / indie** | ~60 | mix N=1 + some multi-candidate, MC on | ~300 | ~$0.70 |
| **Team** (per seat) | ~150 | heavy, multi-candidate, MC | ~900 | ~$2.10 |
| **Enterprise** | 1,000+ | all features, multi-candidate | ~8,000+ | ~$19+ (may warrant a dedicated sub) |

Add amortized fixed infra (~$320–430/mo) across the active base. At, say, 200 free + 50 pro + a couple of
teams, the fixed baseline dominates and per-user infra is cents — **the cost structure strongly favors growth**
(marginal users are nearly free until the LLM cap, then +$250 steps). This is the input for the pricing tiers
(to be designed together): a Free tier is cheap to sustain; Pro/Team must cover the $250 step they trigger.

---

## 9. Parts / sourcing APIs

- **TME** (current): **free** with an API key (Token+Secret) — no published per-call fee; sandbox available;
  rate-limited (handle via the existing per-MPN caching + retry-after-cap). Marginal cost ≈ **$0**. In the async
  design path grounding is currently a no-op (worker), so designs incur **zero** parts-API cost today.
- **Future multi-distributor** (not yet integrated): Digi-Key API v4 (free tier), Mouser (free), TrustedParts
  (free, multi-distributor) cover lifecycle/EOL at $0. **Nexar/Octopart** lifecycle add-ons are the paid option
  (~$150–800/mo community-reported) — only needed for premium "design-verification reports"; gate behind the
  paid tier and cache aggressively (stock 15 min / pricing 1 h / lifecycle 24 h) to avoid per-match billing spirals.

---

## 10. Caveats & assumptions

- **ngspice timings measured on the Windows dev host** (`ngspice_con.exe`). Linux EC2 (Graviton/x86, apk
  ngspice) is the same order; spawn overhead may differ. Pad ~1.5× for safety in capacity planning — it does
  not change the conclusion (compute ≪ LLM cap).
- **AWS prices** exact for us-east-1 on-demand (×730 h). eu-central-1 premium noted in §4. 1-yr no-upfront RI /
  Compute Savings Plan ≈ −33% (compute/RDS), −37% (burstable). RDS gp3 storage ≈ $0.115/GB-mo (verify on console).
- **LLM request semantics** (founder-confirmed): a request = one *successful completion*; tool-use turns do
  **not** add requests. This is unusually favorable vs standard token billing — grounding/tool-use is free.
- The **daily** 3,571 cap is a burst limit; sizing for peak day, not monthly average, is what avoids hitting it.
- Per-segment volumes in §8 are **placeholders** — replace with measured usage before setting prices.

---

## 11. Key levers to reduce cost

1. **Cap multi-candidate N** (default 1, recommend 4, hard max 5) and **K=2** — the dominant request dial.
2. **MC-only-on-winner** (already in the plan) — keeps MC at 1 batch/design, and MC costs $0 in LLM anyway.
3. **1-yr Reserved/Savings Plan** on EC2 + RDS once steady — ≈ −33% on the infra portion.
4. **First-shot quality** (better prompts/grounding/topology retrieval) — every design that verifies in round 1
   is 1 request instead of 2–4; on hard designs this is the cheapest lever (fewer fix rounds = fewer requests).
5. **Aggressive parts-API caching** before adding any paid Nexar tier.
6. **Single small worker + co-located Redis** until multi-subscription scale; don't over-provision compute —
   it is not the bottleneck.

## 12. Request-billing validation (the one unverified assumption)

Every number above rests on **one assumption that code cannot confirm**: that the zentio gateway bills per
**completed generation**, not per **`messages.create` HTTP call**. A grounded design that takes, say, 4 tool
round-trips makes ~5 HTTP calls; if the gateway bills per call, the real request consumption is **~5× our
estimate** and the quota math (107k req/mo) is off by that factor. The worker (multi-candidate) path is
**exempt** — it uses `noopGround`, so it is tool-LESS (exactly 1 HTTP call per generate/fix). The exposure is
the **grounded SYNC path** (API `generate`/`design`).

**Instrumentation (shipped):** `GenerateCircuitConfig.onLlmRequest` fires once per BILLED HTTP call —
**including the single transient retry**, which the token accounting (`tokensUsed`) silently misses. Each host
tags by path: `api:generate` / `api:design` (grounded sync) and `worker` (tool-less control). Grep the logs
for `llm.request`.

**One-time experiment to settle it** (self-contained — needs nothing outside this section):

Pre-req: an **isolated zentio key window** — no other traffic on the key during the run, or background calls
pollute the invoice delta `D` (this is where the experiment most often goes wrong).

1. Hit the API grounded `POST /generate-circuit` **once** with a part-heavy prompt (one that triggers several
   catalog lookups — e.g. *"a 5 V 1 A linear regulator from a 12 V input; pick real parts for the pass
   transistor and the reference"*), with catalog grounding configured (`TME_TOKEN`/`TME_SECRET` set).
2. **`H` = the count of `llm.request path=api:generate` log lines emitted BY THAT RUN** — read it from the
   ACTUAL logs, NOT from a theoretical tool-call count. (Each line is one billed `messages.create`; a transient
   retry shows as `attempt:2` and is counted, so it lands in `H` — and, being a real billed call, in `D` too,
   keeping the comparison apples-to-apples.)
3. Read the zentio dashboard/invoice request counter **immediately before and after** the run → delta `D`.
4. **Repeat 2–3×** and confirm `H` is stable run-to-run before trusting the `H` vs `D` comparison.

Interpretation:

| Observation | Billing model | Action |
|---|---|---|
| **D ≈ 1** (per run, any `H`) | per-COMPLETION | Cost model in §§ above stands — no change. |
| **D ≈ H** | per-HTTP-call | Multiply the grounded-path request estimates by the avg tool-rounds-per-design (`H̄`) and **re-derive the 107k-req/mo quota headroom** in §§ above; revisit pricing/launch. |

Leave the `onLlmRequest` logging on as **permanent telemetry** afterwards: a request-rate metric is the leading
indicator for the binding constraint (the request cap, not compute). The `worker` path (tool-less, `noopGround`)
is the control — it should show exactly **1** `llm.request` per generate/fix, the baseline `H=1` to read the
grounded paths against.
