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
    [ErcCode.NON_STANDARD_VALUE]: 'Component value is not a standard E-series (IEC 60063) preferred value — hard to source',
    [ErcCode.DUPLICATE_DESIGNATOR]: 'Two or more components share the same designator (must be unique)',
    [ErcCode.WRONG_VALUE_UNIT]: 'Component value carries a unit inconsistent with its type (e.g. farads on a resistor)',
    [ErcCode.UNCONNECTED_NET]: 'Net defined but not connected to any components',
    [ErcCode.NET_HAS_SINGLE_PIN]: 'Net has only one pin connection (dead end)',
    [ErcCode.DIGITAL_PIN_SHAPE]: 'Digital component is missing a required pin (output and/or inputs)',
    [ErcCode.FLOATING_DIGITAL_INPUT]: 'Digital input is not driven by any source (would be an unknown state)',
    [ErcCode.DIGITAL_BUS_CONTENTION]: 'Multiple digital outputs drive the same net',
    [ErcCode.MIXED_DRIVER_CONFLICT]: 'A digital output and an analog source drive the same net',
    [ErcCode.MIXED_LOGIC_LEVELS]: 'The digital domain is driven at materially different (or non-positive) logic levels; analog↔digital bridges use one rail',
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
    [ErcCode.NON_STANDARD_VALUE]: 'info', // advisory: still simulates fine; just not a buyable preferred value
    [ErcCode.DUPLICATE_DESIGNATOR]: 'error', // a real collision — generation would otherwise abort; surface it cleanly first
    [ErcCode.WRONG_VALUE_UNIT]: 'warning', // ngspice uses only the NUMBER, so "4.7uF" on a resistor silently means 4.7uΩ
    [ErcCode.UNCONNECTED_NET]: 'info',
    [ErcCode.NET_HAS_SINGLE_PIN]: 'warning',
    [ErcCode.DIGITAL_PIN_SHAPE]: 'error', // can't emit a valid a-device without the right pins
    [ErcCode.FLOATING_DIGITAL_INPUT]: 'error', // an undriven digital input is unknown ('U') — a real bug
    [ErcCode.DIGITAL_BUS_CONTENTION]: 'error', // two pushing outputs on one net — needs a tristate/bus
    [ErcCode.MIXED_DRIVER_CONFLICT]: 'error', // analog source vs digital output fighting over a node
    [ErcCode.MIXED_LOGIC_LEVELS]: 'warning', // advisory: bridges calibrated to one rail; lower-rail HIGH may misread
    [ErcCode.EMPTY_CIRCUIT]: 'error',
    [ErcCode.NO_ACTIVE_COMPONENTS]: 'warning',
};