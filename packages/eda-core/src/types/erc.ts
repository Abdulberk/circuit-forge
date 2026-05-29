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

    // Net issues
    UNCONNECTED_NET = 'ERC040',
    NET_HAS_SINGLE_PIN = 'ERC041',

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