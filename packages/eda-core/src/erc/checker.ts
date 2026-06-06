/**
 * ERC (Electrical Rule Check) Checker
 * Validates circuits for common electrical issues
 */
import type { CircuitJson, Component } from '../types/circuit';
import { ErcCode, ErcSeverity, ErcResult, ErcIssue } from '../types/erc';
import { ERC_DESCRIPTIONS, ERC_SEVERITIES } from './codes';
import { buildZenerModel, normalizeControlledSourceGain } from '../models/library';

/**
 * Expected pin counts for each component type
 */
const EXPECTED_PIN_COUNTS: Record<string, number> = {
    resistor: 2,
    capacitor: 2,
    inductor: 2,
    voltage_source: 2,
    current_source: 2,
    vcvs: 4,
    vccs: 4,
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

    for (const component of circuit.components) {
        for (const pin of component.pins) {
            if (pin.netId) {
                netPinCount.set(pin.netId, (netPinCount.get(pin.netId) || 0) + 1);
                const components = netComponents.get(pin.netId) || [];
                components.push(component.id);
                netComponents.set(pin.netId, components);
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
    const modelRequired = ['bjt', 'mosfet', 'jfet', 'subckt'];

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

    // Find all voltage sources
    const voltageSources = circuit.components.filter((c) => c.type === 'voltage_source');

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
            if (uniqueValues.size > 1) {
                issues.push(
                    createIssue(
                        ErcCode.PARALLEL_VOLTAGE_SOURCES,
                        sources.map((s) => s.source.id),
                        `Conflicting values: ${values.join(', ')}`,
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