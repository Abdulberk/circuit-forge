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

/** What an issue is ABOUT: a part on the sheet, or a node between parts. */
export interface ErcSubject {
    kind: 'component' | 'net';
    id: string;
}

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

    /**
     * IDs of related components or nets.
     *
     * Kept exactly as it was, because it is part of the published surface and reaches the API and the LLM
     * prompt. It cannot say WHICH kind each id names, which is what `related` is for — read that when you
     * have to point at an object rather than merely name it.
     */
    relatedIds: string[];

    /**
     * The same objects, each saying what it IS — in the same order as `relatedIds`.
     *
     * A bare id cannot be resolved: a component id and a net id are both just strings, and nothing stops one
     * document holding the same string as both. A reader that guessed by looking the id up in the components
     * marked the WRONG OBJECT — measured on a sheet whose spare net was called `r1`, where three remarks
     * about the net put a mark on the resistor, and a user opening R1 to see what was wrong found nothing.
     *
     * Optional so that an issue built by hand — a test, a fixture, an older document — is still a valid
     * issue; a consumer that needs the kind falls back to guessing, exactly as it had to before.
     */
    related?: ErcSubject[];
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
