/**
 * Zod schemas for circuit validation
 */
import { z } from 'zod';

/**
 * Component type enum schema
 */
export const ComponentTypeSchema = z.enum([
    'resistor',
    'capacitor',
    'inductor',
    'voltage_source',
    'current_source',
    'diode',
    'ground',
]);

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
export const ComponentSchema = z.object({
    id: z.string().min(1).max(100),
    type: ComponentTypeSchema,
    designator: z.string().regex(/^[A-Z][A-Z0-9]*[0-9]+$/i, 'Invalid designator format'),
    value: z.string().max(100).optional(),
    model: z.string().max(100).optional(),
    pins: z.array(PinConnectionSchema).min(1).max(20),
    properties: z.record(z.unknown()).optional(),
});

/**
 * Net schema
 */
export const NetSchema = z.object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    isGround: z.boolean().optional(),
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