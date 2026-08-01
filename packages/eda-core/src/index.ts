/**
 * EDA-Core Library
 * Core EDA functionality for circuit manipulation, netlist generation, and simulation output parsing
 */

// Types
export type {
    CircuitJson,
    Component,
    ComponentSourcing,
    ModelDef,
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

// Active-device model library (generic, license-clean SPICE models + resolvers)
export {
    GENERIC_MODELS,
    resolveModelForPart,
    genericModelByName,
    resolveGenericModels,
    buildZenerModel,
    normalizeControlledSourceGain,
    parseTransformerParams,
    parseTransmissionLineParams,
    type ResolveModelInput,
    type TransformerParams,
    type TransmissionLineParams,
} from './models/library';

export type {
    AnalysisConfig,
    TranAnalysis,
    AcAnalysis,
    DcAnalysis,
    OpAnalysis,
    NoiseAnalysis,
    SensAnalysis,
    MeasureSpec,
} from './types/analysis';

export type {
    SimulationResult,
    DataSeries,
    DataPoint,
    ResultMeta,
    FourierResult,
    FourierHarmonic,
    MeasurementResult,
    TransferFunctionResult,
    NoiseResult,
    SensitivityResult,
    SensitivityEntry,
} from './types/simulation';

export type { ErcResult, ErcIssue, ErcConfig } from './types/erc';

export { ErcCode } from './types/erc';
export type { ErcSeverity } from './types/erc';

// Schemas
export {
    CircuitJsonSchema,
    ComponentSchema,
    ComponentSourcingSchema,
    ModelDefSchema,
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
    buildNodeMap,
    validateDeck,
    DeckRefusal,
    isDeckRefusal,
    type NetlistOptions,
} from './netlist';

// What the deck actually contained — tells "the circuit does not do that" apart from "the part that
// would have done it has no simulatable model and was never in the deck".
export { simulationCoverage, describeCoverage, type SimulationCoverage, type OmittedComponent } from './netlist';

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

// Solver options + Convergence Doctor (shared by the inline API simulator and the worker)
export {
    solverOptionTokens,
    applySolverOptions,
    diagnoseConvergence,
    convergenceRemedyLadder,
    type ConvergenceKind,
    type ConvergenceDiagnosis,
    type RemedyStep,
    type ConvergenceReport,
    type SolverOptions,
} from './netlist';

// Parsing
export { parseCsv, parseRawAscii, detectOutputFormat, parseSimulationOutput } from './parser';

export { parseNetlist, extractProbes, type NetlistParseResult } from './parser';

// Result export (CSV / VCD writers — take a finished SimulationResult out to other tools)
export { resultToCsv, resultToVcd, type CsvExportOptions, type VcdExportOptions } from './parser';

// Monte-Carlo / tolerance (verify at X% yield, not just nominal)
export {
    perturbValue,
    perturbCircuit,
    monteCarloVariants,
    computeYield,
    runMonteCarlo,
    classifyRobustness,
    // Exported so callers/tests can assert the relationship a bar and a run cap must satisfy, instead of
    // rediscovering it: a cap below requiredRunsForBar(robustMin) makes that tier unreachable at any setting.
    requiredRunsForBar,
    // The ONE place an absent profile becomes a concrete set of bars. Both the sampler and the grader must
    // go through it, or a default request is sampled against one target and scored against another.
    barsForProfile,
    DEFAULT_ROBUSTNESS_PROFILE,
    ROBUSTNESS_PROFILES,
    type TolDistribution,
    type YieldSummary,
    type VariantOutcome,
    type VariantRunner,
    type MonteCarloOptions,
    type MonteCarloYield,
    type RobustnessTier,
    type RobustnessBars,
    type RobustnessVerdict,
} from './montecarlo';
export { mulberry32 } from './utils/prng';

// Parametric sweep (`.step`-style) — the deterministic sibling of Monte-Carlo: over what RANGE of a chosen
// parameter does the design still meet spec? (reuses the same injected VariantRunner + one-job-dir batch path)
export { sweepVariants, runParametricSweep, type SweepSpec, type SweepPoint, type SweepResult } from './sweep';

// Worst-case (corner) analysis — the deterministic tolerance-EXTREME lens: does the spec hold at every ±tol
// corner? (random Monte-Carlo can miss the true worst corner; this hits them exactly). Shares the VariantRunner.
export {
    cornerVariants,
    runWorstCase,
    type CornerSpec,
    type CornerSide,
    type CornerPoint,
    type WorstCaseResult,
} from './corner';

// Temperature-corner analysis — the AMBIENT-temperature lens (does the spec hold + how do metrics drift across
// cold/room/hot?), emitted as `.temp <T>` per run. Informational, ambient-only (no self-heating/Tj). Profile-driven
// range (ROBUSTNESS_PROFILES.tempCornersC). Passive-only circuits are temperature-flat → not-applicable, not passed.
export {
    hasTemperatureResponsiveDevice,
    runTempCorner,
    TEMP_CORNER_CEILING,
    type TempRunner,
    type TempCornerSpec,
    type TempCornerPoint,
    type TempMetricDrift,
    type TempCornerResult,
} from './tempcorner';

// Supply-voltage corner analysis — does the spec hold when the SUPPLY varies (±%)? Perturbs each trusted power
// rail's DRIVING SOURCE (never forces the rail — a regulator regulates naturally) and reports pass/fail + per-node
// drift vs the nominal run. validatePowerRails is the mini-ERC over the isPower DECLARATION with a refutation
// asymmetry (evidence-absent trusts, only evidence-contrary defers). Informational; profile-neutral; needs isPower.
export {
    driversOf,
    validatePowerRails,
    runSupplyCorner,
    type RailStatus,
    type RailValidation,
    type SupplyCornerSpec,
    type SupplyCornerPoint,
    type SupplyDrift,
    type SupplyCornerResult,
} from './supply-corner';

// Analysis — measurement distillation + assertion evaluation (shared by the API AND the Monte-Carlo worker,
// which is why they live here and not in the API).
export { summarizeSeries, type SimMeasurement } from './analysis/measurements';
export {
    assessTransientCompleteness,
    TRANSIENT_COMPLETE_FRACTION,
    type TransientCompleteness,
} from './analysis/transient-completeness';
export { cutoffFrequency, isAcMagnitudeSeries, type FreqMagPoint } from './analysis/ac-measurements';
export { parseFourierLog } from './analysis/fourier';
export { parseMeasurements } from './analysis/measure';
export { parseTransferFunction } from './analysis/tf';
export { parseNoise, parseNoiseTotals } from './analysis/noise';
export { parseSensitivity } from './analysis/sens';
export {
    nodeKey,
    netIdByRef,
    isCurrentProbe,
    currentKey,
    isObservableCurrentProbe,
    extraProbesForCriteria,
    compareAssertion,
    evaluateAssertions,
    attachFourierThd,
    attachTransferFunction,
    describeFailure,
    criterionDimension,
    requiredDimensions,
    uncoveredRequiredDimensions,
    type AcceptanceCriterion,
    type AssertionResult,
    type SpecDimension,
} from './analysis/assertions';

// Verification scope manifest (the disclosure primitive for an honest "verified" badge)
export {
    CHECK_IDS,
    CHECK_LABELS,
    EXCLUDED_CHECKS,
    excludedEntries,
    withCheck,
    buildManifest,
    buildElectricalScope,
    buildLayoutScope,
    type CheckId,
    type CheckStatus,
    type CheckGradation,
    type CheckEntry,
    type DeterminedEntry,
    type ScopeManifest,
    type RoutingDisclosure,
} from './verification/manifest';
// Pre-layout design-review graph checks (orientation role-consistency; decoupling deferred until the
// circuit model carries power-rail marking — see design-review.ts header)
export {
    checkOrientationConsistency,
    type OrientationReport,
    type OrientationFinding,
} from './verification/design-review';

// ERC
export { runErc, quickCheck, ERC_DESCRIPTIONS, ERC_SEVERITIES } from './erc';

// Utilities
export {
    parseSpiceValue,
    downsamplePoints,
    downsampleResult,
    formatSpiceValue,
    normalizeValue,
    valuesEqual,
    parseTimeValue,
    parseFrequencyValue,
    type ParsedValue,
} from './utils';

// E-series (IEC 60063) preferred-value snapping — make AI/formula-derived values sourceable.
export {
    nearestESeries,
    isESeriesValue,
    snapValueString,
    snapCircuitToESeries,
    type ESeries,
    type ESeriesSnapChange,
    type ESeriesSnapResult,
} from './utils/eseries';
