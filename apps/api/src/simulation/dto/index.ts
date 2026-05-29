/**
 * Simulation DTOs
 */
import { IsObject, IsString, IsArray, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSimulationDto {
    @ApiProperty({ description: 'Analysis configuration' })
    @IsObject()
    analysisConfig!: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Probes to measure', example: ['v(out)', 'v(in)'] })
    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    probes?: string[];
}

export class QuickSimulationDto {
    @ApiProperty({ description: 'SPICE netlist' })
    @IsString()
    netlist!: string;

    @ApiPropertyOptional({ description: 'Analysis configuration' })
    @IsObject()
    @IsOptional()
    analysisConfig?: Record<string, unknown>;
}