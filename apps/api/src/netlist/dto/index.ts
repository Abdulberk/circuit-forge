import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsObject, IsOptional, IsString, MaxLength, MinLength, ArrayMaxSize } from 'class-validator';

export class ImportNetlistDto {
    @ApiProperty({
        description: 'A standard SPICE netlist (LTspice/KiCad/ngspice deck). Max 200 KB.',
        example: '* RC filter\nV1 in 0 SIN(0 5 1k)\nR1 in out 1k\nC1 out 0 100n\n.tran 10u 5m\n.end',
    })
    @IsString()
    @MinLength(1)
    @MaxLength(200_000)
    netlist!: string;
}

export class ExportNetlistDto {
    @ApiProperty({ description: 'The CircuitJson to export (validated against the full schema).' })
    @IsObject()
    circuitJson!: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'AnalysisConfig for the emitted analysis card (defaults to { type: "op" }).' })
    @IsOptional()
    @IsObject()
    analysisConfig?: Record<string, unknown>;

    @ApiPropertyOptional({
        description: 'Explicit probes (v(net)/i(dev)); defaults to one voltage probe per node.',
        type: [String],
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(100)
    @IsString({ each: true })
    probes?: string[];
}
