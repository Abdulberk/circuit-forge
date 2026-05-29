/**
 * Organizations DTOs
 */
import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateOrgDto {
    @ApiProperty({ example: 'My Company' })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name!: string;
}