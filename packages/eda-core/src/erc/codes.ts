/**
 * ERC (Electrical Rule Check) Error Codes
 * Re-exports from types and provides descriptions
 */
import { ErcCode, ErcSeverity } from '../types/erc';

// Re-export for convenience
export { ErcCode, ErcSeverity };

/**
 * ERC code descriptions for user-friendly messages
 */
export const ERC_DESCRIPTIONS: Record<ErcCode, string> = {
    [ErcCode.NO_GROUND]: 'Circuit has no ground reference (node 0)',
    [ErcCode.MULTIPLE_GROUNDS]: 'Circuit has multiple ground components on different nets',
    [ErcCode.FLOATING_NODE]: 'Node is not connected to any power or ground path',
    [ErcCode.FLOATING_INPUT]: 'Component input pin is floating',
    [ErcCode.VOLTAGE_SOURCE_SHORT]: 'Voltage source output is shorted to ground',
    [ErcCode.PARALLEL_VOLTAGE_SOURCES]: 'Parallel voltage sources with different values',
    [ErcCode.MISSING_VALUE]: 'Component is missing required value',
    [ErcCode.INVALID_VALUE]: 'Component has invalid or unparseable value',
    [ErcCode.PIN_COUNT_MISMATCH]: 'Component has incorrect number of pins for its type',
    [ErcCode.MISSING_MODEL]: 'Component requires a model but none specified',
    [ErcCode.MODEL_REQUIRED]: 'Active device has no model and no default — it cannot be simulated',
    [ErcCode.UNRESOLVED_MODEL]:
        'Component references a model that is not defined in the circuit (must be supplied by an included model library)',
    [ErcCode.UNCONNECTED_NET]: 'Net defined but not connected to any components',
    [ErcCode.NET_HAS_SINGLE_PIN]: 'Net has only one pin connection (dead end)',
    [ErcCode.EMPTY_CIRCUIT]: 'Circuit contains no components',
    [ErcCode.NO_ACTIVE_COMPONENTS]: 'Circuit has no active sources or inputs',
};

/**
 * Default severities for each ERC code
 */
export const ERC_SEVERITIES: Record<ErcCode, ErcSeverity> = {
    [ErcCode.NO_GROUND]: 'error',
    [ErcCode.MULTIPLE_GROUNDS]: 'warning',
    [ErcCode.FLOATING_NODE]: 'warning',
    [ErcCode.FLOATING_INPUT]: 'warning',
    [ErcCode.VOLTAGE_SOURCE_SHORT]: 'error',
    [ErcCode.PARALLEL_VOLTAGE_SOURCES]: 'error',
    [ErcCode.MISSING_VALUE]: 'error',
    [ErcCode.INVALID_VALUE]: 'error',
    [ErcCode.PIN_COUNT_MISMATCH]: 'error',
    [ErcCode.MISSING_MODEL]: 'warning',
    [ErcCode.MODEL_REQUIRED]: 'error',
    // A present-but-undefined model name may still be satisfied by a `.include`d library at sim time,
    // so this is a warning (observable), not a hard error.
    [ErcCode.UNRESOLVED_MODEL]: 'warning',
    [ErcCode.UNCONNECTED_NET]: 'info',
    [ErcCode.NET_HAS_SINGLE_PIN]: 'warning',
    [ErcCode.EMPTY_CIRCUIT]: 'error',
    [ErcCode.NO_ACTIVE_COMPONENTS]: 'warning',
};