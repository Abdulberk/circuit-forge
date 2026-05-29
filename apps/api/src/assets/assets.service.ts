/**
 * Assets Service
 * Handles presigned URL generation and asset management
 */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PrismaService } from '../prisma/prisma.service';
import { OrgsService } from '../orgs/orgs.service';
import { PresignUploadDto, CommitAssetDto } from './dto';
import { randomUUID } from 'crypto';

@Injectable()
export class AssetsService {
    private s3: S3Client;
    private bucket: string;

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgsService: OrgsService,
    ) {
        this.bucket = process.env.S3_BUCKET || 'circuitforge';
        this.s3 = new S3Client({
            endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
            region: process.env.S3_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin',
                secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin',
            },
            forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
        });
    }

    /**
     * Generate presigned URL for upload
     */
    async presignUpload(orgId: string, userId: string, dto: PresignUploadDto) {
        await this.orgsService.requireMembership(orgId, userId);

        // Generate unique S3 key
        const s3Key = `orgs/${orgId}/models/${randomUUID()}/${dto.name}`;

        // Create presigned PUT URL
        const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: s3Key,
            ContentType: dto.contentType,
            ContentLength: dto.sizeBytes,
        });

        const uploadUrl = await getSignedUrl(this.s3, command, { expiresIn: 3600 });

        return {
            uploadUrl,
            s3Key,
        };
    }

    /**
     * Commit uploaded asset to database
     */
    async commitAsset(orgId: string, userId: string, dto: CommitAssetDto) {
        await this.orgsService.requireMembership(orgId, userId);

        // Verify file exists in S3
        try {
            const headCommand = new HeadObjectCommand({
                Bucket: this.bucket,
                Key: dto.s3Key,
            });
            await this.s3.send(headCommand);
        } catch (error) {
            throw new BadRequestException('Asset not found in storage. Upload may have failed.');
        }

        // Verify s3Key belongs to this org
        if (!dto.s3Key.startsWith(`orgs/${orgId}/`)) {
            throw new BadRequestException('Invalid S3 key for this organization');
        }

        // Create asset record
        return this.prisma.asset.create({
            data: {
                orgId,
                type: 'SPICE_MODEL',
                name: dto.name,
                contentType: dto.contentType,
                sizeBytes: dto.sizeBytes,
                s3Key: dto.s3Key,
                sha256: dto.sha256,
            },
        });
    }

    /**
     * List assets for an organization
     */
    async listAssets(orgId: string, userId: string, type?: string) {
        await this.orgsService.requireMembership(orgId, userId);

        const where: any = { orgId };
        if (type) {
            where.type = type;
        }

        return this.prisma.asset.findMany({
            where,
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Get asset by ID
     */
    async getAsset(assetId: string, userId: string) {
        const asset = await this.prisma.asset.findUnique({
            where: { id: assetId },
        });

        if (!asset) {
            throw new NotFoundException('Asset not found');
        }

        await this.orgsService.requireMembership(asset.orgId, userId);

        return asset;
    }

    /**
     * Get download URL for asset
     */
    async getDownloadUrl(assetId: string, userId: string) {
        const asset = await this.getAsset(assetId, userId);

        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: asset.s3Key,
        });

        const downloadUrl = await getSignedUrl(this.s3, command, { expiresIn: 3600 });

        return { downloadUrl };
    }

    /**
     * Delete asset
     */
    async deleteAsset(assetId: string, userId: string) {
        const asset = await this.getAsset(assetId, userId);

        // Check if user is admin/owner
        const membership = await this.orgsService.requireMembership(asset.orgId, userId);
        if (membership.role !== 'OWNER' && membership.role !== 'ADMIN') {
            throw new BadRequestException('Only admins can delete assets');
        }

        // Note: We don't delete from S3 to prevent accidental data loss
        // A cleanup job can be added later for orphaned files
        await this.prisma.asset.delete({
            where: { id: assetId },
        });

        return { deleted: true };
    }
}