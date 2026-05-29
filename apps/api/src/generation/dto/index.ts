/**
 * AI circuit generation DTOs
 */
import { IsString, IsOptional, MinLength, MaxLength, IsInt, Min, Max, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GenerateCircuitDto {
    @ApiProperty({
        description: 'Natural-language description of the circuit to generate',
        example: 'An RC low-pass filter with a 1 kHz cutoff driven by a 5V source',
        minLength: 1,
        maxLength: 2000,
    })
    @IsString()
    @MinLength(1)
    @MaxLength(2000)
    prompt!: string;

    @ApiPropertyOptional({
        description: 'Optional extra design constraints',
        example: 'Use standard E12 resistor values; single 5V supply',
        maxLength: 1000,
    })
    @IsString()
    @IsOptional()
    @MaxLength(1000)
    constraints?: string;
}

export class DesignCircuitDto {
    @ApiProperty({
        description: 'Natural-language description of the circuit to design and verify by simulation',
        example: 'A half-wave rectifier with a smoothing capacitor, 10V peak 50Hz AC input',
        minLength: 1,
        maxLength: 2000,
    })
    @IsString()
    @MinLength(1)
    @MaxLength(2000)
    prompt!: string;

    @ApiPropertyOptional({ description: 'Optional extra design constraints', maxLength: 1000 })
    @IsString()
    @IsOptional()
    @MaxLength(1000)
    constraints?: string;

    @ApiPropertyOptional({
        description: 'Max generate→simulate→fix rounds (1–4, default 2)',
        minimum: 1,
        maximum: 4,
        default: 2,
    })
    @IsInt()
    @IsOptional()
    @Min(1)
    @Max(4)
    maxRounds?: number;
}

export class EditCircuitDto {
    @ApiProperty({ description: 'The circuit to modify (CircuitJson)' })
    @IsObject()
    circuit!: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Current analysis config (optional)' })
    @IsObject()
    @IsOptional()
    analysisConfig?: Record<string, unknown>;

    @ApiProperty({
        description: 'Natural-language edit instruction',
        example: 'Change R1 to 10k and add a 1uF output capacitor to ground',
        minLength: 1,
        maxLength: 2000,
    })
    @IsString()
    @MinLength(1)
    @MaxLength(2000)
    instruction!: string;

    @ApiPropertyOptional({ description: 'Optional extra constraints', maxLength: 1000 })
    @IsString()
    @IsOptional()
    @MaxLength(1000)
    constraints?: string;
}

export class ExplainCircuitDto {
    @ApiProperty({ description: 'The circuit to explain (CircuitJson)' })
    @IsObject()
    circuit!: Record<string, unknown>;
}
