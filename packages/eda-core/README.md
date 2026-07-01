# @circuit-forge/eda-core

Circuit manipulation, netlist generation, and SPICE parsing for the **Circuit Forge** EDA
platform. This package is the **single source of truth** for the `CircuitJson` schema shared
between the backend, the simulation worker, and the web frontend — reuse it instead of
re-declaring circuit types.

Pure TypeScript, browser-safe (only runtime dependency is [Zod](https://zod.dev) v3).

## Install

```bash
npm install @circuit-forge/eda-core
# or: pnpm add @circuit-forge/eda-core
```

## What's inside

- **Types** — `CircuitJson`, `Component`, `Net`, `PinConnection`, `UiJson`, `AnalysisConfig`,
  `SimulationResult`, `DataSeries`, `DataPoint`, `ErcResult`, and the constants
  `COMPONENT_PINS` / `SPICE_PREFIXES`.
- **Validation (Zod)** — `CircuitJsonSchema`, `UiJsonSchema`, `AnalysisConfigSchema`,
  `SpiceValueSchema`, `ProbeSchema`, plus `validate*` (throwing) and `safeValidate*`
  (result-returning) helpers.
- **Netlist** — `generateNetlist(circuit, analysisConfig, opts)` and `parseNetlist(text)`.
- **ERC** — `runErc(circuit)` returns `ErcIssue[]` (e.g. `NO_GROUND`, `MISSING_VALUE`).
- **SPICE values** — `parseSpiceValue`, `parseTimeValue`, `parseFrequencyValue`
  (remember: `M`/`m` = milli, `MEG` = mega).
- **ngspice-native analyses** — six `AnalysisConfig` types (`tran`, `ac`, `dc`, `op`, `noise`, `sens`),
  the last two (`NoiseAnalysis`, `SensAnalysis`) alongside `.four`/`.meas`/`.tf` requests riding on
  `tran`/`op`. All are REPORT-ONLY on `SimulationResult` (the base run is unaffected) via dedicated
  parsers and result types:
  - `parseFourierLog` → `FourierResult[]` (`SimulationResult.fourier`) — THD % + harmonic table from a
    `.four` request on a `tran` analysis.
  - `parseMeasurements` → `MeasurementResult[]` (`SimulationResult.measurements`) — `.meas`
    timing/extrema/integral results.
  - `parseTransferFunction` → `TransferFunctionResult` (`SimulationResult.transferFunction`) — `.tf`
    small-signal gain + input/output impedance from an `op` analysis.
  - `parseNoise` / `parseNoiseTotals` → `NoiseResult` (`SimulationResult.noise`) — `.noise` integrated
    output/input-referred totals (the per-frequency spectrum rides in `series`).
  - `parseSensitivity` → `SensitivityResult` (`SimulationResult.sensitivity`) — `.sens` DC
    sensitivity table (d(output)/d(each element)).
- **Assertion evaluation / verdict-gating** — `evaluateAssertions(measurements, criteria, simOk?)`
  is the ONE place a measurable spec is checked, shared by verify-design, the AI design loop, and the
  Monte-Carlo worker. `AcceptanceCriterion` supports 9 metrics: `min | max | final | pp | avg | rms |
  cutoff | thd | gain` (`avg`/`rms` are time-weighted/trapezoidal; `cutoff` is the −3dB AC corner; `thd`
  and `gain` are folded onto the per-node measurement from the design's own fourier/`.tf` results via
  `attachFourierThd` / `attachTransferFunction` before evaluation — so a `thd`/`gain` criterion is only
  measurable, and only gates "verified", when the analysis actually requested a matching `fourier`/`tf`).
  Also exports `compareAssertion`, `describeFailure`, `criterionDimension`, `requiredDimensions`,
  `uncoveredRequiredDimensions`.
- **Monte-Carlo / yield** — `perturbValue`, `perturbCircuit`, `monteCarloVariants`, `computeYield`,
  `runMonteCarlo` (+ `TolDistribution`, `YieldSummary`, `VariantOutcome`, `VariantRunner`,
  `MonteCarloOptions`, `MonteCarloYield`). Perturbs toleranced component values (gaussian/uniform),
  runs N variants through an injected ngspice runner, and aggregates a yield with a Wilson 95%
  confidence interval and adaptive-N early stop — the basis for "verified at X% yield" rather than
  nominal-only.
- **SPICE round-trip import** — `parseNetlist(text)` parses a netlist back to `CircuitJson`, preserving
  `.model`/`.subckt`/`.options`/`.ic` cards, importing digital/XSPICE lines (`CFD_*` models) back to
  their gate/flip-flop/latch/tristate component types, and re-merging mixed-signal nets the generator
  had split for digital bridging.
- **E-series (IEC 60063) snapping** — `nearestESeries`, `isESeriesValue`, `snapValueString`,
  `snapCircuitToESeries` — snap AI/formula-derived component values to a standard preferred-value
  series (E12/E24/…) so results stay sourceable.
- **Convergence Doctor** — `diagnoseConvergence` classifies an ngspice non-convergence failure
  (timestep collapse, singular matrix, iteration limit, …) into a plain-language explanation;
  `convergenceRemedyLadder` returns an ordered list of solver-option remedies to retry with. Shared by
  the inline API simulator and the worker so both retry the identical ladder.

## Example

```ts
import { safeValidateCircuitJson, generateNetlist, runErc } from '@circuit-forge/eda-core';

const result = safeValidateCircuitJson(circuitJsonFromApi);
if (!result.success) throw new Error('Invalid circuit');

const issues = runErc(result.data);          // electrical-rule check
const netlist = generateNetlist(result.data, { type: 'tran', stopTime: '5m', stepTime: '50u' });
```

Evaluating acceptance criteria against a simulation result (the same path verify-design, the AI design
loop, and the Monte-Carlo worker all share):

```ts
import { summarizeSeries, evaluateAssertions, type AcceptanceCriterion } from '@circuit-forge/eda-core';

const measurements = simResult.series.map((s) => summarizeSeries(s, simResult.meta.analysisType));
// one SimMeasurement per node: {node, min, max, final, pp, avg, rms, ...}
const criteria: AcceptanceCriterion[] = [
    { probe: 'v(out)', metric: 'max', op: 'lte', value: 5.5 },
];
const results = evaluateAssertions(measurements, criteria);
const verified = results.every((r) => r.pass);
```

A `thd`/`gain` criterion additionally needs the matching `.four`/`.tf` request in the `AnalysisConfig`,
and the resulting fourier/transfer-function data folded onto the measurements first:

```ts
import { attachFourierThd, attachTransferFunction, evaluateAssertions } from '@circuit-forge/eda-core';

// analysisConfig: { type: 'tran', stopTime: '5m', fourier: { fundamentalFreq: '1k', probes: ['v(out)'] } }
attachFourierThd(measurements, simResult.fourier);
const results = evaluateAssertions(measurements, [
    { probe: 'v(out)', metric: 'thd', op: 'lt', value: 5 }, // < 5% THD
]);
```

## Notes

- Component `designator` must match `^[A-Z][A-Z0-9]*[0-9]+$` (must end in a digit, e.g. `R1`, `GND1`).
- Connectivity lives only in `Component.pins[].netId` → `Net.id`; there is no flat node list.
- Diodes should omit `model` — a built-in default (`DDEFAULT`) is supplied during netlist generation.

## License

MIT
