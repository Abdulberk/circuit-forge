/**
 * Templates DTOs
 */
import { IsString, IsOptional, IsArray, IsObject, IsUUID, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateTemplateDto {
    @ApiPropertyOptional({ description: 'Organization ID (null for public template)' })
    @IsOptional()
    @IsUUID()
    orgId?: string;

    @ApiProperty({ description: 'Template name' })
    @IsString()
    name!: string;

    @ApiPropertyOptional({ description: 'Tags for categorization', type: [String] })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    tags?: string[];

    @ApiProperty({ description: 'Circuit JSON definition' })
    @IsObject()
    circuitJson!: Record<string, any>;

    @ApiPropertyOptional({
        description:
            'Recommended simulation setup: { analysis: AnalysisConfig, probes?: string[] }. Carries the analysis the ' +
            'template was validated with — including tran initialConditions (e.g. an oscillator startup seed) that ' +
            'CircuitJson itself cannot express.',
    })
    @IsOptional()
    @IsObject()
    analysisConfig?: Record<string, any>;
}

export class ListTemplatesQueryDto {
    @ApiPropertyOptional({ description: 'Filter by organization ID' })
    @IsOptional()
    @IsUUID()
    orgId?: string;

    @ApiPropertyOptional({ description: 'Filter by tag' })
    @IsOptional()
    @IsString()
    tag?: string;

    @ApiPropertyOptional({ description: 'Maximum number of results', default: 50 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    limit?: number;

    @ApiPropertyOptional({ description: 'Offset for pagination', default: 0 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    offset?: number;
}