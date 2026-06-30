/**
 * Zod schemas for analysis configuration validation
 */
import { z } from 'zod';

/**
 * SPICE value format - number with optional suffix
 */
export const SpiceValueSchema = z.string().regex(
    /^[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?\s*[a-zA-Z]*$/,
    'Invalid SPICE value format',
);

/**
 * Probe schema — v(node) or i(device). Defined here (before the analysis schemas) so analyses can reuse it.
 */
export const ProbeSchema = z.string().regex(
    /^[vi]\([a-zA-Z0-9_]+(?:,[a-zA-Z0-9_]+)?\)$/i,
    'Invalid probe format. Use v(node) or i(device)',
);

/**
 * `.meas` measurement spec — built into a validated `.meas` card by the generator (never raw passthrough).
 * name is restricted to a SPICE-safe identifier; value/edge apply only to type "when".
 */
export const MeasureSpecSchema = z.object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Invalid measure name (letters/digits/underscore)').max(40),
    type: z.enum(['max', 'min', 'pp', 'avg', 'rms', 'integ', 'when']),
    probe: ProbeSchema,
    value: z.number().finite().optional(),
    edge: z.enum(['rise', 'fall', 'cross']).optional(),
});

/**
 * Solver tuning (`.options`) schema — every numeric field must be a clean SPICE value (anchored
 * regex, no expressions: these tokens go straight onto a netlist line).
 */
export const SolverOptionsSchema = z.object({
    reltol: SpiceValueSchema.optional(),
    abstol: SpiceValueSchema.optional(),
    vntol: SpiceValueSchema.optional(),
    gmin: SpiceValueSchema.optional(),
    method: z.enum(['trap', 'gear']).optional(),
    itl4: z.number().int().positive().max(10000).optional(),
});

/**
 * Transient analysis schema
 */
export const TranAnalysisSchema = z.object({
    type: z.literal('tran'),
    stopTime: SpiceValueSchema,
    stepTime: SpiceValueSchema.optional(),
    startTime: SpiceValueSchema.optional(),
    maxStep: SpiceValueSchema.optional(),
    uic: z.boolean().optional(),
    initialConditions: z.record(z.string().min(1).max(100), z.number()).optional(),
    options: SolverOptionsSchema.optional(),
    fourier: z
        .object({
            fundamentalFreq: SpiceValueSchema,
            probes: z.array(ProbeSchema).min(1).max(20),
        })
        .optional(),
    measurements: z.array(MeasureSpecSchema).min(1).max(20).optional(),
});

/**
 * AC analysis schema
 */
export const AcAnalysisSchema = z.object({
    type: z.literal('ac'),
    variation: z.enum(['dec', 'oct', 'lin']),
    points: z.number().int().positive().max(10000),
    startFreq: SpiceValueSchema,
    stopFreq: SpiceValueSchema,
    options: SolverOptionsSchema.optional(),
});

/**
 * DC analysis schema
 */
export const DcAnalysisSchema = z.object({
    type: z.literal('dc'),
    source: z.string().regex(/^[A-Z][A-Z0-9]*[0-9]+$/i, 'Invalid source designator'),
    startVal: SpiceValueSchema,
    stopVal: SpiceValueSchema,
    increment: SpiceValueSchema,
    options: SolverOptionsSchema.optional(),
});

/**
 * Operating point analysis schema
 */
export const OpAnalysisSchema = z.object({
    type: z.literal('op'),
    options: SolverOptionsSchema.optional(),
    tf: z
        .object({
            output: ProbeSchema,
            inputSource: z.string().regex(/^[A-Z][A-Z0-9]*[0-9]+$/i, 'Invalid source designator'),
        })
        .optional(),
});

/**
 * Noise analysis schema — small-signal noise vs frequency (output/input-referred density + integrated totals).
 */
export const NoiseAnalysisSchema = z.object({
    type: z.literal('noise'),
    output: ProbeSchema,
    inputSource: z.string().regex(/^[A-Z][A-Z0-9]*[0-9]+$/i, 'Invalid source designator'),
    variation: z.enum(['dec', 'oct', 'lin']),
    points: z.number().int().positive().max(10000),
    startFreq: SpiceValueSchema,
    stopFreq: SpiceValueSchema,
    options: SolverOptionsSchema.optional(),
});

/**
 * DC sensitivity analysis schema — d(output)/d(component) table.
 */
export const SensAnalysisSchema = z.object({
    type: z.literal('sens'),
    output: ProbeSchema,
    options: SolverOptionsSchema.optional(),
});

/**
 * Combined analysis config schema
 */
export const AnalysisConfigSchema = z.discriminatedUnion('type', [
    TranAnalysisSchema,
    AcAnalysisSchema,
    DcAnalysisSchema,
    OpAnalysisSchema,
    NoiseAnalysisSchema,
    SensAnalysisSchema,
]);

/**
 * Simulation request schema
 */
export const SimulationRequestSchema = z.object({
    analysisConfig: AnalysisConfigSchema,
    probes: z.array(ProbeSchema).max(100).optional(),
    modelAssets: z.array(z.string().uuid()).max(10).optional(),
});

/**
 * Type exports
 */
export type AnalysisConfigInput = z.input<typeof AnalysisConfigSchema>;
export type AnalysisConfigOutput = z.output<typeof AnalysisConfigSchema>;
export type SimulationRequestInput = z.input<typeof SimulationRequestSchema>;

/**
 * Validate analysis config
 */
export function validateAnalysisConfig(data: unknown): AnalysisConfigOutput {
    return AnalysisConfigSchema.parse(data);
}

/**
 * Safe validate analysis config
 */
export function safeValidateAnalysisConfig(
    data: unknown,
): z.SafeParseReturnType<AnalysisConfigInput, AnalysisConfigOutput> {
    return AnalysisConfigSchema.safeParse(data);
}

/**
 * Validate simulation request
 */
export function validateSimulationRequest(data: unknown): z.output<typeof SimulationRequestSchema> {
    return SimulationRequestSchema.parse(data);
}