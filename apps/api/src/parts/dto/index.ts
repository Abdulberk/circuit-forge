/**
 * Component-catalog DTOs.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, IsOptional, MinLength, MaxLength, IsInt, Min, Max } from 'class-validator';

export class SearchPartsDto {
    @ApiProperty({
        description: 'Search phrase (keyword or manufacturer part number)',
        example: 'NE555',
        minLength: 1,
        maxLength: 100,
    })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    q!: string;

    @ApiPropertyOptional({ description: 'Filter by manufacturer id (from /parts/manufacturers)', maxLength: 50 })
    @IsString()
    @IsOptional()
    @MaxLength(50)
    manufacturerId?: string;

    @ApiPropertyOptional({ description: 'Filter by category id (from /parts/categories)', maxLength: 50 })
    @IsString()
    @IsOptional()
    @MaxLength(50)
    categoryId?: string;

    @ApiPropertyOptional({ description: 'Page (1-based)', minimum: 1, maximum: 1000, default: 1 })
    @Type(() => Number)
    @IsInt()
    @IsOptional()
    @Min(1)
    @Max(1000)
    page?: number;
}
