import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsIn, IsUUID } from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';

/**
 * Start a PCB layout job. `circuit` is OUR CircuitJson (topology: components + nets) — the same shape
 * pcb-core's layoutCircuit consumes. Layout options are optional and default to pcb-core's own defaults.
 */
export class CreateLayoutDto {
    @ApiProperty({
        description: 'OUR CircuitJson (components + nets) to lay out',
        type: 'object',
        additionalProperties: true,
    })
    @IsObject()
    circuit!: Record<string, unknown>;

    @ApiPropertyOptional({
        description:
            "Tag this layout to a saved circuit version. When set, the job is created under that version's org, " +
            'stores its project + version, and can be re-found via GET /layouts?versionId= after a reload. Omit for an ad-hoc layout of an unsaved circuit.',
        format: 'uuid',
    })
    @IsOptional()
    @IsUUID()
    versionId?: string;

    @ApiPropertyOptional({
        description:
            "Placement engine: 'grid' (default), 'auto' (TypeScript connectivity-aware), or 'rust' (out-of-process optimized engine)",
        enum: ['grid', 'auto', 'rust'],
    })
    @IsOptional()
    @IsIn(['grid', 'auto', 'rust'])
    placer?: 'grid' | 'auto' | 'rust';

    @ApiPropertyOptional({
        description: 'Fab profile overrides (clearance/width/via tier)',
        type: 'object',
        additionalProperties: true,
    })
    @IsOptional()
    @IsObject()
    fabProfile?: Record<string, unknown>;

    @ApiPropertyOptional({
        description: 'RMS current (A) per emitted net name → IPC-2221 per-net trace width',
        type: 'object',
        additionalProperties: true,
    })
    @IsOptional()
    @IsObject()
    netCurrentsA?: Record<string, number>;
}

/**
 * List layout jobs for the caller's org(s), newest first, optionally narrowed to one version or project.
 * The client uses `?versionId=` to re-hydrate the PCB tab for a saved circuit after a page reload.
 */
export class ListLayoutsQueryDto extends PaginationQueryDto {
    @ApiPropertyOptional({ description: 'Only layouts tagged to this saved circuit version', format: 'uuid' })
    @IsOptional()
    @IsUUID()
    versionId?: string;

    @ApiPropertyOptional({ description: 'Only layouts tagged to this project', format: 'uuid' })
    @IsOptional()
    @IsUUID()
    projectId?: string;
}
