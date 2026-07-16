<div align="center">

# @circuit-forge/eda-core

**The EDA brain of [Circuit Forge](https://github.com/Abdulberk/circuit-forge):**
typed circuits → SPICE netlists → parsed results → *measured* pass/fail verdicts → tolerance robustness.

[![npm](https://img.shields.io/npm/v/%40circuit-forge%2Feda-core?logo=npm&color=CB3837)](https://www.npmjs.com/package/@circuit-forge/eda-core)
[![license](https://img.shields.io/npm/l/%40circuit-forge%2Feda-core?color=blue)](https://github.com/Abdulberk/circuit-forge/blob/main/packages/eda-core/LICENSE)
![types](https://img.shields.io/badge/types-included-3178C6?logo=typescript&logoColor=white)
![runtime deps](https://img.shields.io/badge/runtime%20deps-zod%20only-3E67B1)
![tested](https://img.shields.io/badge/tested-real%20ngspice%20battery-2EA44F)

</div>

Pure, deterministic TypeScript. **No I/O** — no filesystem, no network, no child processes:
you bring the ngspice binary, this library does everything around it. Browser-safe;
the only runtime dependency is [Zod](https://zod.dev).

```bash
npm install @circuit-forge/eda-core     # or: pnpm add @circuit-forge/eda-core
```

---

## ⏱️ 60 seconds: circuit → verdict

```ts
import {
  safeValidateCircuitJson, runErc, generateNetlist,
  parseSimulationOutput, extractProbes, summarizeSeries,
  evaluateAssertions, type AcceptanceCriterion,
} from '@circuit-forge/eda-core';

// 1 · A circuit is plain, typed JSON — one schema shared by API, worker, and UI
const circuit = {
  version: '1.0',
  components: [
    { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5',
      pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: '0' }] },
    { id: 'r1', type: 'resistor', designator: 'R1', value: '1k',
      pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
    { id: 'r2', type: 'resistor', designator: 'R2', value: '1k',
      pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: '0' }] },
  ],
  nets: [
    { id: 'in', name: 'in' }, { id: 'out', name: 'out' },
    { id: '0', name: '0', isGround: true },
  ],
};

// 2 · Validate + electrical-rule-check
const parsed = safeValidateCircuitJson(circuit);
if (!parsed.success) throw new Error('invalid circuit');
runErc(parsed.data);                       // → [] (no NO_GROUND / MISSING_VALUE / … findings)

// 3 · Generate a sanitized SPICE deck
const netlist = generateNetlist(parsed.data, { type: 'op' });

// 4 · Run it with YOUR ngspice:  `ngspice -b circuit.cir`  → output.csv
//     (this library never spawns processes — deck in, results out)

// 5 · Parse → distill → judge against the stated spec
const result = parseSimulationOutput(csv, extractProbes(netlist), 'op');
const measurements = result.series.map((s) => summarizeSeries(s, 'op'));

const criteria: AcceptanceCriterion[] = [
  { probe: 'v(out)', metric: 'final', op: 'approx', value: 2.5, tol: 0.05, label: 'V(out) ≈ 2.5 V' },
];
const verdict = evaluateAssertions(measurements, criteria, true, parsed.data.nets);
// → [{ label: 'V(out) ≈ 2.5 V', actual: 2.5, pass: true,
//      detail: 'final(v(out)) = 2.5 ✓ approx 2.5' }]
```

Every criterion answers with the **measured value** and its signed distance to target —
an unmeasurable probe is `actual: null` and **never** a silent pass.

---

## 🗺️ What's in the box

| Area | Key exports | What it does |
|---|---|---|
| 🧩 **Types & validation** | `CircuitJson` · `AnalysisConfig` · `CircuitJsonSchema` · `safeValidate*` | One shared, Zod-validated schema for circuits and analyses |
| ⚡ **Netlist generation** | `generateNetlist` · `applySolverOptions` | CircuitJson → SPICE deck: R/L/C, transformers, controlled & behavioral sources, diodes/Zener, BJT/MOSFET/JFET, switches, SCR, IGBT, op-amp `.subckt` macromodels, probes, `.ic` |
| 🛡️ **SPICE safety** | `sanitizeNetlist` · `sanitizeNodeName` · `SecurityError` | Hostile-input defense: shell-metachar rejection, `.include` whitelisting, reserved-word renaming |
| 🔍 **ERC** | `runErc` | Electrical rule check with coded findings (`NO_GROUND`, `MISSING_VALUE`, …) |
| 📊 **Result parsing** | `parseSimulationOutput` · `parseFourierLog` · `parseMeasurements` · `parseTransferFunction` · `parseNoise` · `parseSensitivity` · `downsampleResult` | ngspice CSV / raw / log output → typed series & report metrics |
| ⚖️ **Verdicts** | `summarizeSeries` · `evaluateAssertions` · `attachFourierThd` · `attachTransferFunction` | Distill per-node measurements, judge them against acceptance criteria (`min · max · final · pp · avg · rms · cutoff · thd · gain`) |
| 🎲 **Robustness** | `runMonteCarlo` · `runWorstCase` · `runParametricSweep` · `perturbCircuit` | Monte-Carlo yield (Wilson CI), 2ᵏ ±tolerance corners, parameter sweeps |
| 🩺 **Convergence** | `diagnoseConvergence` · `convergenceRemedyLadder` · `assessTransientCompleteness` | Classify a failed/truncated run and get an ordered solver-remedy ladder |
| 🔁 **Interchange** | `parseNetlist` · `resultToCsv` · `resultToVcd` | Import standard SPICE decks (LTspice/KiCad round-trip, incl. digital/XSPICE), export results |
| 🔧 **Value utils** | `parseSpiceValue` · `formatSpiceValue` · `snapCircuitToESeries` · `cutoffFrequency` | SPICE number grammar (`M` ≠ `MEG`!), IEC 60063 E-series snapping, −3 dB corner |

---

## 🎲 Robustness in three lines

A design that only works at nominal isn't a design. Components carrying a `tolerance`
field are perturbed (Monte-Carlo) or set to their ±tol extremes (worst-case). You inject
the runner — `(variant) => measurements | null` — so *any* ngspice transport works
(`null` counts as *errored*, never as a false fail):

```ts
import { runMonteCarlo, runWorstCase } from '@circuit-forge/eda-core';

const mc = await runMonteCarlo(circuit, criteria, runVariant, { n: 200, seed: 1 });
// → { yield: 0.985, passed: 197, failed: 3, errored: 0, evaluated: 200, … }  (Wilson-scored)

const wc = await runWorstCase(circuit, criteria, {}, runVariant);
// → { passAllCorners: true, evaluated: 4, worstCorners: [], … }              (2ᵏ corners)
```

THD / gain criteria ride on the matching analysis request, then gate like any other metric:

```ts
// analysis: { type: 'tran', stopTime: '5m', fourier: { fundamentalFreq: '1k', probes: ['v(out)'] } }
attachFourierThd(measurements, simResult.fourier);
evaluateAssertions(measurements, [{ probe: 'v(out)', metric: 'thd', op: 'lt', value: 5 }]); // < 5 % THD
```

---

## 📐 Design principles

- **Pure & deterministic** — same input, same output. No hidden state, no I/O; trivially testable.
- **Built for untrusted input** — the sanitizer assumes netlists can be hostile (it powers a multi-tenant SaaS).
- **Honest verdicts** — no-data / all-NaN / missing probe → `actual: null`; a spec is never satisfied by silence.
- **Battle-tested** — 480+ unit tests plus a real-ngspice regression battery (83-cell device×analysis matrix,
  edge cases, pairwise sweeps, seeded fuzz) in the monorepo CI, against a pinned, drift-guarded engine.

## 📎 Good to know

- `designator` must match `^[A-Z][A-Z0-9]*[0-9]+$` (ends in a digit: `R1`, `GND1`).
- Connectivity lives only in `Component.pins[].netId` → `Net.id` — there is no flat node list.
- SPICE numbers: `M`/`m` = **milli**, `MEG` = mega. `parseSpiceValue('1M')` → `0.001`.
- Diodes may omit `model` — a built-in default is supplied during generation.

## 📚 More

- [EDA core deep-dive](https://github.com/Abdulberk/circuit-forge/blob/main/docs/EDA_CORE.md) — circuit model, netlist generation, analyses
- [What "verified" means](https://github.com/Abdulberk/circuit-forge/blob/main/VERIFICATION.md) — the evidence contract
- [Circuit Forge monorepo](https://github.com/Abdulberk/circuit-forge) — the platform this package powers

## License

[MIT](https://github.com/Abdulberk/circuit-forge/blob/main/packages/eda-core/LICENSE)
