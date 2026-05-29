/**
 * ERC (Electrical Rule Check) Checker
 * Validates circuits for common electrical issues
 */
import type { CircuitJson, Component } from '../types/circuit';
import { ErcCode, ErcSeverity, ErcResult, ErcIssue } from '../types/erc';
import { ERC_DESCRIPTIONS, ERC_SEVERITIES } from './codes';

/**
 * Expected pin counts for each component type
 */
const EXPECTED_PIN_COUNTS: Record<string, number> = {
    resistor: 2,
    capacitor: 2,
    inductor: 2,
    voltage_source: 2,
    current_source: 2,
    diode: 2,
    ground: 1,
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

    // Components that require values
    const requiresValue = ['resistor', 'capacitor', 'inductor', 'voltage_source', 'current_source'];

    // Components that require models
    const requiresModel = ['diode'];

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

        // Check for missing models (warning level)
        if (requiresModel.includes(component.type) && !component.model) {
            issues.push(
                createIssue(
                    ErcCode.MISSING_MODEL,
                    [component.id],
                    `${component.designator || component.id} will use default model`,
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