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
});

/**
 * Operating point analysis schema
 */
export const OpAnalysisSchema = z.object({
    type: z.literal('op'),
});

/**
 * Combined analysis config schema
 */
export const AnalysisConfigSchema = z.discriminatedUnion('type', [
    TranAnalysisSchema,
    AcAnalysisSchema,
    DcAnalysisSchema,
    OpAnalysisSchema,
]);

/**
 * Probe schema
 */
export const ProbeSchema = z.string().regex(
    /^[vi]\([a-zA-Z0-9_]+(?:,[a-zA-Z0-9_]+)?\)$/i,
    'Invalid probe format. Use v(node) or i(device)',
);

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