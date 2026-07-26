import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsUUID } from 'class-validator';

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
}
