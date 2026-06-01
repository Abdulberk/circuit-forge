/**
 * EDA-Core Library
 * Core EDA functionality for circuit manipulation, netlist generation, and simulation output parsing
 */

// Types
export type {
    CircuitJson,
    Component,
    ComponentSourcing,
    Net,
    PinConnection,
    ComponentType,
    CircuitMetadata,
    UiJson,
    Viewport,
    Position,
    Wire,
} from './types/circuit';

export { COMPONENT_PINS, SPICE_PREFIXES, COMPONENT_TYPES, isSimulatable } from './types/circuit';

export type {
    AnalysisConfig,
    TranAnalysis,
    AcAnalysis,
    DcAnalysis,
    OpAnalysis,
} from './types/analysis';

export type {
    SimulationResult,
    DataSeries,
    DataPoint,
    ResultMeta,
} from './types/simulation';

export type {
    ErcResult,
    ErcIssue,
    ErcConfig,
} from './types/erc';

export { ErcCode } from './types/erc';
export type { ErcSeverity } from './types/erc';

// Schemas
export {
    CircuitJsonSchema,
    ComponentSchema,
    ComponentSourcingSchema,
    NetSchema,
    ComponentTypeSchema,
    PinConnectionSchema,
    CircuitMetadataSchema,
    ViewportSchema,
    PositionSchema,
    WireSchema,
    UiJsonSchema,
    validateCircuitJson,
    safeValidateCircuitJson,
    validateUiJson,
    type CircuitJsonInput,
    type CircuitJsonOutput,
    type ComponentInput,
    type NetInput,
    type UiJsonInput,
} from './schemas/circuit.schema';

export {
    AnalysisConfigSchema,
    TranAnalysisSchema,
    AcAnalysisSchema,
    DcAnalysisSchema,
    OpAnalysisSchema,
    SpiceValueSchema,
    ProbeSchema,
    SimulationRequestSchema,
    validateAnalysisConfig,
    safeValidateAnalysisConfig,
    validateSimulationRequest,
    type AnalysisConfigInput,
    type AnalysisConfigOutput,
    type SimulationRequestInput,
} from './schemas/analysis.schema';

// Netlist generation
export {
    generateNetlist,
    getNodeNames,
    validateNetlist,
    type NetlistOptions,
} from './netlist';

// Netlist sanitization
export {
    sanitizeNodeName,
    validateIncludePaths,
    validateIncludePath,
    sanitizeNetlist,
    sanitizeValue,
    validateDesignator,
    hasShellMetacharacters,
    SecurityError,
} from './netlist';

// Parsing
export {
    parseCsv,
    parseRawAscii,
    detectOutputFormat,
    parseSimulationOutput,
} from './parser';

export {
    parseNetlist,
    extractProbes,
    type NetlistParseResult,
} from './parser';

// ERC
export {
    runErc,
    quickCheck,
    ERC_DESCRIPTIONS,
    ERC_SEVERITIES,
} from './erc';

// Utilities
export {
    parseSpiceValue,
    formatSpiceValue,
    normalizeValue,
    valuesEqual,
    parseTimeValue,
    parseFrequencyValue,
    type ParsedValue,
} from './utils';