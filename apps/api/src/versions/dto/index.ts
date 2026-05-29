/**
 * Versions DTOs
 */
import { IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateVersionDto {
    @ApiProperty({ description: 'Circuit JSON (canonical format)' })
    @IsObject()
    circuitJson!: Record<string, unknown>;

    @ApiProperty({ description: 'UI JSON (layout information)' })
    @IsObject()
    uiJson!: Record<string, unknown>;
}