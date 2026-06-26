/**
 * ERC (Electrical Rule Check) Types
 */

/**
 * ERC error codes enumeration
 */
export enum ErcCode {
    // Ground related
    NO_GROUND = 'ERC001',
    MULTIPLE_GROUNDS = 'ERC002',

    // Floating nodes
    FLOATING_NODE = 'ERC010',
    FLOATING_INPUT = 'ERC011',

    // Short circuits
    VOLTAGE_SOURCE_SHORT = 'ERC020',
    PARALLEL_VOLTAGE_SOURCES = 'ERC021',

    // Component issues
    MISSING_VALUE = 'ERC030',
    INVALID_VALUE = 'ERC031',
    PIN_COUNT_MISMATCH = 'ERC032',
    MISSING_MODEL = 'ERC033',
    MODEL_REQUIRED = 'ERC034',
    UNRESOLVED_MODEL = 'ERC035',
    NON_STANDARD_VALUE = 'ERC036', // a passive's value is not an IEC 60063 (E-series) preferred value — hard to source
    DUPLICATE_DESIGNATOR = 'ERC037', // two+ components share a designator (collision; ngspice names are case-insensitive)
    WRONG_VALUE_UNIT = 'ERC038', // a passive's value carries a unit inconsistent with its type (e.g. "4.7uF" on a resistor)

    // Net issues
    UNCONNECTED_NET = 'ERC040',
    NET_HAS_SINGLE_PIN = 'ERC041',
    ISOLATED_SUBCIRCUIT = 'ERC042', // a node has no connection back to ground (a floating island that still "verifies")

    // Digital / mixed-signal
    DIGITAL_PIN_SHAPE = 'ERC060', // a gate/flip-flop is missing a required pin (e.g. no output / too few inputs)
    FLOATING_DIGITAL_INPUT = 'ERC061', // a digital input net has no driver (would be an unknown 'U' state)
    DIGITAL_BUS_CONTENTION = 'ERC062', // two or more digital outputs drive the same net
    MIXED_DRIVER_CONFLICT = 'ERC063', // a digital output and an analog source drive the same net
    MIXED_LOGIC_LEVELS = 'ERC064', // the digital domain is driven at materially different / non-positive logic levels

    // General
    EMPTY_CIRCUIT = 'ERC050',
    NO_ACTIVE_COMPONENTS = 'ERC051',
}

/**
 * ERC severity levels
 */
export type ErcSeverity = 'error' | 'warning' | 'info';

/**
 * Individual ERC issue
 */
export interface ErcIssue {
    /** ERC error code */
    code: ErcCode;

    /** Severity level */
    severity: ErcSeverity;

    /** Human-readable message */
    message: string;

    /** IDs of related components or nets */
    relatedIds: string[];
}

/**
 * ERC check result
 */
export interface ErcResult {
    /** Whether the circuit passed all error-level checks */
    passed: boolean;

    /** List of all issues found */
    issues: ErcIssue[];

    /** Summary counts */
    summary: {
        errors: number;
        warnings: number;
        infos: number;
    };
}

/**
 * ERC configuration options
 */
export interface ErcConfig {
    /** Whether to check for floating nodes */
    checkFloatingNodes?: boolean;

    /** Whether to require a ground reference */
    requireGround?: boolean;

    /** Whether to check for missing models */
    checkMissingModels?: boolean;

    /** Custom severity overrides */
    severityOverrides?: Partial<Record<ErcCode, ErcSeverity>>;
}