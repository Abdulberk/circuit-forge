# Circuit Forge — Verification Methodology

> How we make "verified" mean something. The one-line version: **we never trust the AI's word — every design
> is checked against a real circuit simulator (ngspice), first at exact component values and then with
> realistic manufacturing tolerances, and labeled honestly.**

This document is written to be understood with zero EDA background first (Part A, in plain scenarios), then
precise enough for an engineer to rely on (Part B, the reference). It describes what the code actually does;
file references are to `packages/llm-core/src/design-core.ts` and `packages/eda-core/src/`.

---

## Part A — The idea, in scenarios

### Why this is the whole point
Lots of tools let an AI *draw* a circuit. Our differentiator is that we **prove it works** with a real
simulator before we say "verified." If "verified" were just the AI's opinion, the word would be worthless —
worse than worthless, because a user would trust it and ship a board that doesn't work.

### Scenario 1 — the design loop
You ask: *"a circuit that outputs 5 V from a 10 V source."*
1. The **AI generates** a circuit (a structured description — components + wires + the pass/fail checks it
   thinks matter), not raw simulator text.
2. We turn it into a real simulator deck and **run ngspice** (a real, industry SPICE engine).
3. We **check the measured result against the acceptance criteria** (e.g. "output ≈ 5 V"). ngspice is the
   ground truth — the AI's claim is irrelevant; the measurement decides.
4. If a check **fails**, we don't just say "try again" — we tell the AI *exactly* what missed and by how much
   ("output is 4.2 V, you need 5 V"), and it **fixes** the circuit. Then we re-simulate.
5. Repeat a bounded number of rounds. End state is one of: **verified**, **spec-miss** (couldn't meet the
   stated criteria), or **inconclusive** (the simulator couldn't run for an infrastructure reason — *not* the
   design's fault, so we never call that a failure).

### Scenario 2 — why "works on paper" isn't enough (the robustness tier)
A "1 kΩ resistor" from a real reel is actually 950–1050 Ω (±5%). Build 1000 boards and **every board is
slightly different.**
- A design that outputs *exactly* 5.00 V with *exact* values might output 4.75 V on a board whose resistors
  landed at the unlucky end — and if the spec was "5 V ± 0.1 V", that board is scrap.
- Checking only exact values and stamping "verified" is a half-truth.

So after the exact-value check passes, we run a **"shake test"**: build ~hundreds of *virtual* copies, each
with component values randomly varied within their real tolerance, and count how many still meet the spec.
That fraction is the **yield**. Then we label the design honestly:
- **robust** — almost all real boards will work (production-ready).
- **marginal** — works, but a meaningful fraction of boards would fail → tighten tolerances or re-center values.
- **at-risk** — passes on paper but many boards would fail → not production-robust.
- **unknown** — no tolerances were specified, so we only checked exact values (and we say exactly that).

Crucially: **the robustness tier never overturns a correct design into a "fail."** It is a *label on top of*
"verified," not a stricter gate. A correct-but-marginal design is informed, not rejected.

### Scenario 3 — being honest about the numbers
If we shake only 200 virtual boards and all pass, we **cannot** claim "100%" — the 201st might have failed.
The most we can honestly say from 200 trials is "about 99%." So we report a **statistical lower bound**, not a
fake-precise figure, and we say it's based on component spread only (not long-term drift/heat/aging). The more
virtual boards we shake, the tighter and more confident the number.

---

## Part B — The reference

### B1. The loop (`runDesignLoop`)
`generate → simulate → verify → (on miss) fix → re-simulate`, up to `maxRounds` (default 2, hard cap 4).
- **Generate** (`generateCircuit`, LLM): returns a validated `CircuitJson` + an `analysisConfig`
  (`op`/`tran`/`ac`/`dc`) + `acceptanceCriteria` + an explanation.
- **Simulate**: `generateNetlist` (deterministic CircuitJson→SPICE, no LLM) → ngspice → parsed →
  `summarizeSeries` per node.
- **Verify** (the nominal verdict): `evaluateAssertions(measurements, criteria)` →
  `specsMet = every criterion passes`, AND a **coverage gate** (`uncoveredRequiredDimensions`): if the prompt
  states a current ("10 mA") or frequency ("1 kHz") target, a criterion **must actually measure that
  quantity** or the design is not "verified" for it. `succeeded = simHealthy && specsMet && covered`.
- **Fix** (`fixCircuit`, LLM): fed the specific failing criteria with the signed gap (`actual − target`) and,
  if ngspice struggled, the convergence diagnosis — so the fix is targeted, not blind.
- **Terminal outcomes**: `ok:true, verified:true` (+ robustness, below); `ok:false` spec-miss (with the gap
  detail); or `inconclusive` (capacity/infra — explicitly *not* a design fault).

### B2. Measurements (`summarizeSeries`)
Per node: `min`, `max`, `final`, `pp` (peak-to-peak), `avg`, `rms`, and `cutoff` (−3 dB corner for AC).
`avg`/`rms` are **time-weighted** (trapezoidal over the adaptive timesteps), not sample means, because ngspice
samples non-uniformly. The verdict reads full-precision values (`raw`); display rounds to 4 sig figs.

### B3. The robustness tier (`classifyRobustness`)
After a verified design, `runYieldAnalysis` runs a **Monte-Carlo**: each toleranced component is sampled
Gaussian within its ±tolerance, the acceptance criteria are re-checked per variant, and the **yield** (pass
fraction) is computed with a **Wilson 95% confidence interval** (the correct interval near 100%, where the
naïve normal interval is unreliable) and adaptive sample count.

`classifyRobustness` grades on the **Wilson lower bound** (honest about how few runs back it) against
per-domain bars:

| Tier | Consumer default | Automotive / Medical |
|---|---|---|
| **robust** | yield-lower-bound ≥ 99% | ≥ 99.9% |
| **marginal** | 90–99% | 99–99.9% |
| **at-risk** | < 90% | < 99% |
| **unknown** | no toleranced parts / no MC → "verified at nominal only" | — |

The result carries `robustness: { tier, profile, yield, yieldLowerBound, evaluated, note }`. The yield models
**component-value spread only (short-term)** — it is *not* a long-term-drift-adjusted production figure, and
the `note` says so.

### B4. Standards grounding (defaults, configurable — never hardcoded as the only truth)
Researched and cross-verified (see `memory robustness-verdict-standards`):
- **Process capability:** Cpk ≥ **1.33** = "capable / production-ready" (≈4σ) — the consumer bar; Cpk ≥
  **1.67** = critical/automotive (AIAG PPAP / IATF 16949) + medical (≈5σ); Cpk 1.00 = the 3σ floor.
- **Component tolerances (IEC 60063):** resistor E24→±5% (the default when unspecified), E96→±1%; capacitors
  follow dielectric class (C0G/NP0 ±5%, X7R ±10%, Y5V ±20%), **not** the E-series.
- All thresholds are **domain-configurable** (`DesignDeps.robustnessProfile`: consumer | automotive | medical)
  because customer/contract requirements override any default.

### B5. Honesty principles (what we will NOT do)
- **Never false-fail a correct design.** Nominal-pass stays the gate; robustness only *labels*.
- **inconclusive ≠ fail.** A simulator/capacity problem is reported as "try again," never as a design fault.
- **No over-claiming yield** beyond what the sample count supports (Wilson lower bound, small-N flagged).
- **State the convention.** Yield is component-spread, short-term; we don't quote a long-term Six-Sigma DPMO
  we didn't measure.
- **The AI writes its own pass/fail criteria, but can't dodge the prompt** — the coverage gate forces a
  current/frequency target the user asked for to actually be measured.

### B6. Adjacent capabilities
- **Sourceability (`snapCircuitToESeries`):** snap arbitrary AI/formula values to the nearest IEC-60063
  preferred value so the design is buyable, with a per-change report. Standalone (not auto-applied), so it
  never silently changes what was simulated.
- **Power (`computeResistorPower`):** steady-state ΔV²/R per resistor (and **Vrms²/R** = true average heating
  for a grounded resistor in a transient), checked against each part's power rating — informational.

### B7. How we know the *translation layer itself* is correct
The CircuitJson→SPICE surface is exercised against **real ngspice** by committed regression tools, each
asserting the *physical* answer (not just "it ran"):
- `pnpm test:matrix` — 83 cells (device × probe × analysis + physical-relation cells: CE-amp gain sign,
  current-mirror ratio, transformer turns ratio, SCR latch, op-amp open-loop sign, IGBT current, …).
- `pnpm test:edge` — 40 engineering-grade edge cells with analytic answers (numeric extremes, convergence-hard
  circuits, degenerate topologies that must fail loud, analysis edge cases, RC/−3 dB/op-amp-gain/RMS physics).
- `pnpm test:sweep` — 200 driver×load pairwise combinations.
- `pnpm test:fuzz` — seeded random circuits asserting the safety invariant (finite data **or** a loud,
  diagnosable failure — never silent-wrong output).

### B8. Multi-candidate (when `DESIGN_CANDIDATES_N > 1`; ships dark at N=1)
Generate N diverse candidates → cheap nominal screen → pick the best K finalists (ranked by spec coverage then
robustness margin) → run the full fix-loop on each → Monte-Carlo + the robustness tier on the **winner only**
(bounded cost). At N=1 this is byte-identical to the single-loop path above.
