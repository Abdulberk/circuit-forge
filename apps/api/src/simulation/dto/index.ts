/**
 * Simulation DTOs
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsString, IsArray, IsOptional, ArrayMaxSize } from 'class-validator';

export class CreateSimulationDto {
    @ApiProperty({ description: 'Analysis configuration' })
    @IsObject()
    analysisConfig!: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Probes to measure', example: ['v(out)', 'v(in)'] })
    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    probes?: string[];

    @ApiPropertyOptional({
        description:
            'IDs of uploaded SPICE_MODEL assets (this org) to .include in the netlist — for parts using a custom/manufacturer model. The asset filename must match the .include reference; a component’s `model` must match a name defined inside the uploaded file.',
        example: ['7b2c…'],
    })
    @IsArray()
    @IsString({ each: true })
    @ArrayMaxSize(32)
    @IsOptional()
    modelAssetIds?: string[];
}

export class QuickSimulationDto {
    @ApiProperty({ description: 'SPICE netlist' })
    @IsString()
    netlist!: string;

    @ApiPropertyOptional({ description: 'Analysis configuration' })
    @IsObject()
    @IsOptional()
    analysisConfig?: Record<string, unknown>;

    @ApiPropertyOptional({
        description:
            'IDs of uploaded SPICE_MODEL assets (this org) to make available to the run. The netlist must `.include` each asset by its filename.',
        example: ['7b2c…'],
    })
    @IsArray()
    @IsString({ each: true })
    @ArrayMaxSize(32)
    @IsOptional()
    modelAssetIds?: string[];
}