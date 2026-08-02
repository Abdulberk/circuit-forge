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

/**
 * The ONE rule for what a reference designator may look like.
 *
 * Exported because it is not only a schema concern: an editor has to refuse a bad designator at the moment
 * it is typed, and the only thing worse than no check there is a DIFFERENT check. A second pattern in the
 * editor accepted `C_IN`, `X$1` and `J1-2` — all rejected here — so the working copy (which validates shape
 * only) stored them happily and the failure surfaced later as a 400 from POST /layouts, about a part the user
 * had renamed minutes earlier. One exported constant, imported by whoever needs it, cannot drift from itself.
 *
 * Letter prefix + number, with an OPTIONAL trailing section letter so multi-section refdes (op-amp sections
 * "U1A"/"U1B", relay contacts "K1A") are accepted — previously they were wrongly rejected.
 */
export const DESIGNATOR_PATTERN = /^[A-Z][A-Z0-9]*[0-9]+[A-Z]?$/i;

export const ComponentSchema = z.object({
    id: z.string().min(1).max(100),
    type: ComponentTypeSchema,
    designator: z.string().regex(DESIGNATOR_PATTERN, 'Invalid designator format'),
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
export const ViewportSchema = z
    .object({
        x: z.number().finite(),
        y: z.number().finite(),
        // Positive AND finite: a zoom of 0 divides by zero in every transform, and Infinity survives JSON
        // as null but not as a number a renderer can use.
        zoom: z.number().positive().finite(),
    })
    .strict();

/** A point on the sheet. `.strict()` so a rotation cannot be smuggled onto a coordinate. */
export const PointSchema = z
    .object({
        x: z.number().finite(),
        y: z.number().finite(),
    })
    .strict();

/**
 * Position schema
 */
export const PositionSchema = z
    .object({
        x: z.number().finite(),
        y: z.number().finite(),
        rotation: z.enum(['0', '90', '180', '270']).optional(),
        mirror: z.enum(['x', 'y']).optional(),
    })
    .strict();

export const PinRefSchema = z
    .object({
        componentId: z.string().min(1).max(100),
        pinId: z.string().min(1).max(100),
    })
    .strict();

/**
 * Wire schema.
 *
 * `points` is `PointSchema`, not `PositionSchema` — the TypeScript type used to say `Position[]`, which
 * admitted a meaningless `rotation` on a wire vertex, while this schema said `{x, y}`. The two disagreed,
 * and the disagreement is the kind that survives review because neither side looks wrong on its own.
 *
 * `null` on an endpoint means "attached to nothing", which is a real state a user can create by drawing a
 * wire into empty space. `undefined` means the drawing does not record it — an older document.
 */
export const WireSchema = z
    .object({
        id: z.string().min(1).max(100).optional(),
        netId: z.string().min(1).max(100),
        points: z.array(PointSchema).max(500),
        from: PinRefSchema.nullish(),
        to: PinRefSchema.nullish(),
    })
    .strict();

/**
 * UI JSON schema — the drawing.
 *
 * `.strict()` EVERYWHERE, and that is the whole point of touching this file. A plain `z.object` STRIPS
 * unknown keys, so validating the editor's state with a schema that had not caught up would silently delete
 * whatever it did not recognise — a user's wire routing, gone, with a 200 and no message. Strict turns the
 * same mistake into a 400 that names the field. For a document written by our own editor, loud is correct:
 * a field the server does not know is a field that was going to be lost anyway.
 *
 * Note `{}` still validates, and must — a project with no drawing yet is the ordinary case, and every draft
 * in existence today holds exactly that. Enforcement here is about not LOSING what is sent, not about
 * requiring anything to be sent.
 */
export const UiJsonSchema = z
    .object({
        schemaVersion: z.literal(1).optional(),
        viewport: ViewportSchema.optional(),
        positions: z.record(PositionSchema).optional(),
        wires: z.array(WireSchema).max(5000).optional(),
        sheetId: z.string().min(1).max(100).optional(),
    })
    .strict();

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
export function safeValidateCircuitJson(data: unknown): z.SafeParseReturnType<CircuitJsonInput, CircuitJsonOutput> {
    return CircuitJsonSchema.safeParse(data);
}

/**
 * Validate UI JSON
 */
export function validateUiJson(data: unknown): z.output<typeof UiJsonSchema> {
    return UiJsonSchema.parse(data);
}

/**
 * Safe validate UI JSON — the shape a caller can branch on rather than catch.
 *
 * The throwing version is unusable inside a save handler: an editor has to TELL the user which field it
 * refused, not unwind through a try/catch that ends at "something went wrong".
 */
export function safeValidateUiJson(data: unknown) {
    return UiJsonSchema.safeParse(data);
}
