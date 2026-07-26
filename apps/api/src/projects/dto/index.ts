/**
 * Projects DTOs
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MinLength, MaxLength, IsOptional } from 'class-validator';

export class CreateProjectDto {
    @ApiProperty({ example: 'My Circuit Project' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name!: string;

    @ApiPropertyOptional({ example: 'Description of my project' })
    @IsString()
    @IsOptional()
    @MaxLength(2000)
    description?: string;
}

export class UpdateProjectDto {
    @ApiPropertyOptional({ example: 'Updated Project Name' })
    @IsString()
    @IsOptional()
    @MinLength(1)
    @MaxLength(100)
    name?: string;

    @ApiPropertyOptional({ example: 'Updated description' })
    @IsString()
    @IsOptional()
    @MaxLength(2000)
    description?: string;
}