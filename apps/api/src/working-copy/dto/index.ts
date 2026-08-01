import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsObject, IsOptional, IsUUID } from 'class-validator';

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
