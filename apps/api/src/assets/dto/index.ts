/**
 * Assets DTOs
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsInt, Min, Max, IsHash, IsOptional } from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';

/** List query: pagination (limit/offset) + an optional type filter. Extends the shared pagination DTO so all
 *  three params are whitelisted together (the global forbidNonWhitelisted pipe would 400 a stray query). */
export class AssetListQueryDto extends PaginationQueryDto {
    @ApiPropertyOptional({ description: 'Filter by asset type (e.g. SPICE_MODEL)' })
    @IsString()
    @IsOptional()
    type?: string;
}

export class PresignUploadDto {
    @ApiProperty({ description: 'File name', example: 'mydiode.lib' })
    @IsString()
    name!: string;

    @ApiProperty({ description: 'Content type', example: 'text/plain' })
    @IsString()
    contentType!: string;

    @ApiProperty({ description: 'File size in bytes', example: 1024 })
    @IsInt()
    @Min(1)
    @Max(10 * 1024 * 1024) // 10MB max
    sizeBytes!: number;

    @ApiProperty({ description: 'SHA256 hash of file content' })
    @IsString()
    @IsHash('sha256')
    sha256!: string;
}

export class CommitAssetDto {
    @ApiProperty({ description: 'S3 key from presign response' })
    @IsString()
    s3Key!: string;

    @ApiProperty({ description: 'File name' })
    @IsString()
    name!: string;

    @ApiProperty({ description: 'Content type' })
    @IsString()
    contentType!: string;

    @ApiProperty({ description: 'File size in bytes' })
    @IsInt()
    @Min(1)
    sizeBytes!: number;

    @ApiProperty({ description: 'SHA256 hash of file content' })
    @IsString()
    @IsHash('sha256')
    sha256!: string;
}