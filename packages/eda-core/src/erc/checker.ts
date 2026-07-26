/**
 * ERC (Electrical Rule Check) Checker
 * Validates circuits for common electrical issues
 */
import { buildZenerModel, normalizeControlledSourceGain, parseTransformerParams, parseTransmissionLineParams } from '../models/library';
import { sourceHighLevel, sourceLowLevel } from '../netlist/digital';
import type { CircuitJson, Component } from '../types/circuit';
import { isDigitalType, isLogicGateType, isSingleInputGate, digitalPinRole, SEQUENTIAL_TYPES, COMPONENT_PINS } from '../types/circuit';
import { ErcCode, ErcSeverity, ErcResult, ErcIssue } from '../types/erc';
import { isESeriesValue, snapValueString } from '../utils/eseries';
import { parseSpiceValue } from '../utils/unit-parser';

import { ERC_DESCRIPTIONS, ERC_SEVERITIES } from './codes';


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
    issues.push(...checkDuplicateDesignators(circuit));
    issues.push(...checkComponentValues(circuit));
    issues.push(...checkModelResolution(circuit));
    issues.push(...checkVoltageSourceShorts(circuit));
    issues.push(...checkGroundReachability(circuit));
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
        } else {
            // pinCount >= 2: if EVERY incident pin is a capacitor or current-source terminal, the node has NO
            // DC path to ground (caps are open at DC; a current source sets current, not a reference voltage),
            // so the .op that precedes .tran is singular. ngspice limps through via gmin-stepping (a small
            // DC-offset artifact) — the result is far cleaner if the caller seeds the node. Conservative: any
            // resistor/inductor/source/active pin provides a DC path, so such a node is NOT flagged (no false
            // positive). This is the long-defined-but-unused ERC010 (FLOATING_NODE).
            const pinsHere = netPins.get(net.id) || [];
            const noDcPath =
                pinsHere.length > 0 &&
                pinsHere.every((p) => p.type === 'capacitor' || p.type === 'current_source');
            if (noDcPath) {
                issues.push(
                    createIssue(
                        ErcCode.FLOATING_NODE,
                        [net.id, ...connectedComponents],
                        `Net "${net.name || net.id}" has no DC path to ground (only capacitor/current-source connections); its operating point is undefined. Set analysis.initialConditions for this node for a clean, artifact-free start.`,
                    ),
                );
            }
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
        } else if (SEQUENTIAL_TYPES.has(c.type) || c.type === 'tristate') {
            // Fixed-arity digital elements: the canonical pin set comes from COMPONENT_PINS; set/rst are
            // the only OPTIONAL pins (auto-tied LOW by the generator). Everything else is required, a
            // duplicate pinId silently drops a connection (nodeOf takes the first), and a pin outside the
            // port set is silently ignored by emission — flag all three.
            const canonical = COMPONENT_PINS[c.type];
            const optional = new Set(['set', 'rst']);
            for (const req of canonical.filter((p) => !optional.has(p))) {
                if (!c.pins.some((p) => p.pinId === req)) {
                    issues.push(
                        createIssue(ErcCode.DIGITAL_PIN_SHAPE, [c.id], `${c.designator || c.id} (${c.type}): missing required pin '${req}'`),
                    );
                }
            }
            const allowed = new Set(canonical);
            const ids = c.pins.map((p) => p.pinId.toLowerCase());
            const dups = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
            if (dups.length > 0) {
                issues.push(createIssue(ErcCode.DIGITAL_PIN_SHAPE, [c.id], `${c.designator || c.id} (${c.type}): duplicate pin id(s) ${dups.join(', ')}`));
            }
            const strays = [...new Set(c.pins.map((p) => p.pinId).filter((id) => !allowed.has(id.toLowerCase())))];
            if (strays.length > 0) {
                issues.push(createIssue(ErcCode.DIGITAL_PIN_SHAPE, [c.id], `${c.designator || c.id} (${c.type}): unexpected pin(s) ${strays.join(', ')} — ${c.type} pins are ${canonical.join('/')}`));
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
        triSrc: number; // how many of `src` are TRISTATE outputs (releasable -> may legally share a bus)
    }
    const tally = new Map<string, Tally>();
    const at = (netId: string): Tally => {
        let x = tally.get(netId);
        if (!x) {
            x = { src: 0, sink: 0, analog: 0, analogSrc: 0, triSrc: 0 };
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
                if (digitalPinRole(c.type, pin.pinId) === 'source') {
                    x.src += 1;
                    if (c.type === 'tristate') x.triSrc += 1;
                } else x.sink += 1;
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
        // Two PUSHING outputs on one net fight; but a bus where EVERY driver is a tristate output is the
        // legitimate shared-bus pattern (drivers release to high-Z) — relax contention for that case only.
        // One pushing output mixed with tristates still contends (the pushing one never releases).
        if (x.src >= 2 && x.triSrc < x.src) {
            issues.push(createIssue(ErcCode.DIGITAL_BUS_CONTENTION, [netId], `${label} is driven by ${x.src} digital outputs (${x.src - x.triSrc} non-tristate)`));
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
/**
 * Every component's designator must be UNIQUE. ngspice device names are case-insensitive, so "R1" and "r1"
 * collide; the netlist generator hard-throws on the resulting duplicate device name, so catching it here
 * gives a clean, early error (naming all the colliding components) instead of an opaque generation failure.
 */
function checkDuplicateDesignators(circuit: CircuitJson): ErcIssue[] {
    const issues: ErcIssue[] = [];
    const byKey = new Map<string, string[]>();
    for (const c of circuit.components) {
        const d = c.designator?.trim();
        if (!d) continue; // a missing designator is a separate concern (schema/MISSING checks)
        const key = d.toLowerCase();
        const ids = byKey.get(key) ?? [];
        ids.push(c.id);
        byKey.set(key, ids);
    }
    for (const [key, ids] of byKey) {
        if (ids.length > 1) {
            issues.push(
                createIssue(
                    ErcCode.DUPLICATE_DESIGNATOR,
                    ids,
                    `${ids.length} components share the designator "${key}" — designators must be unique (ngspice device names are case-insensitive)`,
                ),
            );
        }
    }
    return issues;
}

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

        // E-series advisory (info): a passive whose value is not a standard IEC 60063 preferred value is
        // hard to SOURCE — a formula/AI-derived 1591.5 Ω or 3.27 kΩ can't be bought and the BOM layer can't
        // map a real MPN to it. Flag it with the nearest E24 value. Non-blocking (it still simulates); a
        // value that already IS standard (4.7k, 100n) is silent. E24 is the common manufacturing grid.
        if (
            (component.type === 'resistor' || component.type === 'capacitor' || component.type === 'inductor') &&
            component.value
        ) {
            const parsed = parseSpiceValue(component.value);
            if (parsed.isValid && parsed.value > 0 && !isESeriesValue(parsed.value, 'E24')) {
                const nearest = snapValueString(component.value, 'E24');
                issues.push(
                    createIssue(
                        ErcCode.NON_STANDARD_VALUE,
                        [component.id],
                        `${component.designator || component.id}: ${component.value}${nearest ? ` — nearest standard (E24) is ${nearest}` : ''}`,
                    ),
                );
            }
            // Dimensional-unit sanity: ngspice reads only the NUMBER, so a resistor written "4.7uF" silently
            // becomes 4.7 uΩ. A bare number or the matching unit is fine; a contradicting R/C/L unit is the bug.
            const expectedUnit = ({ resistor: 'Ω', capacitor: 'F', inductor: 'H' } as Record<string, string>)[component.type];
            const u = parsed.unit;
            if (expectedUnit && u && u !== expectedUnit && (u === 'Ω' || u === 'F' || u === 'H')) {
                const name: Record<string, string> = { 'Ω': 'ohms', F: 'farads', H: 'henries' };
                issues.push(
                    createIssue(
                        ErcCode.WRONG_VALUE_UNIT,
                        [component.id],
                        `${component.designator || component.id}: value "${component.value}" is in ${name[u]}, but a ${component.type} is measured in ${name[expectedUnit]}`,
                    ),
                );
            }
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
 * Collect every netId that is electrically GROUND. SPICE treats node 0 and any net flagged isGround / wired
 * to a ground component as the SAME reference node, so for short/parallel reasoning they must all collapse
 * to one id — otherwise a source spanning two DIFFERENT ground nets, or two sources spanning sig↔gnd_a and
 * sig↔gnd_b, are invisible (audit #6/#7).
 */
function collectGroundNetIds(circuit: CircuitJson): Set<string> {
    const groundNetIds = new Set<string>(['0']);
    for (const net of circuit.nets) {
        if (net.isGround || net.id === '0' || net.name === '0') groundNetIds.add(net.id);
    }
    for (const gnd of circuit.components.filter((c) => c.type === 'ground')) {
        const pin = gnd.pins[0];
        if (pin?.netId) groundNetIds.add(pin.netId);
    }
    return groundNetIds;
}

/**
 * The DC magnitude a source forces, for over-determination comparison. Strips a leading DC/AC keyword and
 * parses the first token's SI value; returns null for a non-numeric value (SIN/PULSE/expression) so the
 * caller falls back to a polarity-tagged string compare instead of inventing a number.
 */
function sourceDcMagnitude(value: string): number | null {
    const stripped = value.trim().replace(/^(dc|ac)\s+/i, '');
    const token = stripped.split(/\s+/)[0] ?? '';
    const parsed = parseSpiceValue(token);
    return parsed.isValid ? parsed.value : null;
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

    // Collapse all ground netIds to one canonical node ('0'), so two DIFFERENT ground nets read as identical.
    const groundNetIds = collectGroundNetIds(circuit);
    const canon = (netId?: string): string | undefined =>
        netId == null ? undefined : groundNetIds.has(netId) ? '0' : netId;

    // --- Shorts: + and - resolve to the SAME node, incl. two different ground nets (#6) ---
    for (const vs of voltageSources) {
        const p = canon(vs.pins.find((pin) => pin.pinId === '+')?.netId);
        const n = canon(vs.pins.find((pin) => pin.pinId === '-')?.netId);
        if (p && n && p === n) {
            issues.push(
                createIssue(
                    ErcCode.VOLTAGE_SOURCE_SHORT,
                    [vs.id],
                    `${vs.designator || vs.id} has both terminals on the same node`,
                ),
            );
        }
    }

    // --- Parallel over-determination: 2+ voltage-forcing devices across the same NODE pair (#7) ---
    // Group by an UNORDERED canonical key; for each driver track its polarity vs that orientation and its
    // SIGNED DC magnitude, so an anti-parallel pair of EQUAL magnitude (+5 vs −5) is correctly a conflict —
    // the old raw-string compare saw "5" == "5" and missed it.
    interface Driver {
        source: Component;
        signed: number | null; // SIGNED forced voltage in the canonical orientation; null if non-numeric
        tag: string; // polarity-tagged string fallback for non-numeric values
    }
    const groups = new Map<string, Driver[]>();
    for (const vs of voltageSources) {
        const p = canon(vs.pins.find((pin) => pin.pinId === '+')?.netId);
        const n = canon(vs.pins.find((pin) => pin.pinId === '-')?.netId);
        if (!p || !n || p === n || vs.value == null) continue; // shorts handled above; need both nodes + a value
        const [a, b] = p < n ? [p, n] : [n, p]; // canonical orientation (a < b)
        const reversed = p !== a; // the '+' terminal sits on the lexically-larger node
        const mag = sourceDcMagnitude(vs.value);
        const driver: Driver = {
            source: vs,
            signed: mag == null ? null : reversed ? -mag : mag,
            tag: `${reversed ? '-' : '+'}${vs.value}`,
        };
        const key = `${a}|${b}`;
        const arr = groups.get(key) ?? [];
        arr.push(driver);
        groups.set(key, arr);
    }

    for (const [, drivers] of groups) {
        if (drivers.length < 2) continue;
        // Two identical INDEPENDENT voltage sources are a harmless redundancy; differing FORCED voltages — or
        // a MIX of driver types (a V source paralleled with a vcvs output) — is a genuine over-determination.
        const allPlain = drivers.every((d) => d.source.type === 'voltage_source');
        const allNumeric = drivers.every((d) => d.signed != null);
        let conflict: boolean;
        if (allNumeric) {
            const distinct: number[] = [];
            for (const d of drivers) {
                if (!distinct.some((v) => Math.abs(v - d.signed!) <= 1e-9 * Math.max(1, Math.abs(v)))) {
                    distinct.push(d.signed!);
                }
            }
            conflict = !allPlain || distinct.length > 1;
        } else {
            conflict = !allPlain || new Set(drivers.map((d) => d.tag)).size > 1;
        }
        if (conflict) {
            const labels = drivers.map((d) => d.source.designator || d.source.id).join(', ');
            issues.push(
                createIssue(
                    ErcCode.PARALLEL_VOLTAGE_SOURCES,
                    drivers.map((d) => d.source.id),
                    allPlain
                        ? `Voltage sources (${labels}) force the same node pair to different voltages`
                        : `Multiple voltage drivers (${labels}) across the same node pair — they over-determine the node`,
                ),
            );
        }
    }

    return issues;
}

/**
 * #3 — global connectivity: every ANALOG node must have a path (through components) back to a ground node.
 * A whole sub-circuit island disconnected from ground simulates as a floating block (or makes the .op
 * singular), yet passes every per-net check — so it can be "verified" while being electrically meaningless.
 * Build a net graph (two nets are adjacent if a component bridges them), flood-fill from the ground nets,
 * and flag any analog node the fill never reaches.
 *
 * Conservative by design — near-zero false positives:
 *   - ANY component edge (incl. a capacitor) keeps a block attached, so only a TRULY disconnected block is
 *     flagged; a capacitively-coupled-but-DC-floating block is the separate FLOATING_NODE check, not this one;
 *   - only nets with ≥2 NON-digital pins are required to reach ground (a 1-pin net is NET_HAS_SINGLE_PIN; a
 *     purely-digital net gets its ground reference from the mixed-signal bridge added at generation time);
 *   - skipped entirely when the circuit has no ground anchor (NO_GROUND already covers that case).
 */
function checkGroundReachability(circuit: CircuitJson): ErcIssue[] {
    const groundNetIds = new Set<string>();
    for (const net of circuit.nets) {
        if (net.isGround || net.id === '0' || net.name === '0') groundNetIds.add(net.id);
    }
    for (const gnd of circuit.components.filter((c) => c.type === 'ground')) {
        const pin = gnd.pins[0];
        if (pin?.netId) groundNetIds.add(pin.netId);
    }
    if (groundNetIds.size === 0) return []; // no anchor → NO_GROUND owns this; reachability would be all-noise

    // Adjacency over ALL components: each component ties together every net its pins touch (a clique).
    const adj = new Map<string, Set<string>>();
    const link = (x: string, y: string) => {
        if (x === y) return;
        if (!adj.has(x)) adj.set(x, new Set());
        if (!adj.has(y)) adj.set(y, new Set());
        adj.get(x)!.add(y);
        adj.get(y)!.add(x);
    };
    for (const c of circuit.components) {
        const nets = c.pins.map((p) => p.netId).filter((id): id is string => !!id);
        for (let i = 0; i < nets.length; i++) {
            for (let j = i + 1; j < nets.length; j++) link(nets[i]!, nets[j]!);
        }
    }

    // Flood-fill the net graph from every ground net.
    const reachable = new Set<string>(groundNetIds);
    const stack = [...groundNetIds];
    while (stack.length) {
        const cur = stack.pop()!;
        for (const nb of adj.get(cur) ?? []) {
            if (!reachable.has(nb)) {
                reachable.add(nb);
                stack.push(nb);
            }
        }
    }

    // Only genuine ANALOG nodes (≥2 pins from non-digital, non-ground components) must reach ground.
    const analogPinCount = new Map<string, number>();
    for (const c of circuit.components) {
        if (isDigitalType(c.type) || c.type === 'ground') continue;
        for (const p of c.pins) {
            if (p.netId) analogPinCount.set(p.netId, (analogPinCount.get(p.netId) ?? 0) + 1);
        }
    }

    const islandNets = circuit.nets.filter(
        (net) => !reachable.has(net.id) && (analogPinCount.get(net.id) ?? 0) >= 2,
    );
    if (islandNets.length === 0) return [];

    const islandIds = new Set(islandNets.map((n) => n.id));
    const compIds = new Set<string>();
    for (const c of circuit.components) {
        if (c.pins.some((p) => p.netId && islandIds.has(p.netId))) compIds.add(c.id);
    }
    const names = islandNets.map((n) => n.name || n.id).join(', ');
    return [
        createIssue(
            ErcCode.ISOLATED_SUBCIRCUIT,
            [...islandNets.map((n) => n.id), ...compIds],
            `Net(s) ${names} have no connection back to ground — an isolated sub-circuit that floats (or makes the operating point singular)`,
        ),
    ];
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