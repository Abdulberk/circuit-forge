/**
 * ERC (Electrical Rule Check) Checker
 * Validates circuits for common electrical issues
 */
import type { CircuitJson, Component } from '../types/circuit';
import { isDigitalType, isLogicGateType, isSingleInputGate, digitalPinRole } from '../types/circuit';
import { ErcCode, ErcSeverity, ErcResult, ErcIssue } from '../types/erc';
import { ERC_DESCRIPTIONS, ERC_SEVERITIES } from './codes';
import { buildZenerModel, normalizeControlledSourceGain, parseTransformerParams, parseTransmissionLineParams } from '../models/library';
import { sourceHighLevel, sourceLowLevel } from '../netlist/digital';

/**
 * Expected pin counts for each component type
 */
const EXPECTED_PIN_COUNTS: Record<string, number> = {
    resistor: 2,
    capacitor: 2,
    inductor: 2,
    transformer: 4, // p+,p-,s+,s-
    tline: 4, // a+,a-,b+,b-
    voltage_source: 2,
    current_source: 2,
    vcvs: 4,
    vccs: 4,
    bsource: 2,
    switch: 4,
    diode: 2,
    zener: 2,
    bjt: 3,
    mosfet: 4,
    jfet: 3,
    ground: 1,
    // `generic` is intentionally absent (variable arity) — pin-count check is skipped for it.
};

/**
 * Components that are considered active sources
 */
const ACTIVE_SOURCES = ['voltage_source', 'current_source'];

/**
 * Run all ERC checks on a circuit
 */
export function runErc(circuit: CircuitJson): ErcResult {
    const issues: ErcIssue[] = [];

    // Run all checks
    issues.push(...checkEmptyCircuit(circuit));
    issues.push(...checkGround(circuit));
    issues.push(...checkFloatingNodes(circuit));
    issues.push(...checkPinCounts(circuit));
    issues.push(...checkComponentValues(circuit));
    issues.push(...checkModelResolution(circuit));
    issues.push(...checkVoltageSourceShorts(circuit));
    issues.push(...checkNetConnections(circuit));
    issues.push(...checkActiveSources(circuit));
    issues.push(...checkDigitalConnectivity(circuit));

    // Categorize by severity
    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');
    const infos = issues.filter((i) => i.severity === 'info');

    return {
        passed: errors.length === 0,
        issues,
        summary: {
            errors: errors.length,
            warnings: warnings.length,
            infos: infos.length,
        },
    };
}

/**
 * Create an ERC issue
 */
function createIssue(
    code: ErcCode,
    relatedIds: string[],
    details?: string,
    severityOverride?: ErcSeverity,
): ErcIssue {
    return {
        code,
        severity: severityOverride || ERC_SEVERITIES[code],
        message: details ? `${ERC_DESCRIPTIONS[code]}: ${details}` : ERC_DESCRIPTIONS[code],
        relatedIds,
    };
}

/**
 * Check if circuit is empty
 */
function checkEmptyCircuit(circuit: CircuitJson): ErcIssue[] {
    const issues: ErcIssue[] = [];

    // Filter out ground components for this check
    const nonGroundComponents = circuit.components.filter((c) => c.type !== 'ground');

    if (nonGroundComponents.length === 0) {
        issues.push(createIssue(ErcCode.EMPTY_CIRCUIT, []));
    }

    return issues;
}

/**
 * Check for ground reference
 */
function checkGround(circuit: CircuitJson): ErcIssue[] {
    const issues: ErcIssue[] = [];

    // Find ground components
    const groundComponents = circuit.components.filter((c) => c.type === 'ground');

    // Find nets marked as ground
    const groundNets = circuit.nets.filter((n) => n.isGround);

    // Check if there's at least one ground reference
    const hasNodeZero = circuit.nets.some((n) => n.id === '0' || n.name === '0');
    const hasGround = groundComponents.length > 0 || groundNets.length > 0 || hasNodeZero;

    if (!hasGround) {
        issues.push(createIssue(ErcCode.NO_GROUND, []));
    }

    // Check for multiple grounds on different nets
    if (groundComponents.length > 1) {
        const groundNetIds = new Set<string>();
        for (const gnd of groundComponents) {
            const pin = gnd.pins[0];
            if (pin?.netId) {
                groundNetIds.add(pin.netId);
            }
        }
        if (groundNetIds.size > 1) {
            issues.push(
                createIssue(
                    ErcCode.MULTIPLE_GROUNDS,
                    groundComponents.map((c) => c.id),
                    `Found on nets: ${Array.from(groundNetIds).join(', ')}`,
                ),
            );
        }
    }

    return issues;
}

/**
 * Check for floating nodes
 */
function checkFloatingNodes(circuit: CircuitJson): ErcIssue[] {
    const issues: ErcIssue[] = [];

    // Build net connection map
    const netPinCount = new Map<string, number>();
    const netComponents = new Map<string, string[]>();
    const netPins = new Map<string, { type: Component['type']; pinId: string }[]>();

    for (const component of circuit.components) {
        for (const pin of component.pins) {
            if (pin.netId) {
                netPinCount.set(pin.netId, (netPinCount.get(pin.netId) || 0) + 1);
                const components = netComponents.get(pin.netId) || [];
                components.push(component.id);
                netComponents.set(pin.netId, components);
                const pins = netPins.get(pin.netId) || [];
                pins.push({ type: component.type, pinId: pin.pinId });
                netPins.set(pin.netId, pins);
            }
        }
    }

    // Check each net
    for (const net of circuit.nets) {
        const pinCount = netPinCount.get(net.id) || 0;
        const connectedComponents = netComponents.get(net.id) || [];

        // Skip ground nets
        if (net.isGround || net.id === '0' || net.name === '0') {
            continue;
        }

        if (pinCount === 0) {
            issues.push(createIssue(ErcCode.UNCONNECTED_NET, [net.id], `Net "${net.name || net.id}"`));
        } else if (pinCount === 1) {
            // A driven digital OUTPUT observed on its own net (a counter/register terminal output) is not a
            // dead end — planMixedSignal bridges it to an analog node for probing. Don't flag it.
            const lone = (netPins.get(net.id) || [])[0];
            if (lone && digitalPinRole(lone.type, lone.pinId) === 'source') {
                continue;
            }
            issues.push(
                createIssue(
                    ErcCode.NET_HAS_SINGLE_PIN,
                    [net.id, ...connectedComponents],
                    `Net "${net.name || net.id}" connected to only ${connectedComponents.join(', ')}`,
                ),
            );
        }
    }

    return issues;
}

/**
 * Check component pin counts
 */
function checkPinCounts(circuit: CircuitJson): ErcIssue[] {
    const issues: ErcIssue[] = [];

    for (const component of circuit.components) {
        const expected = EXPECTED_PIN_COUNTS[component.type];
        if (expected !== undefined && component.pins.length !== expected) {
            issues.push(
                createIssue(
                    ErcCode.PIN_COUNT_MISMATCH,
                    [component.id],
                    `${component.designator || component.id}: expected ${expected} pins, got ${component.pins.length}`,
                ),
            );
        }
    }

    return issues;
}

/**
 * Digital / mixed-signal checks (no-op for analog-only circuits):
 *  - pin shape: a gate needs exactly one `out` and enough `in*` (1 for not/buffer, 2+ for others); a dff
 *    needs d/clk/q/qb (set/rst are optional — auto-tied by the generator);
 *  - floating digital input: a digital-input net with no driver at all (an undriven digital input is 'U');
 *  - bus contention: two or more digital OUTPUTS driving one net (needs a tri-state/bus, not in PR1);
 *  - mixed-driver conflict: a digital output and an analog source fighting over the same net.
 */
function checkDigitalConnectivity(circuit: CircuitJson): ErcIssue[] {
    const issues: ErcIssue[] = [];
    if (!circuit.components.some((c) => isDigitalType(c.type))) return issues;

    // 1) Pin shape.
    for (const c of circuit.components) {
        if (isLogicGateType(c.type)) {
            const inputPins = c.pins.filter((p) => /^in\d+$/i.test(p.pinId)).map((p) => p.pinId.toLowerCase());
            const inputs = inputPins.length;
            const distinctInputs = new Set(inputPins).size;
            const outputs = c.pins.filter((p) => p.pinId === 'out').length;
            // A pin that is neither `out` nor `in<N>` is silently bridged-but-dropped at emission (the gate
            // ignores it while the planner still bridges its net), so flag it as a shape error.
            const stray = c.pins.filter((p) => p.pinId !== 'out' && !/^in\d+$/i.test(p.pinId)).map((p) => p.pinId);
            // not/buffer take EXACTLY one input (scalar port); other gates take >=2. A duplicate `in*` pinId
            // would silently collapse to one net during emission, so flag it too.
            const okInputs = isSingleInputGate(c.type) ? inputs === 1 : inputs >= 2;
            if (outputs !== 1 || !okInputs || distinctInputs !== inputs || stray.length > 0) {
                const reason =
                    stray.length > 0
                        ? `has unexpected pin(s) ${[...new Set(stray)].join(', ')} — gate pins must be 'in1'..'inN' + 'out'`
                        : distinctInputs !== inputs
                          ? 'has duplicate input pin ids'
                          : `needs ${isSingleInputGate(c.type) ? 'exactly one' : '>=2'} 'in*' and exactly one 'out'`;
                issues.push(
                    createIssue(
                        ErcCode.DIGITAL_PIN_SHAPE,
                        [c.id],
                        `${c.designator || c.id} (${c.type}): ${reason} (got ${inputs} input(s), ${distinctInputs} distinct, ${outputs} output(s))`,
                    ),
                );
            }
        } else if (c.type === 'dff') {
            for (const req of ['d', 'clk', 'q', 'qb']) {
                if (!c.pins.some((p) => p.pinId === req)) {
                    issues.push(
                        createIssue(ErcCode.DIGITAL_PIN_SHAPE, [c.id], `${c.designator || c.id} (dff): missing required pin '${req}'`),
                    );
                }
            }
            // A duplicate pinId (e.g. two `q`) silently drops a connection (nodeOf takes the first); a pin
            // outside the fixed dff port set is silently ignored by emission. Flag both.
            const allowed = new Set(['d', 'clk', 'set', 'rst', 'q', 'qb']);
            const ids = c.pins.map((p) => p.pinId.toLowerCase());
            const dups = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
            if (dups.length > 0) {
                issues.push(createIssue(ErcCode.DIGITAL_PIN_SHAPE, [c.id], `${c.designator || c.id} (dff): duplicate pin id(s) ${dups.join(', ')}`));
            }
            const strayDff = [...new Set(c.pins.map((p) => p.pinId).filter((id) => !allowed.has(id.toLowerCase())))];
            if (strayDff.length > 0) {
                issues.push(createIssue(ErcCode.DIGITAL_PIN_SHAPE, [c.id], `${c.designator || c.id} (dff): unexpected pin(s) ${strayDff.join(', ')} — dff pins are d/clk/set/rst/q/qb`));
            }
        }
    }

    // 2) Per-net driver analysis. "Active analog" = a type that actively DRIVES a node (independent
    // V/I sources + controlled/behavioral sources E/G/B) — any of these fighting a digital output (the
    // dac_bridge is itself a voltage source) is a real driver conflict. Passive/bidirectional parts (switch,
    // resistor, …) are not drivers and stay out.
    const ACTIVE_ANALOG = new Set(['voltage_source', 'current_source', 'vcvs', 'vccs', 'bsource']);
    interface Tally {
        src: number;
        sink: number;
        analog: number;
        analogSrc: number;
    }
    const tally = new Map<string, Tally>();
    const at = (netId: string): Tally => {
        let x = tally.get(netId);
        if (!x) {
            x = { src: 0, sink: 0, analog: 0, analogSrc: 0 };
            tally.set(netId, x);
        }
        return x;
    };
    for (const c of circuit.components) {
        if (c.type === 'ground' || c.type === 'generic') continue;
        const digital = isDigitalType(c.type);
        for (const pin of c.pins) {
            const x = at(pin.netId);
            if (digital) {
                if (digitalPinRole(c.type, pin.pinId) === 'source') x.src += 1;
                else x.sink += 1;
            } else {
                x.analog += 1;
                // A vcvs/vccs c+/c- pin only SENSES its net (high-impedance input); it does not DRIVE it.
                // Counting it as a driver would falsely flag MIXED_DRIVER_CONFLICT when an E/G source senses
                // a logic output (a valid comparator / level-sense pattern the generator handles correctly).
                const senseOnly = (c.type === 'vcvs' || c.type === 'vccs') && (pin.pinId === 'c+' || pin.pinId === 'c-');
                if (ACTIVE_ANALOG.has(c.type) && !senseOnly) x.analogSrc += 1;
            }
        }
    }
    for (const [netId, x] of tally) {
        if (x.src + x.sink === 0) continue; // not a digital net
        const net = circuit.nets.find((n) => n.id === netId);
        const label = `Net "${net?.name || netId}"`;
        if (x.src >= 2) {
            issues.push(createIssue(ErcCode.DIGITAL_BUS_CONTENTION, [netId], `${label} is driven by ${x.src} digital outputs`));
        }
        if (x.src >= 1 && x.analogSrc >= 1) {
            issues.push(createIssue(ErcCode.MIXED_DRIVER_CONFLICT, [netId], label));
        }
        // A digital input with no driver (no digital source, no analog connection) and not tied to ground
        // is an unknown 'U' state. (An analog connection bridges in via adc; ground ties it low.)
        if (x.sink >= 1 && x.src === 0 && x.analog === 0 && !net?.isGround) {
            issues.push(createIssue(ErcCode.FLOATING_DIGITAL_INPUT, [netId], label));
        }
    }

    // 3) Logic-level sanity. The analog↔digital bridges are calibrated to ONE circuit-wide rail (the highest
    // positive level driving the digital domain). Warn if the digital domain is driven at materially different
    // levels (a lower-rail HIGH may be misread against the higher rail's thresholds — use a level shifter or
    // set logicVoltage) or by a non-positive stimulus (a negative-going clock can't cross the positive adc
    // thresholds). Advisory only — the netlist still generates.
    const digitalNets = new Set<string>();
    for (const [netId, x] of tally) if (x.src + x.sink > 0) digitalNets.add(netId);
    const levels: number[] = [];
    let sawNegative = false;
    for (const c of circuit.components) {
        const isVoltageDriver = c.type === 'voltage_source' || (c.type === 'bsource' && /^\s*V\s*=/i.test(c.value ?? ''));
        if (!isVoltageDriver || !c.pins.some((p) => digitalNets.has(p.netId))) continue;
        const hi = sourceHighLevel(c.value);
        if (hi !== null && hi > 0) levels.push(hi); // a positive logic-HIGH level
        const lo = sourceLowLevel(c.value);
        if (lo !== null && lo < 0) sawNegative = true; // genuinely negative-going (NOT a legit DC-0 logic low)
    }
    if (levels.length >= 2) {
        const max = Math.max(...levels);
        const min = Math.min(...levels);
        if (max / min > 1.4) {
            issues.push(
                createIssue(
                    ErcCode.MIXED_LOGIC_LEVELS,
                    [],
                    `Digital domain driven at different logic levels (${min} V and ${max} V); bridges are calibrated to the highest rail (${max} V), so a ${min} V HIGH may read as undefined. Use a level shifter or set logicVoltage.`,
                ),
            );
        }
    }
    if (sawNegative) {
        issues.push(
            createIssue(
                ErcCode.MIXED_LOGIC_LEVELS,
                [],
                `A digital input is driven by a negative-going stimulus; the positive adc thresholds cannot read its negative excursion. Use a positive logic rail.`,
            ),
        );
    }

    return issues;
}

/**
 * Check component values
 */
function checkComponentValues(circuit: CircuitJson): ErcIssue[] {
    const issues: ErcIssue[] = [];

    // Components that require values (a zener's `value` is its breakdown voltage — without it no model
    // can be generated, so it's a hard error like a missing passive value).
    const requiresValue = ['resistor', 'capacitor', 'inductor', 'voltage_source', 'current_source', 'zener', 'vcvs', 'vccs'];

    // Diode has a built-in default model (DDEFAULT) — a missing model is only a warning.
    const modelWithDefault = ['diode'];
    // Active / model-based devices have NO safe default — a missing model is an error (they'd be
    // dropped from the netlist). A subckt instance is meaningless without the macromodel name.
    const modelRequired = ['bjt', 'mosfet', 'jfet', 'subckt', 'switch'];

    for (const component of circuit.components) {
        // Check for missing values
        if (requiresValue.includes(component.type) && !component.value) {
            issues.push(
                createIssue(
                    ErcCode.MISSING_VALUE,
                    [component.id],
                    `${component.designator || component.id} (${component.type})`,
                ),
            );
        }

        // A zener's value must parse to a breakdown voltage. A present-but-unparseable value (an MPN,
        // a spec string, a range) would otherwise generate no model and be silently dropped from the
        // netlist — surface it as an error instead.
        if (component.type === 'zener' && component.value && !buildZenerModel(component.value)) {
            issues.push(
                createIssue(
                    ErcCode.INVALID_VALUE,
                    [component.id],
                    `${component.designator || component.id}: "${component.value}" is not a valid breakdown voltage`,
                ),
            );
        }

        // A controlled source's gain/transconductance must be a single real number; a present-but-invalid
        // value (a "DC "/keyword/expression form) would otherwise be skipped here and crash ngspice if it
        // reached a netlist. Surface it as an error.
        if (
            (component.type === 'vcvs' || component.type === 'vccs') &&
            component.value &&
            !normalizeControlledSourceGain(component.value)
        ) {
            issues.push(
                createIssue(
                    ErcCode.INVALID_VALUE,
                    [component.id],
                    `${component.designator || component.id}: "${component.value}" is not a valid gain (must be a single number)`,
                ),
            );
        }

        // A transformer needs valid (positive) primary + secondary winding inductances (in `properties`);
        // without them no coupled-inductor pair can be emitted, so it would silently vanish. A negative /
        // zero / malformed value is present-but-INVALID; entirely absent params are MISSING.
        if (component.type === 'transformer' && !parseTransformerParams(component.properties)) {
            const props = component.properties;
            // Both keys present but unparseable -> present-but-INVALID; a missing key -> MISSING.
            const bothPresent = !!props && 'primaryInductance' in props && 'secondaryInductance' in props;
            issues.push(
                createIssue(
                    bothPresent ? ErcCode.INVALID_VALUE : ErcCode.MISSING_VALUE,
                    [component.id],
                    `${component.designator || component.id} (transformer) needs positive primaryInductance + secondaryInductance (+ optional coupling 0..1)`,
                ),
            );
        }

        // A transmission line needs a valid (positive) characteristic impedance + either a delay (td) or
        // a frequency (f) form (in `properties`).
        if (component.type === 'tline' && !parseTransmissionLineParams(component.properties)) {
            const props = component.properties;
            const hasZ = !!props && ('z0' in props || 'impedance' in props);
            const hasSpec = !!props && ('td' in props || 'delay' in props || 'f' in props || 'frequency' in props);
            issues.push(
                createIssue(
                    hasZ && hasSpec ? ErcCode.INVALID_VALUE : ErcCode.MISSING_VALUE,
                    [component.id],
                    `${component.designator || component.id} (transmission line) needs positive z0 + (td or f)`,
                ),
            );
        }

        // A behavioral source needs a single-line "V=<expr>" or "I=<expr>" value.
        if (component.type === 'bsource') {
            const v = component.value?.trim();
            if (!v) {
                issues.push(
                    createIssue(
                        ErcCode.MISSING_VALUE,
                        [component.id],
                        `${component.designator || component.id} (behavioral source) needs a "V=<expr>" or "I=<expr>" value`,
                    ),
                );
            } else if (!/^[VI]\s*=\s*\S/i.test(v) || /[\r\n]/.test(component.value!)) {
                issues.push(
                    createIssue(
                        ErcCode.INVALID_VALUE,
                        [component.id],
                        `${component.designator || component.id}: behavioral source value must be "V=<expr>" or "I=<expr>" (non-empty) on one line`,
                    ),
                );
            }
        }

        // Diode without a model: warning (a default is supplied).
        if (modelWithDefault.includes(component.type) && !component.model) {
            issues.push(
                createIssue(
                    ErcCode.MISSING_MODEL,
                    [component.id],
                    `${component.designator || component.id} will use default model`,
                ),
            );
        }

        // Active device without a model: error (no default — it can't be simulated).
        if (modelRequired.includes(component.type) && !component.model) {
            issues.push(
                createIssue(
                    ErcCode.MODEL_REQUIRED,
                    [component.id],
                    `${component.designator || component.id} (${component.type})`,
                ),
            );
        }
    }

    return issues;
}

/**
 * The built-in default diode model name. Always available to the generator (emitted when a diode has
 * no explicit model), so it counts as "resolved" even though it never appears in circuit.models.
 */
const BUILTIN_MODEL_NAMES = new Set(['DDEFAULT']);

/**
 * Check that every model NAME a component references is actually defined.
 *
 * A component can carry a `model` name (diode/bjt/mosfet) that must resolve to a `.model`/`.subckt`
 * body in `circuit.models` (or a built-in like DDEFAULT). The generator emits the device line trusting
 * the name — a missing definition produces a netlist ngspice rejects ("unable to find definition of
 * model X"). MODEL_REQUIRED only catches an ABSENT name; this catches a PRESENT-but-undefined one.
 * Warning (not error): an included model library could still satisfy it at simulation time.
 */
function checkModelResolution(circuit: CircuitJson): ErcIssue[] {
    const issues: ErcIssue[] = [];

    const defined = new Set<string>(BUILTIN_MODEL_NAMES);
    for (const m of circuit.models ?? []) {
        defined.add(m.name);
    }

    for (const component of circuit.components) {
        if (component.model && !defined.has(component.model)) {
            issues.push(
                createIssue(
                    ErcCode.UNRESOLVED_MODEL,
                    [component.id],
                    `${component.designator || component.id} references model "${component.model}"`,
                ),
            );
        }
    }

    return issues;
}

/**
 * Check for voltage source shorts
 */
function checkVoltageSourceShorts(circuit: CircuitJson): ErcIssue[] {
    const issues: ErcIssue[] = [];

    // Voltage-FORCING devices over-determine a node when two of them sit across the SAME net pair (ngspice
    // then returns a singular matrix / "timestep too small"). Independent V sources, vcvs (E) outputs, and a
    // bsource (B) with a `V=` expression all pin a node to a voltage. vccs/current_source/bsource-with-`I=`
    // drive CURRENT and can legitimately share a net, so they are excluded. (A vcvs's c+/c- are high-impedance
    // SENSE pins — never the + / - read below — so a sensing controlled source is not counted as a driver.)
    const voltageSources = circuit.components.filter(
        (c) =>
            c.type === 'voltage_source' ||
            c.type === 'vcvs' ||
            (c.type === 'bsource' && typeof c.value === 'string' && /^\s*v\s*=/i.test(c.value)),
    );

    // Find ground net ids
    const groundNetIds = new Set<string>();
    groundNetIds.add('0');
    for (const net of circuit.nets) {
        if (net.isGround) {
            groundNetIds.add(net.id);
        }
    }
    for (const gnd of circuit.components.filter((c) => c.type === 'ground')) {
        const pin = gnd.pins[0];
        if (pin?.netId) {
            groundNetIds.add(pin.netId);
        }
    }

    for (const vs of voltageSources) {
        const posPin = vs.pins.find((p) => p.pinId === '+');
        const negPin = vs.pins.find((p) => p.pinId === '-');

        // Check for short (both pins on same net)
        if (posPin?.netId && posPin.netId === negPin?.netId) {
            issues.push(
                createIssue(
                    ErcCode.VOLTAGE_SOURCE_SHORT,
                    [vs.id],
                    `${vs.designator || vs.id} has both terminals on same net`,
                ),
            );
        }
    }

    // Check for parallel voltage sources with different values
    const netVoltages = new Map<string, { source: Component; value: string }[]>();

    for (const vs of voltageSources) {
        const posPin = vs.pins.find((p) => p.pinId === '+');
        const negPin = vs.pins.find((p) => p.pinId === '-');

        // Only check DC sources
        if (vs.value && posPin?.netId && negPin?.netId) {
            const key = `${posPin.netId}:${negPin.netId}`;
            const reverseKey = `${negPin.netId}:${posPin.netId}`;

            const existing = netVoltages.get(key) || netVoltages.get(reverseKey) || [];
            existing.push({ source: vs, value: vs.value });
            netVoltages.set(key, existing);
        }
    }

    for (const [, sources] of netVoltages) {
        if (sources.length > 1) {
            const values = sources.map((s) => s.value);
            const uniqueValues = new Set(values);
            // Two identical INDEPENDENT voltage sources are a redundancy we leave alone; but differing values
            // — or a MIX of driver types (e.g. a V source paralleled with a vcvs output) — is a genuine
            // over-determination. Flag it so the caller fixes it before ngspice fails with an opaque error.
            const allPlainSources = sources.every((s) => s.source.type === 'voltage_source');
            if (!allPlainSources || uniqueValues.size > 1) {
                const labels = sources.map((s) => s.source.designator || s.source.id).join(', ');
                issues.push(
                    createIssue(
                        ErcCode.PARALLEL_VOLTAGE_SOURCES,
                        sources.map((s) => s.source.id),
                        allPlainSources
                            ? `Conflicting values: ${values.join(', ')}`
                            : `Multiple voltage drivers (${labels}) across the same net pair — they over-determine the node`,
                    ),
                );
            }
        }
    }

    return issues;
}

/**
 * Check net connections
 */
function checkNetConnections(circuit: CircuitJson): ErcIssue[] {
    const issues: ErcIssue[] = [];

    // Build set of nets referenced by components
    const referencedNets = new Set<string>();
    for (const component of circuit.components) {
        for (const pin of component.pins) {
            if (pin.netId) {
                referencedNets.add(pin.netId);
            }
        }
    }

    // Check for defined but unreferenced nets
    for (const net of circuit.nets) {
        if (!referencedNets.has(net.id) && !net.isGround && net.id !== '0') {
            issues.push(createIssue(ErcCode.UNCONNECTED_NET, [net.id], `Net "${net.name || net.id}"`));
        }
    }

    return issues;
}

/**
 * Check for active sources
 */
function checkActiveSources(circuit: CircuitJson): ErcIssue[] {
    const issues: ErcIssue[] = [];

    const hasActiveSources = circuit.components.some((c) => ACTIVE_SOURCES.includes(c.type));

    if (!hasActiveSources && circuit.components.length > 0) {
        issues.push(createIssue(ErcCode.NO_ACTIVE_COMPONENTS, []));
    }

    return issues;
}

/**
 * Quick check - returns true if circuit passes basic ERC
 */
export function quickCheck(circuit: CircuitJson): boolean {
    const result = runErc(circuit);
    return result.passed;
}