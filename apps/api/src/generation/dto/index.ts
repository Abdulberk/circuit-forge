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
    IsBoolean,
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
            'Which measured quantity. min/max/final/pp/avg/rms are over the time/DC run (avg+rms are TIME-WEIGHTED — trapezoidal over the adaptive timesteps — so "RMS output"/"average ripple" specs are exact); "cutoff" is the −3 dB corner frequency (Hz) of the node\'s AC magnitude response and requires an "ac" analysis; "thd" is the Total Harmonic Distortion (PERCENT) and requires a "tran" analysis with a "fourier" request on the probe; "gain" is the small-signal DC gain (Vout/Vin) and requires an "op" analysis with a "tf" request to the probe.',
        enum: ['min', 'max', 'final', 'pp', 'avg', 'rms', 'cutoff', 'thd', 'gain'],
    })
    @IsIn(['min', 'max', 'final', 'pp', 'avg', 'rms', 'cutoff', 'thd', 'gain'])
    metric!: 'min' | 'max' | 'final' | 'pp' | 'avg' | 'rms' | 'cutoff' | 'thd' | 'gain';

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

/** Optional robustness checks layered on top of the nominal verify-design verdict (informational — they never
 *  flip the pass/fail verdict, they annotate how robust a PASSING design is). */
export class RobustnessDto {
    @ApiPropertyOptional({ description: 'Check the spec at every ±tolerance worst-case corner of the toleranced components (needs components with a "tolerance"). Runs only when the nominal verdict is "pass".' })
    @IsBoolean()
    @IsOptional()
    corner?: boolean;

    @ApiPropertyOptional({ description: 'Cap on how many toleranced components to corner (⇒ ≤ 2^n runs); default 8. With more toleranced parts, the first n (circuit order) are cornered and the rest reported as omitted.' })
    @IsInt()
    @Min(1)
    @Max(12)
    @IsOptional()
    maxCorners?: number;

    @ApiPropertyOptional({ description: 'Monte-Carlo tolerance-yield analysis: sample the circuit N times with every toleranced part drawn within its tolerance, and grade the pass-rate into a robustness tier (robust/marginal/at-risk on the Wilson-95% lower bound). Runs only when the nominal verdict is "pass" and the circuit has toleranced parts (user-set or catalog-sourced). Informational; it flips the verdict to fail ONLY when the tier is at-risk AND the tolerances were user-specified.' })
    @IsBoolean()
    @IsOptional()
    montecarlo?: boolean;

    @ApiPropertyOptional({ description: 'Monte-Carlo sample count (virtual builds). Default 500; raise it for a tighter confidence bound (a "robust" claim needs a large-enough sample). Capped at 2000.' })
    @IsInt()
    @Min(1)
    @Max(2000)
    @IsOptional()
    n?: number;

    @ApiPropertyOptional({ description: 'Monte-Carlo PRNG seed for a reproducible run (same seed ⇒ identical sample set).' })
    @IsInt()
    @IsOptional()
    seed?: number;

    @ApiPropertyOptional({ description: 'Yield bars for the tier: "consumer" (robust ≥99%, ≈Cpk 1.33), "automotive"/"medical" (robust ≥99.9%). Default "consumer".', enum: ['consumer', 'automotive', 'medical'] })
    @IsIn(['consumer', 'automotive', 'medical'])
    @IsOptional()
    profile?: 'consumer' | 'automotive' | 'medical';

    @ApiPropertyOptional({ description: 'Re-check the spec and report per-node metric drift across the profile\'s ambient temperature set (consumer 0/25/70, automotive -40/25/125, medical -40/25/85 °C). INFORMATIONAL and AMBIENT-ONLY (no self-heating/Tj) — never gates the verdict. Temperature-flat circuits (passive-only / behavioral subckt) are reported not-applicable. Runs only when the nominal verdict is "pass".' })
    @IsBoolean()
    @IsOptional()
    temperature?: boolean;

    @ApiPropertyOptional({ description: 'Re-check the spec and report per-node drift when each POWER RAIL\'s driving source is perturbed ±tolerance (default ±5%). Needs a net marked isPower (validated against the topology; a net that no DC source drives is deferred, disclosed as not-run). INFORMATIONAL — never gates the verdict. Runs only when the nominal verdict is "pass".' })
    @IsBoolean()
    @IsOptional()
    supply?: boolean;

    @ApiPropertyOptional({ description: 'Supply tolerance to sweep for the supply corner, fractional (e.g. 0.05 = ±5%). Default 0.05.', minimum: 0, maximum: 1 })
    @IsNumber()
    @IsOptional()
    supplyTolerance?: number;
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

    @ApiPropertyOptional({ description: 'Optional robustness checks. The corner check is informational; the Monte-Carlo tier is informational too EXCEPT it flips the verdict to fail when at-risk AND tolerances are user-specified.', type: RobustnessDto })
    @IsObject()
    @IsOptional()
    @ValidateNested()
    @Type(() => RobustnessDto)
    robustness?: RobustnessDto;
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
