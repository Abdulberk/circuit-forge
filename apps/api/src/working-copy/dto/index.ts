import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsISO8601,
    IsObject,
    IsOptional,
    IsUUID,
    Validate,
    ValidatorConstraint,
    type ValidatorConstraintInterface,
} from 'class-validator';

/**
 * A draft must be SHAPED like a circuit. It does not have to be a finished one.
 *
 * The distinction is the whole design here. This row is autosaved on a debounce while someone is editing, so
 * it is legitimately incomplete most of the time — a component placed but not yet valued, a net with one pin
 * on it, a footprint not chosen. Running the full CircuitJson schema (as POST /layouts does, where
 * correctness genuinely matters) would reject those and make editing impossible.
 *
 * But `@IsObject()` alone accepted ANYTHING: `{"nope": true}` was stored as a circuit and answered 200. The
 * cost lands far away and looks like something else — the editor loads the project and renders an empty
 * tree, `components` is undefined at every later stage, and the eventual layout job fails with a message
 * about a property that was never there. Nothing points back to the write that caused it.
 *
 * So: `components` and `nets` must be arrays. That separates "a circuit being worked on" from "not a
 * circuit", costs one type check, and rejects nothing a real editor would ever send.
 */
@ValidatorConstraint({ name: 'circuitShape', async: false })
export class HasCircuitShape implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        if (typeof value !== 'object' || value === null) return false;
        const { components, nets } = value as { components?: unknown; nets?: unknown };
        return Array.isArray(components) && Array.isArray(nets);
    }

    defaultMessage(): string {
        return 'circuitJson must have `components` and `nets` arrays (a draft may be incomplete, but it must be a circuit)';
    }
}

/**
 * Autosave the project's working copy (the live editor draft). Idempotent: the client PUTs the latest
 * circuit + UI state (debounced ~1-2s idle), overwriting the single draft row in place. `baseVersionId`
 * records which saved version the draft descends from, for a "N unsaved changes since vX" indicator.
 */
export class SaveWorkingCopyDto {
    @ApiProperty({
        description: 'OUR CircuitJson — the current editable circuit',
        type: 'object',
        additionalProperties: true,
    })
    @IsObject()
    @Validate(HasCircuitShape)
    circuitJson!: Record<string, unknown>;

    @ApiProperty({
        description: 'Editor/layout UI state to persist alongside the circuit',
        type: 'object',
        additionalProperties: true,
    })
    @IsObject()
    uiJson!: Record<string, unknown>;

    @ApiPropertyOptional({
        description: 'The saved version this draft descends from (must belong to the same project)',
        format: 'uuid',
    })
    @IsOptional()
    @IsUUID()
    baseVersionId?: string;

    /**
     * Optimistic concurrency, opt-in.
     *
     * The draft is one row per project and the save was an unconditional upsert — deliberately
     * last-writer-wins, which is right for a single tab autosaving keystrokes and is data loss the moment
     * two editors are open. Two tabs of the SAME user overwrite each other and neither is told; the loser's
     * work is gone with no error, no conflict, no trace.
     *
     * Sending the `updatedAt` the client last saw turns that into a 409 carrying the server's current
     * value, so the client can reconcile instead of discovering the loss later. OMITTING it keeps the old
     * behaviour exactly, so no existing caller changes — the guarantee is available to whoever wants it
     * rather than imposed on a contract that predates the editor.
     */
    @ApiPropertyOptional({
        description:
            'The `updatedAt` this client last saw. When sent, the save is REJECTED with 409 if the row has ' +
            'moved since — the response carries the current value so the client can reconcile. Omit for ' +
            'last-writer-wins.',
        format: 'date-time',
    })
    @IsOptional()
    @IsISO8601()
    expectedUpdatedAt?: string;
}

/**
 * The same concurrency token, for the operation that destroys the whole draft at once.
 *
 * DELETE used to take nothing and delete unconditionally, so the guarantee PUT offers — a stale client
 * cannot overwrite work it never saw — was enforced on the write and absent on the erase. A second tab
 * pressing "revert to last saved" would discard a draft the first tab was still typing into.
 */
export class DiscardWorkingCopyQueryDto {
    @ApiPropertyOptional({
        description:
            'The `updatedAt` this client last saw. When sent, the discard is REFUSED with 409 if the draft ' +
            'has moved since. Omit for the unconditional discard.',
        format: 'date-time',
    })
    @IsOptional()
    @IsISO8601()
    expectedUpdatedAt?: string;
}
