/**
 * Zod schemas for circuit validation
 */
import { z } from 'zod';

import { COMPONENT_TYPES } from '../types/circuit';

/**
 * Component type enum schema — derived from the single-source `COMPONENT_TYPES` tuple in
 * types/circuit.ts so the runtime enum and the TS union can never drift.
 */
export const ComponentTypeSchema = z.enum(COMPONENT_TYPES);

/**
 * Pin connection schema
 */
export const PinConnectionSchema = z.object({
    pinId: z.string().min(1).max(50),
    netId: z.string().min(1).max(100),
});

/**
 * Component schema
 */
/**
 * Sourcing / catalog metadata schema (real manufacturer part attached to a component)
 */
export const ComponentSourcingSchema = z.object({
    supplier: z.string().min(1).max(40),
    supplierId: z.string().min(1).max(100),
    unitCost: z.number().nonnegative().optional(),
    currency: z.string().max(8).optional(),
    stock: z.number().int().nonnegative().optional(),
    datasheetUrl: z.string().url().max(2000).optional(),
});

export const ComponentSchema = z.object({
    id: z.string().min(1).max(100),
    type: ComponentTypeSchema,
    // Letter prefix + number, with an OPTIONAL trailing section letter so multi-section refdes (op-amp
    // sections "U1A"/"U1B", relay contacts "K1A") are accepted — previously they were wrongly rejected.
    designator: z.string().regex(/^[A-Z][A-Z0-9]*[0-9]+[A-Z]?$/i, 'Invalid designator format'),
    value: z.string().max(100).optional(),
    model: z.string().max(100).optional(),
    /** Fractional manufacturing tolerance (e.g. 0.05 = ±5%) for Monte-Carlo yield analysis. */
    tolerance: z.number().min(0).max(1).optional(),
    /** Provenance of `tolerance` — a datasheet FACT from the sourced real part ('catalog') vs. one the
     *  user/design explicitly stated ('user'). Lets the robustness verdict disclose the tolerance basis
     *  honestly (never a silent assumption); absent = tolerance origin unspecified. */
    toleranceSource: z.enum(['user', 'catalog']).optional(),
    pins: z.array(PinConnectionSchema).min(1).max(64), // up to wide multi-terminal subckt ICs
    properties: z.record(z.unknown()).optional(),
    // Optional real-part / catalog metadata
    mpn: z.string().max(100).optional(),
    manufacturer: z.string().max(120).optional(),
    footprint: z.string().max(50).optional(),
    sourcing: ComponentSourcingSchema.optional(),
});

/**
 * SPICE model/subckt definition schema (referenced by Component.model for active devices).
 */
export const ModelDefSchema = z.object({
    name: z.string().min(1).max(100),
    device: z.enum(['bjt', 'mosfet', 'jfet', 'diode', 'subckt', 'switch', 'digital']),
    body: z.string().min(1).max(20000),
    tier: z.enum(['manufacturer', 'generic', 'ideal']).optional(),
    // subckt only: pinIds in the macromodel's port order, so the generator binds nodes by pinId.
    ports: z.array(z.string().min(1).max(50)).max(64).optional(),
});

/**
 * Net schema
 */
export const NetSchema = z.object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    isGround: z.boolean().optional(),
    /** Power/supply-rail marker (VCC/VDD/+5V) — a DECLARATION validated against topology before use (see Net.isPower). */
    isPower: z.boolean().optional(),
});

/**
 * Circuit metadata schema
 */
export const CircuitMetadataSchema = z.object({
    name: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    author: z.string().max(100).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
});

/**
 * Main CircuitJson schema
 */
export const CircuitJsonSchema = z.object({
    version: z.string().regex(/^\d+\.\d+$/),
    components: z.array(ComponentSchema).max(1000),
    nets: z.array(NetSchema).max(1000),
    models: z.array(ModelDefSchema).max(200).optional(),
    metadata: CircuitMetadataSchema.optional(),
});

/**
 * Viewport schema
 */
export const ViewportSchema = z.object({
    x: z.number(),
    y: z.number(),
    zoom: z.number().positive(),
});

/**
 * Position schema
 */
export const PositionSchema = z.object({
    x: z.number(),
    y: z.number(),
    rotation: z.enum(['0', '90', '180', '270']).optional(),
});

/**
 * Wire schema
 */
export const WireSchema = z.object({
    netId: z.string(),
    points: z.array(
        z.object({
            x: z.number(),
            y: z.number(),
        }),
    ),
});

/**
 * UI JSON schema
 */
export const UiJsonSchema = z.object({
    viewport: ViewportSchema.optional(),
    positions: z.record(PositionSchema).optional(),
    wires: z.array(WireSchema).optional(),
});

/**
 * Type exports from schemas
 */
export type CircuitJsonInput = z.input<typeof CircuitJsonSchema>;
export type CircuitJsonOutput = z.output<typeof CircuitJsonSchema>;
export type ComponentInput = z.input<typeof ComponentSchema>;
export type NetInput = z.input<typeof NetSchema>;
export type UiJsonInput = z.input<typeof UiJsonSchema>;

/**
 * Validate circuit JSON
 */
export function validateCircuitJson(data: unknown): CircuitJsonOutput {
    return CircuitJsonSchema.parse(data);
}

/**
 * Safe validate circuit JSON (returns result instead of throwing)
 */
export function safeValidateCircuitJson(
    data: unknown,
): z.SafeParseReturnType<CircuitJsonInput, CircuitJsonOutput> {
    return CircuitJsonSchema.safeParse(data);
}

/**
 * Validate UI JSON
 */
export function validateUiJson(data: unknown): z.output<typeof UiJsonSchema> {
    return UiJsonSchema.parse(data);
}