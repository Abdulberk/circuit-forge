/**
 * Assets DTOs
 */
import { IsString, IsInt, Min, Max, IsHash } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

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