# EDA Core Libraries Reference

This document is the authoritative reference for the two core EDA packages in the
circuit-forge monorepo:

- **`@circuitforge/eda-core`** — the canonical circuit model, SPICE netlist generation,
  netlist sanitization/security, simulation-output parsing, netlist parsing, Electrical
  Rule Check (ERC), Zod validation schemas, and unit utilities.
- **`@circuitforge/llm-core`** — currently a **stub** for future LLM-driven circuit
  generation.

Every statement below is derived strictly from the source. Primary files:

- [packages/eda-core/src/index.ts](../packages/eda-core/src/index.ts) — public export surface
- [packages/eda-core/src/types/circuit.ts](../packages/eda-core/src/types/circuit.ts)
- [packages/eda-core/src/types/analysis.ts](../packages/eda-core/src/types/analysis.ts)
- [packages/eda-core/src/types/simulation.ts](../packages/eda-core/src/types/simulation.ts)
- [packages/eda-core/src/types/erc.ts](../packages/eda-core/src/types/erc.ts)
- [packages/eda-core/src/schemas/circuit.schema.ts](../packages/eda-core/src/schemas/circuit.schema.ts)
- [packages/eda-core/src/schemas/analysis.schema.ts](../packages/eda-core/src/schemas/analysis.schema.ts)
- [packages/eda-core/src/netlist/generator.ts](../packages/eda-core/src/netlist/generator.ts)
- [packages/eda-core/src/netlist/sanitizer.ts](../packages/eda-core/src/netlist/sanitizer.ts)
- [packages/eda-core/src/parser/csv-parser.ts](../packages/eda-core/src/parser/csv-parser.ts)
- [packages/eda-core/src/parser/netlist-parser.ts](../packages/eda-core/src/parser/netlist-parser.ts)
- [packages/eda-core/src/erc/checker.ts](../packages/eda-core/src/erc/checker.ts)
- [packages/eda-core/src/erc/codes.ts](../packages/eda-core/src/erc/codes.ts)
- [packages/eda-core/src/utils/unit-parser.ts](../packages/eda-core/src/utils/unit-parser.ts)
- [packages/llm-core/src/index.ts](../packages/llm-core/src/index.ts)

> Build/tooling note: this is a **pnpm-only** monorepo (pnpm@8.14.1 + turbo). Internal
> packages depend on each other via `workspace:*`, so `npm install` will crash. Always use
> `pnpm`. See [LOCAL_SETUP.md](../LOCAL_SETUP.md).

---

## 1. The Circuit JSON Format

`CircuitJson` is the canonical in-memory representation of a circuit. It is defined as a
TypeScript interface in [types/circuit.ts](../packages/eda-core/src/types/circuit.ts) and
mirrored by a Zod schema (`CircuitJsonSchema`) in
[schemas/circuit.schema.ts](../packages/eda-core/src/schemas/circuit.schema.ts).

### 1.1 Top-level shape

```ts
interface CircuitJson {
    version: string;        // must match /^\d+\.\d+$/  (e.g. "1.0")
    components: Component[]; // max 1000
    nets: Net[];             // max 1000
    metadata?: CircuitMetadata;
}
```

### 1.2 `Component`

A component carries a **`pins` array** of `{ pinId, netId }` connections. There is no flat
node list — connectivity is expressed entirely through pins referencing net IDs.

```ts
interface Component {
    id: string;            // 1..100 chars; unique within circuit
    type: ComponentType;   // see supported types below
    designator: string;    // matches /^[A-Z][A-Z0-9]*[0-9]+$/i  e.g. "R1", "V1"
    value?: string;        // max 100 chars; "10k", "100n", "5", "SIN(0 1 1k)"
    model?: string;        // max 100 chars; model name (diodes)
    pins: PinConnection[]; // 1..20 entries
    properties?: Record<string, unknown>; // optional, schema only
}

interface PinConnection {
    pinId: string; // 1..50 chars
    netId: string; // 1..100 chars; references Net.id
}
```

> Note: `properties` exists in the Zod `ComponentSchema` and the `Component` interface, but
> the netlist generator never reads it.

### 1.3 `Net`

```ts
interface Net {
    id: string;       // 1..100 chars
    name: string;     // 1..100 chars (required by the schema)
    isGround?: boolean;
}
```

A net is treated as ground when `isGround === true`. The generator maps ground nets to SPICE
node `'0'`; non-ground net IDs are sanitized (see §2/§3).

### 1.4 `CircuitMetadata`

```ts
interface CircuitMetadata {
    name?: string;        // max 200
    description?: string; // max 2000
    author?: string;      // max 100
    createdAt?: string;
    updatedAt?: string;
}
```

### 1.5 UI layout (separate from electrical model)

Visual layout is **not** part of `CircuitJson`. It is a separate `UiJson`
(`UiJsonSchema`) holding `viewport` (`{x, y, zoom>0}`), `positions`
(`Record<id, {x, y, rotation?}>` where rotation is one of `'0' | '90' | '180' | '270'`), and
`wires` (`{netId, points: {x,y}[]}`). This keeps electrical connectivity independent of
rendering.

### 1.6 Correct example

```json
{
  "version": "1.0",
  "components": [
    {
      "id": "v1",
      "type": "voltage_source",
      "designator": "V1",
      "value": "DC 5",
      "pins": [
        { "pinId": "+", "netId": "vin" },
        { "pinId": "-", "netId": "gnd" }
      ]
    },
    {
      "id": "r1",
      "type": "resistor",
      "designator": "R1",
      "value": "1k",
      "pins": [
        { "pinId": "1", "netId": "vin" },
        { "pinId": "2", "netId": "vout" }
      ]
    },
    {
      "id": "c1",
      "type": "capacitor",
      "designator": "C1",
      "value": "100n",
      "pins": [
        { "pinId": "1", "netId": "vout" },
        { "pinId": "2", "netId": "gnd" }
      ]
    },
    {
      "id": "gnd1",
      "type": "ground",
      "designator": "GND1",
      "pins": [{ "pinId": "1", "netId": "gnd" }]
    }
  ],
  "nets": [
    { "id": "vin", "name": "VIN" },
    { "id": "vout", "name": "VOUT" },
    { "id": "gnd", "name": "GND", "isGround": true }
  ],
  "metadata": { "name": "RC Low-Pass Filter" }
}
```

### 1.7 Supported component types and SPICE mapping

Component types are enumerated by `ComponentType` /
`ComponentTypeSchema`. The SPICE element prefix per type comes from `SPICE_PREFIXES`, the
canonical pin names from `COMPONENT_PINS`, and the line format from `componentToSpice()` in
[generator.ts](../packages/eda-core/src/netlist/generator.ts).

| Type | SPICE prefix | Canonical pins (`COMPONENT_PINS`) | Generated SPICE line | Notes |
|------|--------------|-----------------------------------|----------------------|-------|
| `resistor` | `R` | `['1','2']` | `R1 <n1> <n2> <value\|0>` | value defaults to `0` if missing |
| `capacitor` | `C` | `['1','2']` | `C1 <n1> <n2> <value\|0>` | value defaults to `0` |
| `inductor` | `L` | `['1','2']` | `L1 <n1> <n2> <value\|0>` | value defaults to `0` |
| `voltage_source` | `V` | `['+','-']` | `V1 <n+> <n-> <value\|'DC 0'>` | value defaults to `DC 0` |
| `current_source` | `I` | `['+','-']` | `I1 <n+> <n-> <value\|'DC 0'>` | value defaults to `DC 0` |
| `diode` | `D` | `['anode','cathode']` | `D1 <anode> <cathode> <model\|'DDEFAULT'>` | uses `DDEFAULT` model if `model` is absent |
| `ground` | `''` (none) | `['1']` | *(no line emitted)* | `componentToSpice` returns `null`; ground is realized as node `'0'` |

Behavioral details from `componentToSpice()`:

- `ground` components produce **no** netlist line (`return null`); they exist only to mark a
  net as the `'0'` reference.
- Nodes are emitted in the **order of the `pins` array** — `pins.map(pin => nodeMap.get(pin.netId))`.
  The generator does not reorder by `pinId`, so pin order in the array is significant.
- An unknown `type` (no `SPICE_PREFIXES` entry) throws `Unknown component type: <type>`.
- A pin referencing a net not present in the node map throws
  `Net not found: <netId> for component <designator>`.

---

## 2. Netlist Generation (`generateNetlist`)

Source: [netlist/generator.ts](../packages/eda-core/src/netlist/generator.ts).

```ts
function generateNetlist(
  circuit: CircuitJson,
  analysis: AnalysisConfig,
  options?: NetlistOptions,
): string

interface NetlistOptions {
  title?: string;
  probes?: string[];
  includeFiles?: string[];
  outputFormat?: 'csv' | 'raw'; // accepted but not used in output construction
  jobDir?: string;              // enables include-path validation
}
```

The output is assembled line-by-line in this exact order:

1. **Title block** (comment lines):
   - `* <title>` where `title = options.title || circuit.metadata?.name || 'Untitled Circuit'`
   - `* Generated by eda-core`
   - `* <ISO timestamp>` (`new Date().toISOString()`)
   - blank line
2. **Node map** built by `buildNodeMap(circuit.nets)` (see §2.1).
3. **Default diode model** — emitted only if any component is a `diode` **without** a `model`:
   - `* Default diode model`
   - the model line (see §2.2)
   - blank line
4. **Include files** — only if `options.includeFiles` is non-empty:
   - if `options.jobDir` is set, `validateIncludePaths(includeFiles, jobDir)` runs first (may throw `SecurityError`)
   - `* Include files`
   - one `.include "<file>"` line per file
   - blank line
5. **Components** — `* Components`, then one SPICE line per non-ground component.
6. **Analysis** — `* Analysis`, then the single command from `analysisToSpice(analysis)` (§6).
7. **Control block** for output (see §2.3).
8. Trailing blank line, then `.end`.

### 2.1 Node map (`buildNodeMap`)

For each net:

- if `net.isGround` is true → mapped to `'0'`
- otherwise → mapped to `sanitizeNodeName(net.id)` (§3.2)

`getNodeNames(circuit)` is a public helper returning `Array.from(buildNodeMap(...).values())`
— all unique SPICE node names (including `'0'` if a ground net exists).

### 2.2 Default diode model

```spice
.model DDEFAULT D(IS=1e-14 N=1.05 RS=10 BV=100 IBV=1e-10)
```

Emitted once if at least one diode lacks an explicit `model`. Diodes without a model reference
`DDEFAULT` in their element line.

### 2.3 The `.control` block

Probes are `options.probes` if provided, else `generateDefaultProbes(circuit, nodeMap)` (§2.4).
The block is always:

```spice
* Control block
.control
  set filetype=ascii
  run
  wrdata output.csv <probe1> <probe2> ...
  quit
.endc
```

- The `wrdata output.csv ...` line is emitted **only if there is at least one probe**; probes
  are space-joined.
- The output filename is hardcoded as `output.csv`.
- `set filetype=ascii` forces ASCII (text) output so the CSV parser can read it.

### 2.4 Default probes

`generateDefaultProbes` emits `v(<nodeName>)` for **every non-ground net**, using the sanitized
node name from the node map. Ground nets are excluded (no `v(0)`).

### 2.5 `validateNetlist`

`validateNetlist(netlist)` does a basic structural check on raw netlist text and returns
`{ valid, errors }`. It is satisfied when the netlist contains:

- a `.end` line, and
- at least one analysis directive: a line starting with `.tran`, `.ac`, `.dc`, or `.op` (case-insensitive).

It reports `Netlist missing .end statement` and/or
`Netlist missing analysis command (.tran, .ac, .dc, or .op)` otherwise. It does **not**
validate component syntax.

---

## 3. SPICE Security / Sanitization

Source: [netlist/sanitizer.ts](../packages/eda-core/src/netlist/sanitizer.ts). See also
[docs/SECURITY.md](SECURITY.md).

### 3.1 Reserved words

`RESERVED_WORDS` (a `Set`, compared case-insensitively in `sanitizeNodeName`):

```
all, none, in, out, vcc, vdd, vss, gnd, ground
```

### 3.2 `sanitizeNodeName(name): string`

Transforms an arbitrary net ID into a safe SPICE node name, applied in order:

1. Replace every character not in `[a-zA-Z0-9_]` with `_`.
2. If the result starts with a digit (`/^[0-9]/`), prefix with `n`.
3. If the (lowercased) result is a reserved word, prefix with `x_`.
4. If empty, set to `node`.
5. If it does not already start with `n` or `x_`, prefix with `n`.

The leading `n`/`x_` convention guarantees the name never collides with the ground node `'0'`
and never begins with a digit. Examples: `vin` → `nvin`; `1net` → `n1net` → `nn1net`; `gnd` →
`x_gnd`; `net-a` → `nnet_a`.

### 3.3 `sanitizeValue(value): string`

Strips dangerous characters from a component value, keeping only
`[a-zA-Z0-9 ()+\-.,_]` (alphanumerics, whitespace, parentheses, plus/minus, dot, comma,
underscore), then `.trim()`. This preserves valid SPICE values like `SIN(0 1 1k)` and `DC 5`
while removing shell-sensitive characters.

### 3.4 `validateDesignator(designator): boolean`

Returns `true` only if the designator matches `/^[A-Za-z][A-Za-z0-9]*[0-9]+$/` — must start
with a letter, contain only alphanumerics, and **end with a digit** (e.g. `R1`, `V12`; rejects
`R`, `1R`, `R1A`).

### 3.5 `hasShellMetacharacters(str): boolean`

Returns `true` if the string contains any of the following shell-injection characters:

```
; & | ` $ < > \ ! # { } [ ] * ? ' "
```

(Regex: `/[;&|`$<>\\!#{}[\]*?'"]/`.)

### 3.6 Include-path validation

`validateIncludePath(includePath, _jobDir)` throws `SecurityError` (with a code) when a path is
unsafe. `validateIncludePaths(paths, jobDir)` loops over an array calling the single-path
validator. Rules and resulting `SecurityError.code`:

| Rule (in order) | Condition | Error code |
|-----------------|-----------|------------|
| Reject absolute paths | starts with `/` **or** matches `^[A-Za-z]:` (Windows drive) | `ABSOLUTE_PATH` |
| Reject path traversal | contains `..` | `PATH_TRAVERSAL` |
| Reject special prefixes | starts with `~` or `$` | `SPECIAL_PREFIX` |
| Restrict character set | not fully matching `^[a-zA-Z0-9_\-./]+$` | `INVALID_CHARS` |

> The `_jobDir` parameter is currently unused inside `validateIncludePath` (the underscore
> name flags this). Validation is purely lexical; it does not resolve against the real job
> directory on disk.

### 3.7 `sanitizeNetlist(netlist, jobDir): string`

Scans a netlist line-by-line (lower-cased for matching):

- For any `.include` line, extracts the path via
  `/\.include\s+["']?([^"'\s]+)["']?/i` and runs `validateIncludePath` on it.
- Throws `SecurityError('Shell commands not allowed in netlist', 'SHELL_COMMAND')` for any line
  starting with `.shell` or `.system`.
- Otherwise passes lines through unchanged and returns the rejoined text.

### 3.8 `SecurityError`

```ts
class SecurityError extends Error {
  readonly code: string; // e.g. 'ABSOLUTE_PATH', 'PATH_TRAVERSAL', 'SPECIAL_PREFIX',
                         //      'INVALID_CHARS', 'SHELL_COMMAND'
  // name === 'SecurityError'
}
```

---

## 4. Parsing

### 4.1 Simulation output parsing

Source: [parser/csv-parser.ts](../packages/eda-core/src/parser/csv-parser.ts). All parsers
return a `SimulationResult` (§5.x types from simulation.ts).

| Function | Signature | Behavior |
|----------|-----------|----------|
| `parseCsv` | `(csvContent, probeNames, analysisType='tran') => SimulationResult` | Parses ngspice `wrdata` ASCII output: whitespace-separated columns, first column = X axis, subsequent columns = Y for each probe. |
| `parseRawAscii` | `(rawContent, analysisType='tran') => SimulationResult` | Parses ngspice raw ASCII format (`Variables:` / `Values:` blocks). |
| `detectOutputFormat` | `(content) => 'csv' \| 'raw' \| 'unknown'` | Sniffs format from the first lines. |
| `parseSimulationOutput` | `(content, probeNames, analysisType='tran') => SimulationResult` | Auto-detects format then dispatches to `parseCsv`/`parseRawAscii`. |

**`parseCsv` details:**

- Splits on newlines; skips empty lines and lines beginning with `#` or `*`.
- Each data row is split on `/\s+/` and `parseFloat`-mapped. Rows with fewer than 2 numeric
  values are skipped; a row whose first value (`x`) is `NaN`/undefined is skipped.
- For each probe `i`, the Y value at column `i+1` is appended as `{ x, y }` to
  `series[i].points` (skipping `NaN`/undefined Y). Series are created in `probeNames` order, so
  probe-to-column alignment depends on the caller passing names in the same order the netlist
  wrote them.
- Empty input yields an empty result (`buildMeta` with `pointsCount: 0`).

**`parseRawAscii` details:**

- Recognizes header lines `No. Variables:`, `No. Points:`, `Variables:`, variable-definition
  lines matching `^\d+\s+[\w()]+` (captures the 2nd token as the variable name), and data start
  markers `Values:` / `Binary:`.
- Complex values like `re,im` are reduced to their **real part** (`parseFloat(split(',')[0])`).
- Builds one series per variable after the first (index 0 is treated as the X axis); rows with
  any `NaN` are dropped.

**`detectOutputFormat` details:**

- Returns `'raw'` if the first 10 lines contain `Plotname:` or `No. Variables:`.
- Returns `'csv'` if the first non-comment data line matches `^[\d.eE+\-\s]+$`.
- Otherwise `'unknown'` — `parseSimulationOutput` then throws
  `Unknown output format. Content starts with: ...`.

**`buildMeta`** sets X-axis labels/units by analysis type: `tran` → `time`/`s`, `ac` →
`frequency`/`Hz`, `dc` → `voltage`/`V`, `op` → `point`/(no unit). `pointsCount` comes from the
first series' length.

### 4.2 Netlist parsing (`parseNetlist`)

Source: [parser/netlist-parser.ts](../packages/eda-core/src/parser/netlist-parser.ts). This is
the inverse of generation — it reconstructs a `CircuitJson` from SPICE text (for import).

```ts
function parseNetlist(netlist: string): NetlistParseResult

interface NetlistParseResult {
  circuit: CircuitJson;
  analysis?: AnalysisConfig;
  title?: string;
  errors: string[];
  warnings: string[];
}
```

Behavior:

- **Title**: the first line is used as the title if it does not start with `.` or `*`.
- **Designator prefix → type** mapping (`PREFIX_TO_TYPE`, first character upper-cased):
  `R`→resistor, `C`→capacitor, `L`→inductor, `V`→voltage_source, `I`→current_source,
  `D`→diode. Unknown prefixes are skipped and recorded as a warning
  (`Line N: Could not parse: ...`).
- Component lines need ≥3 whitespace tokens. Per type:
  - R/C/L → pins `1`/`2`, `value = parts.slice(3).join(' ') || '0'`.
  - V/I → pins `+`/`-`, `value = parts.slice(3).join(' ') || 'DC 0'`.
  - D → pins `anode`/`cathode`, `model = parts[3]` (may be undefined).
- Generated component `id` is `<prefix-lower><counter>` (e.g. `r1`, `r2`).
- **Nets** are collected from referenced node tokens; a net is `isGround` when its name is `'0'`
  or (case-insensitive) `gnd`.
- If a ground net exists, a synthetic `ground` component (`id: 'gnd1'`, `designator: 'GND'`,
  one pin on the ground net) is appended.
- Returns `version: '1.0'` and `metadata.name = title`.
- **Analysis directives** (`parseDirective`):
  - `.tran step stop [start]` → `{ type:'tran', stepTime, stopTime, startTime? }`
  - `.ac dec|oct|lin points fstart fstop` → `{ type:'ac', variation, points, startFreq, stopFreq }`
  - `.dc source start stop increment` → `{ type:'dc', source, startVal, stopVal, increment }`
  - `.op` → `{ type:'op' }`

> Note on round-tripping: the generator emits analysis as a `.tran`/`.ac`/... directive but
> writes probes inside a `.control { wrdata ... }` block. `parseDirective` reads the analysis
> line; `extractProbes` (below) reads the probe list separately.

### 4.3 `extractProbes(netlist): string[]`

Scans lines (lower-cased) for probe sources and returns a de-duplicated list:

- Lines starting with `wrdata`: takes tokens after the command and filename
  (`split(/\s+/).slice(2)`), keeping those that start with `v(` or `i(`.
- Lines starting with `print` or `.print`: takes tokens after the command
  (`slice(1)`), keeping `v(`/`i(` tokens.
- Duplicates removed via `Set`.

---

## 5. ERC — Electrical Rule Check

Sources: [erc/checker.ts](../packages/eda-core/src/erc/checker.ts),
[erc/codes.ts](../packages/eda-core/src/erc/codes.ts),
[types/erc.ts](../packages/eda-core/src/types/erc.ts).

### 5.1 Entry points

```ts
function runErc(circuit: CircuitJson): ErcResult
function quickCheck(circuit: CircuitJson): boolean // === runErc(circuit).passed
```

`runErc` executes all checks (in this order): `checkEmptyCircuit`, `checkGround`,
`checkFloatingNodes`, `checkPinCounts`, `checkComponentValues`, `checkVoltageSourceShorts`,
`checkNetConnections`, `checkActiveSources`. It returns:

```ts
interface ErcResult {
  passed: boolean; // true iff there are zero 'error'-severity issues
  issues: ErcIssue[];
  summary: { errors: number; warnings: number; infos: number };
}

interface ErcIssue {
  code: ErcCode;
  severity: 'error' | 'warning' | 'info';
  message: string;     // ERC_DESCRIPTIONS[code], optionally "<desc>: <details>"
  relatedIds: string[];// component/net ids involved
}
```

Each issue's default severity comes from `ERC_SEVERITIES[code]` (a per-call
`severityOverride` is supported by `createIssue` but no current check passes one). The
`ErcConfig` interface (`checkFloatingNodes`, `requireGround`, `checkMissingModels`,
`severityOverrides`) is defined in types but is **not** consumed by `runErc` today.

### 5.2 Codes, descriptions, severities

From `ErcCode` (enum values are the `ERCnnn` strings) plus `ERC_DESCRIPTIONS` and
`ERC_SEVERITIES`:

| Code | Enum name | Default severity | Description | Emitted by |
|------|-----------|------------------|-------------|------------|
| `ERC001` | `NO_GROUND` | error | Circuit has no ground reference (node 0) | `checkGround` |
| `ERC002` | `MULTIPLE_GROUNDS` | warning | Circuit has multiple ground components on different nets | `checkGround` |
| `ERC010` | `FLOATING_NODE` | warning | Node is not connected to any power or ground path | *(defined; not currently emitted)* |
| `ERC011` | `FLOATING_INPUT` | warning | Component input pin is floating | *(defined; not currently emitted)* |
| `ERC020` | `VOLTAGE_SOURCE_SHORT` | error | Voltage source output is shorted to ground | `checkVoltageSourceShorts` |
| `ERC021` | `PARALLEL_VOLTAGE_SOURCES` | error | Parallel voltage sources with different values | `checkVoltageSourceShorts` |
| `ERC030` | `MISSING_VALUE` | error | Component is missing required value | `checkComponentValues` |
| `ERC031` | `INVALID_VALUE` | error | Component has invalid or unparseable value | *(defined; not currently emitted)* |
| `ERC032` | `PIN_COUNT_MISMATCH` | error | Component has incorrect number of pins for its type | `checkPinCounts` |
| `ERC033` | `MISSING_MODEL` | warning | Component requires a model but none specified | `checkComponentValues` |
| `ERC040` | `UNCONNECTED_NET` | info | Net defined but not connected to any components | `checkFloatingNodes`, `checkNetConnections` |
| `ERC041` | `NET_HAS_SINGLE_PIN` | warning | Net has only one pin connection (dead end) | `checkFloatingNodes` |
| `ERC050` | `EMPTY_CIRCUIT` | error | Circuit contains no components | `checkEmptyCircuit` |
| `ERC051` | `NO_ACTIVE_COMPONENTS` | warning | Circuit has no active sources or inputs | `checkActiveSources` |

### 5.3 Rule logic (what each check actually does)

- **`checkEmptyCircuit`** — counts components excluding `ground`; if zero → `EMPTY_CIRCUIT`.
- **`checkGround`** — ground is satisfied if there is any `ground` component, any net with
  `isGround`, or any net whose `id`/`name` is `'0'`; otherwise `NO_GROUND`. If there is more
  than one `ground` component and their first pins land on **different** nets → `MULTIPLE_GROUNDS`.
- **`checkFloatingNodes`** — tallies pin counts per net. For each **non-ground** net (ground =
  `isGround` or id/name `'0'`): pin count `0` → `UNCONNECTED_NET`; pin count `1` →
  `NET_HAS_SINGLE_PIN`.
- **`checkPinCounts`** — compares `component.pins.length` against `EXPECTED_PIN_COUNTS`
  (resistor/capacitor/inductor/voltage_source/current_source/diode = `2`, ground = `1`); a
  mismatch → `PIN_COUNT_MISMATCH`.
- **`checkComponentValues`** — components in `{resistor, capacitor, inductor, voltage_source,
  current_source}` missing `value` → `MISSING_VALUE`; `diode` missing `model` →
  `MISSING_MODEL` (warning).
- **`checkVoltageSourceShorts`** — for each `voltage_source`, if its `+` and `-` pins are on the
  same net → `VOLTAGE_SOURCE_SHORT`. It also groups voltage sources by their (order-insensitive)
  `+:-` net pair; if two or more share a pair with **different** values → `PARALLEL_VOLTAGE_SOURCES`.
- **`checkNetConnections`** — for each net not referenced by any component pin and not ground
  (and not id `'0'`) → `UNCONNECTED_NET`.
- **`checkActiveSources`** — if the circuit has components but none is a `voltage_source` or
  `current_source` → `NO_ACTIVE_COMPONENTS`.

---

## 6. Analysis Configuration Schemas

Types: [types/analysis.ts](../packages/eda-core/src/types/analysis.ts). Zod schemas:
[schemas/analysis.schema.ts](../packages/eda-core/src/schemas/analysis.schema.ts).
`AnalysisConfig` is a discriminated union on `type`.

### 6.1 Field reference (real field names)

**Transient — `type: 'tran'`** (`TranAnalysisSchema`)

| Field | Type | Required | SPICE value |
|-------|------|----------|-------------|
| `stopTime` | SpiceValue string | yes | end time |
| `stepTime` | SpiceValue string | no | print/step time (default computed: `stopTime / 1000`) |
| `startTime` | SpiceValue string | no | default `0` |
| `maxStep` | SpiceValue string | no | max integration step |
| `uic` | boolean | no | append `uic` |

**AC — `type: 'ac'`** (`AcAnalysisSchema`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `variation` | `'dec' \| 'oct' \| 'lin'` | yes | sweep mode |
| `points` | int, `>0`, `≤10000` | yes | points per decade/octave or total for `lin` |
| `startFreq` | SpiceValue string | yes | start frequency |
| `stopFreq` | SpiceValue string | yes | stop frequency |

**DC sweep — `type: 'dc'`** (`DcAnalysisSchema`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `source` | string matching `/^[A-Z][A-Z0-9]*[0-9]+$/i` | yes | source designator, e.g. `V1` |
| `startVal` | SpiceValue string | yes | sweep start |
| `stopVal` | SpiceValue string | yes | sweep stop |
| `increment` | SpiceValue string | yes | step size |

**Operating point — `type: 'op'`** (`OpAnalysisSchema`) — no fields beyond `type`.

### 6.2 `analysisToSpice(config)` output

| Type | Generated command |
|------|--------------------|
| `tran` | `.tran <stepTime\|default> <stopTime> <startTime\|0>` then ` <maxStep>` if set, then ` uic` if `uic` is true |
| `ac` | `.ac <variation> <points> <startFreq> <stopFreq>` |
| `dc` | `.dc <source> <startVal> <stopVal> <increment>` |
| `op` | `.op` |

The default transient step is `formatSpiceValue(parseSpiceValue(stopTime) / 1000)` — one
thousandth of the stop time. (These `parseSpiceValue`/`formatSpiceValue` live in
`types/analysis.ts` and are distinct from the richer ones in `utils/unit-parser.ts`; see §7.)

### 6.3 `SpiceValue`, `Probe`, and simulation-request regexes

| Schema | Regex | Meaning |
|--------|-------|---------|
| `SpiceValueSchema` | `/^[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?\s*[a-zA-Z]*$/` | optional sign, decimal/scientific number, optional whitespace, optional alpha suffix (e.g. `10k`, `1.5e-3`, `100n`, `5V`) |
| `ProbeSchema` | `/^[vi]\([a-zA-Z0-9_]+(?:,[a-zA-Z0-9_]+)?\)$/i` | `v(node)` or `i(device)`, optional second node for differential, e.g. `v(n1)`, `v(out,in)`, `i(R1)` |
| `SimulationRequestSchema` | object | `{ analysisConfig: AnalysisConfig, probes?: Probe[] (≤100), modelAssets?: UUID[] (≤10) }` |

Validation helpers: `validateAnalysisConfig` / `safeValidateAnalysisConfig` (parse vs.
safe-parse) and `validateSimulationRequest`.

> `simulation.ts` also exposes a runtime `Probe` interface and `parseProbe(probe)` which
> classifies a probe string as `voltage`/`current` (defaulting to voltage and wrapping bare
> names as `v(name)`), plus `generateDefaultProbes(nodeNames)` which emits `v(name)` for every
> node except `'0'`.

---

## 7. Unit-Parser Utilities

Source: [utils/unit-parser.ts](../packages/eda-core/src/utils/unit-parser.ts). Exported via the
package root.

| Export | Signature | Purpose |
|--------|-----------|---------|
| `parseSpiceValue` | `(input: string) => ParsedValue` | Parse a SPICE value+optional unit into `{ value, unit?, original, isValid, error? }`. Non-throwing. |
| `formatSpiceValue` | `(value: number, unit?: string) => string` | Format a number with an engineering suffix (`T/G/MEG/K`/none/`m/u/n/p/f`) and optional unit. |
| `normalizeValue` | `(input: string) => number` | `parseSpiceValue(input).value`, or `0` if invalid. |
| `valuesEqual` | `(a, b, tolerance=1e-9) => boolean` | Relative-tolerance comparison of two SPICE value strings. |
| `parseTimeValue` | `(input: string) => number` | Parse to seconds (thin wrapper over `parseSpiceValue`). |
| `parseFrequencyValue` | `(input: string) => number` | Parse to Hz (thin wrapper over `parseSpiceValue`). |
| `ParsedValue` (type) | — | Result object: `{ value, unit?, original, isValid, error? }`. |

`parseSpiceValue` details:

- Pure numbers (matching `^-?\d*\.?\d+$`) return immediately as valid.
- Otherwise matched against `^(-?\d*\.?\d+)\s*([A-Za-z]+)?$/i`; the alpha part is upper-cased.
- Multiplier suffixes (`SPICE_SUFFIXES`): `T=1e12, G=1e9, MEG=1e6, K=1e3, M=1e-3, U=1e-6,
  N=1e-9, P=1e-12, F=1e-15, MIL=25.4e-6`. `MEG` and `MIL` are checked as 3-letter prefixes
  before single letters, so e.g. `47pF` → `4.7e-11` with `unit: 'F'`, and `10MEG` → `1e7`.
- Trailing letters after the multiplier are treated as a unit and expanded via `UNIT_ABBREVS`
  (`OHM→Ω`, `HZ→Hz`, `VOLT(S)→V`, `AMP(S)/AMPERE(S)→A`, `WATT(S)→W`, `FARAD→F`, `HENRY→H`,
  `SECOND(S)/SEC→s`, etc.). If the entire suffix is not a known multiplier, the whole thing is
  treated as a unit.

> Important: per SPICE convention, **`M` / `m` mean *milli* (1e-3)**, not mega; use `MEG` for
> 1e6. This holds in both unit-parsers.

---

## 8. Public API — `@circuitforge/eda-core`

The complete export surface of [index.ts](../packages/eda-core/src/index.ts). "Kind" notes
whether each is a type-only export (`type`), value/function, class, const, or enum.

### Types

| Name | Kind | Purpose |
|------|------|---------|
| `CircuitJson` | type | Canonical circuit (version, components, nets, metadata). |
| `Component` | type | A circuit element with `pins` array. |
| `Net` | type | Electrical net (`id`, `name`, `isGround?`). |
| `PinConnection` | type | `{ pinId, netId }` pin-to-net link. |
| `ComponentType` | type | Union of supported component type strings. |
| `CircuitMetadata` | type | Optional circuit metadata. |
| `UiJson` | type | Layout data (viewport, positions, wires). |
| `Viewport` | type | Pan/zoom state. |
| `Position` | type | Component placement (`x`, `y`, `rotation?`). |
| `Wire` | type | Visual wire path for a net. |
| `AnalysisConfig` | type | Discriminated union of analyses. |
| `TranAnalysis` / `AcAnalysis` / `DcAnalysis` / `OpAnalysis` | type | Per-analysis config shapes. |
| `SimulationResult` | type | `{ meta, series }` parsed output. |
| `DataSeries` | type | One signal's `{ name, unit?, points }`. |
| `DataPoint` | type | `{ x, y }`. |
| `ResultMeta` | type | Output metadata (analysisType, xLabel, xUnit?, pointsCount, simulationTime?). |
| `ErcResult` | type | ERC outcome (`passed`, `issues`, `summary`). |
| `ErcIssue` | type | A single ERC finding. |
| `ErcConfig` | type | ERC options (defined; not consumed by `runErc`). |
| `ErcSeverity` | type | `'error' \| 'warning' \| 'info'`. |
| `NetlistOptions` | type | Options for `generateNetlist`. |
| `NetlistParseResult` | type | Result of `parseNetlist`. |
| `ParsedValue` | type | Result of unit `parseSpiceValue`. |
| `CircuitJsonInput` / `CircuitJsonOutput` | type | Zod input/output of `CircuitJsonSchema`. |
| `ComponentInput` / `NetInput` / `UiJsonInput` | type | Zod input types. |
| `AnalysisConfigInput` / `AnalysisConfigOutput` | type | Zod input/output of analysis schema. |
| `SimulationRequestInput` | type | Zod input of simulation-request schema. |

### Enums / constants

| Name | Kind | Purpose |
|------|------|---------|
| `ErcCode` | enum | ERC codes (`ERC001`…`ERC051`). |
| `COMPONENT_PINS` | const | Canonical pin names per component type. |
| `SPICE_PREFIXES` | const | SPICE element prefix per component type. |
| `ERC_DESCRIPTIONS` | const | Human-readable text per ERC code. |
| `ERC_SEVERITIES` | const | Default severity per ERC code. |

### Schemas (Zod) & validators

| Name | Kind | Purpose |
|------|------|---------|
| `CircuitJsonSchema` | const (Zod) | Validate `CircuitJson`. |
| `ComponentSchema` / `NetSchema` / `PinConnectionSchema` / `CircuitMetadataSchema` | const (Zod) | Validate sub-shapes. |
| `ComponentTypeSchema` | const (Zod) | Enum of component types. |
| `ViewportSchema` / `PositionSchema` / `WireSchema` / `UiJsonSchema` | const (Zod) | Validate UI layout. |
| `validateCircuitJson` | fn | Parse `CircuitJson` (throws on error). |
| `safeValidateCircuitJson` | fn | Safe-parse `CircuitJson`. |
| `validateUiJson` | fn | Parse `UiJson`. |
| `AnalysisConfigSchema` | const (Zod) | Discriminated-union analysis validator. |
| `TranAnalysisSchema` / `AcAnalysisSchema` / `DcAnalysisSchema` / `OpAnalysisSchema` | const (Zod) | Per-analysis validators. |
| `SpiceValueSchema` | const (Zod) | SPICE value-string validator. |
| `ProbeSchema` | const (Zod) | `v(...)`/`i(...)` probe validator. |
| `SimulationRequestSchema` | const (Zod) | Validate `{ analysisConfig, probes?, modelAssets? }`. |
| `validateAnalysisConfig` | fn | Parse analysis config. |
| `safeValidateAnalysisConfig` | fn | Safe-parse analysis config. |
| `validateSimulationRequest` | fn | Parse a simulation request. |

### Netlist generation & sanitization

| Name | Kind | Purpose |
|------|------|---------|
| `generateNetlist` | fn | Build a SPICE netlist from circuit + analysis (+ options). |
| `getNodeNames` | fn | All unique SPICE node names for a circuit. |
| `validateNetlist` | fn | Basic structural validation of netlist text. |
| `sanitizeNodeName` | fn | Make a net ID SPICE-safe. |
| `sanitizeValue` | fn | Strip dangerous characters from a value string. |
| `validateDesignator` | fn | Validate designator format (returns boolean). |
| `hasShellMetacharacters` | fn | Detect shell-injection characters. |
| `validateIncludePath` | fn | Validate one include path (throws `SecurityError`). |
| `validateIncludePaths` | fn | Validate an array of include paths. |
| `sanitizeNetlist` | fn | Scan netlist for unsafe `.include`/`.shell`/`.system`. |
| `SecurityError` | class | Error with `.code` for security violations. |

### Parsing

| Name | Kind | Purpose |
|------|------|---------|
| `parseCsv` | fn | Parse ngspice `wrdata` CSV/ASCII to `SimulationResult`. |
| `parseRawAscii` | fn | Parse ngspice raw ASCII to `SimulationResult`. |
| `detectOutputFormat` | fn | Detect `'csv' \| 'raw' \| 'unknown'`. |
| `parseSimulationOutput` | fn | Auto-detect format and parse. |
| `parseNetlist` | fn | Parse SPICE text back to `CircuitJson` (+ analysis). |
| `extractProbes` | fn | Pull `v(...)`/`i(...)` probes from a netlist. |

### ERC

| Name | Kind | Purpose |
|------|------|---------|
| `runErc` | fn | Run all ERC checks; return `ErcResult`. |
| `quickCheck` | fn | Boolean pass/fail (`runErc(...).passed`). |

### Utilities

| Name | Kind | Purpose |
|------|------|---------|
| `parseSpiceValue` | fn | Parse SPICE value+unit → `ParsedValue`. |
| `formatSpiceValue` | fn | Format number → engineering string. |
| `normalizeValue` | fn | Value as a plain number (0 if invalid). |
| `valuesEqual` | fn | Tolerance comparison of two value strings. |
| `parseTimeValue` | fn | Parse to seconds. |
| `parseFrequencyValue` | fn | Parse to Hz. |

> Not re-exported from the package root (internal/module-level helpers): `analysisToSpice`,
> `getAnalysisType`, and the analysis-module `parseSpiceValue`/`formatSpiceValue` in
> [types/analysis.ts](../packages/eda-core/src/types/analysis.ts); and `Probe`, `parseProbe`,
> `generateDefaultProbes`, `SimulationMetrics` in
> [types/simulation.ts](../packages/eda-core/src/types/simulation.ts). They are used internally
> (e.g. the generator calls `analysisToSpice`).

---

## 9. `@circuitforge/llm-core` — Stub

Source: [packages/llm-core/src/index.ts](../packages/llm-core/src/index.ts).

**This package is a stub.** Its own header comment says: *"This is a stub implementation for
future LLM integration."* No real model calls are made. It currently exposes:

| Export | Kind | Behavior |
|--------|------|----------|
| `LlmProvider` | interface | Contract: `generateCircuit(prompt) => Promise<CircuitJson>`, `explainCircuit(circuit) => Promise<string>`, `suggestImprovements(circuit) => Promise<string[]>`. |
| `LlmConfig` | interface | `{ provider: 'openai' \| 'anthropic' \| 'local'; apiKey?; model?; maxTokens?; temperature? }`. |
| `StubLlmProvider` | class | Implements `LlmProvider`; **every method throws** `Error('LLM integration not yet implemented. This is a stub provider.')`. Constructor accepts an optional `LlmConfig` but does nothing with it. |
| `promptTemplates` | const | Three string templates (`generateCircuit`, `explainCircuit`, `suggestImprovements`) with `{{requirements}}` / `{{circuit}}` placeholders. Not wired to any model. |
| `createLlmProvider` | fn | Factory that **always** returns a `StubLlmProvider(config)`, regardless of `config.provider`. |

It imports `CircuitJson` as a type from `@circuitforge/eda-core` (internal `workspace:*`
dependency). There is no networking, SDK usage, or environment-variable reading in this package
as written.

---

## See also

- [README.md](../README.md) — project overview and quick start
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — system architecture
- [docs/API.md](API.md) — HTTP API reference
- [docs/DATA_MODEL.md](DATA_MODEL.md) — persistence / Prisma data model
- [docs/EDA_CORE.md](EDA_CORE.md) — this document
- [docs/SIMULATION.md](SIMULATION.md) — simulation pipeline (worker-sim + ngspice)
- [docs/SECURITY.md](SECURITY.md) — security model and sanitization
- [LOCAL_SETUP.md](../LOCAL_SETUP.md) — local environment setup (pnpm, infra, ngspice)
