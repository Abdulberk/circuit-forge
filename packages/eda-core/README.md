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

## Example

```ts
import { safeValidateCircuitJson, generateNetlist, runErc } from '@circuit-forge/eda-core';

const result = safeValidateCircuitJson(circuitJsonFromApi);
if (!result.success) throw new Error('Invalid circuit');

const issues = runErc(result.data);          // electrical-rule check
const netlist = generateNetlist(result.data, { type: 'tran', stopTime: '5m', stepTime: '50u' });
```

## Notes

- Component `designator` must match `^[A-Z][A-Z0-9]*[0-9]+$` (must end in a digit, e.g. `R1`, `GND1`).
- Connectivity lives only in `Component.pins[].netId` → `Net.id`; there is no flat node list.
- Diodes should omit `model` — a built-in default (`DDEFAULT`) is supplied during netlist generation.

## License

MIT
