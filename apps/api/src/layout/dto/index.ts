import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsIn } from 'class-validator';

/**
 * Start a PCB layout job. `circuit` is OUR CircuitJson (topology: components + nets) — the same shape
 * pcb-core's layoutCircuit consumes. Layout options are optional and default to pcb-core's own defaults.
 */
export class CreateLayoutDto {
    @ApiProperty({ description: 'OUR CircuitJson (components + nets) to lay out', type: 'object', additionalProperties: true })
    @IsObject()
    circuit!: Record<string, unknown>;

    @ApiPropertyOptional({ description: "Placement engine: 'grid' (default) or 'auto' (connectivity-aware)", enum: ['grid', 'auto'] })
    @IsOptional()
    @IsIn(['grid', 'auto'])
    placer?: 'grid' | 'auto';

    @ApiPropertyOptional({ description: 'Fab profile overrides (clearance/width/via tier)', type: 'object', additionalProperties: true })
    @IsOptional()
    @IsObject()
    fabProfile?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'RMS current (A) per emitted net name → IPC-2221 per-net trace width', type: 'object', additionalProperties: true })
    @IsOptional()
    @IsObject()
    netCurrentsA?: Record<string, number>;
}
