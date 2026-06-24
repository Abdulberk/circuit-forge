/**
 * AI circuit generation DTOs
 */
import {
    IsString,
    IsOptional,
    MinLength,
    MaxLength,
    IsInt,
    Min,
    Max,
    IsObject,
    IsNumber,
    IsIn,
    IsArray,
    ArrayMaxSize,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One measurable spec checked against the simulation — the unit of a "verified design" report. */
export class AssertionDto {
    @ApiProperty({ description: 'Probe/node to measure, e.g. "out" or "v(out)" (the v()/i() wrapper is optional). For metric "cutoff" this is the output node of the frequency response.' })
    @IsString()
    @MinLength(1)
    @MaxLength(64)
    probe!: string;

    @ApiProperty({
        description:
            'Which measured quantity. min/max/final/pp are over the time/DC run; "cutoff" is the −3 dB corner frequency (Hz) of the node\'s AC magnitude response and requires an "ac" analysis.',
        enum: ['min', 'max', 'final', 'pp', 'cutoff'],
    })
    @IsIn(['min', 'max', 'final', 'pp', 'cutoff'])
    metric!: 'min' | 'max' | 'final' | 'pp' | 'cutoff';

    @ApiProperty({ description: 'Comparison operator', enum: ['lt', 'lte', 'gt', 'gte', 'approx'] })
    @IsIn(['lt', 'lte', 'gt', 'gte', 'approx'])
    op!: 'lt' | 'lte' | 'gt' | 'gte' | 'approx';

    @ApiProperty({ description: 'Target value (SI base units: volts, amps, seconds; Hz for metric "cutoff")' })
    @IsNumber()
    value!: number;

    @ApiPropertyOptional({ description: 'Absolute tolerance for op="approx" (default 5% of |value|)' })
    @IsNumber()
    @IsOptional()
    @Min(0)
    tol?: number;

    @ApiPropertyOptional({ description: 'Human label for the report, e.g. "Output settles to 5V"' })
    @IsString()
    @IsOptional()
    @MaxLength(120)
    label?: string;
}

export class VerifyDesignDto {
    @ApiProperty({ description: 'The circuit to verify (CircuitJson)' })
    @IsObject()
    circuit!: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Analysis config; defaults to an operating-point analysis when omitted' })
    @IsObject()
    @IsOptional()
    analysisConfig?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Spec assertions to check against the simulation (max 50)', type: [AssertionDto] })
    @IsArray()
    @IsOptional()
    @ArrayMaxSize(50)
    @ValidateNested({ each: true })
    @Type(() => AssertionDto)
    assertions?: AssertionDto[];
}

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
