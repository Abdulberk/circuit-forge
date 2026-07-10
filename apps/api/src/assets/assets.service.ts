/**
 * Assets Service
 * Handles presigned URL generation and asset management
 */
import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PrismaService } from '../prisma/prisma.service';
import { OrgsService } from '../orgs/orgs.service';
import { UsageService } from '../usage/usage.service';
import { paginated } from '../common/dto/pagination.dto';
import { PresignUploadDto, CommitAssetDto } from './dto';
import { randomUUID } from 'crypto';

@Injectable()
export class AssetsService {
    private readonly logger = new Logger(AssetsService.name);
    private readonly s3: S3Client;
    private readonly bucket: string;

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgsService: OrgsService,
        private readonly usageService: UsageService,
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

        // A suspended org can't upload (writes are blocked platform-wide); the commit path is guarded too,
        // but reject at presign so we don't hand out an upload URL that can never be committed.
        await this.usageService.assertOrgNotSuspended(orgId);

        // Storage quota gate (no-op until QUOTA_STORAGE_BYTES_PER_ORG is configured): reject before
        // handing out an upload URL, so the org can't keep growing past its cap.
        await this.usageService.assertStorageQuota(orgId, dto.sizeBytes);

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

        // Verify file exists in S3 — and take its size from S3, not the client's claim. The storage
        // quota aggregates this column, so a client-supplied number would let anyone under-report.
        let actualSizeBytes: number;
        try {
            const headCommand = new HeadObjectCommand({
                Bucket: this.bucket,
                Key: dto.s3Key,
            });
            const head = await this.s3.send(headCommand);
            actualSizeBytes = typeof head.ContentLength === 'number' ? head.ContentLength : dto.sizeBytes;
        } catch (error) {
            throw new BadRequestException('Asset not found in storage. Upload may have failed.');
        }

        // Verify s3Key belongs to this org
        if (!dto.s3Key.startsWith(`orgs/${orgId}/`)) {
            throw new BadRequestException('Invalid S3 key for this organization');
        }

        // Re-gate at commit with the OBSERVED size, under the storage-quota guard: presign gating
        // alone can be raced (parallel presigns) or sidestepped (URL issued before a limit was
        // tightened, oversized upload). When QUOTA_STORAGE_BYTES_PER_ORG is set, the check + insert
        // run under a per-org advisory lock so concurrent commits can't collectively overshoot the
        // cap; when unset, this is a plain create with no added overhead.
        const created = await this.usageService.createAssetGuarded(orgId, actualSizeBytes, (tx) =>
            tx.asset.create({
                data: {
                    orgId,
                    type: 'SPICE_MODEL',
                    name: dto.name,
                    contentType: dto.contentType,
                    sizeBytes: actualSizeBytes,
                    s3Key: dto.s3Key,
                    sha256: dto.sha256,
                },
            }),
        );

        // Compensating check (deliberately OUTSIDE the guarded create — never hold the advisory lock over
        // S3): the key is client-supplied, so a concurrent deleteAsset or admin orphan-sweep can remove the
        // object between the HeadObject above and the row insert. Re-verify; if the object vanished, roll
        // the row back and fail LOUDLY instead of leaving a live row whose download 404s forever.
        try {
            await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: dto.s3Key }));
        } catch (e) {
            // Roll back ONLY on a genuine not-found (the object was concurrently deleted). A transient
            // 5xx/timeout/throttle must NOT destroy a valid commit — the object is almost certainly still
            // there; fail-open (keep the row) and let the orphan sweep reclaim it in the rare true-orphan case.
            const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
            const name = (e as { name?: string }).name;
            const notFound = status === 404 || name === 'NotFound' || name === 'NoSuchKey';
            if (!notFound) return created;
            await this.prisma.asset.delete({ where: { id: created.id } }).catch(() => undefined);
            throw new BadRequestException('Asset object disappeared during commit (deleted concurrently). Re-upload and commit again.');
        }
        return created;
    }

    /**
     * List assets for an organization
     */
    async listAssets(orgId: string, userId: string, page: { limit: number; offset: number }, type?: string) {
        await this.orgsService.requireMembership(orgId, userId);

        const where: any = { orgId };
        if (type) {
            where.type = type;
        }

        const [items, total] = await Promise.all([
            // id tie-breaker → TOTAL order so paging can't skip/duplicate equal-createdAt assets at a page edge.
            this.prisma.asset.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.offset, take: page.limit }),
            this.prisma.asset.count({ where }),
        ]);
        return paginated(items, total, page.limit, page.offset);
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

        // Row first (authoritative — the quota and every read aggregate rows), then the object.
        // NOTE (semantics): a QUEUED simulation enqueued before this delete carries the resolved s3Key in its
        // BullMQ payload and downloads lazily — deleting the asset makes that job fail LOUDLY at model
        // download. Self-inflicted (the org deleted its own in-use asset) and visible, so accepted.
        await this.prisma.asset.delete({
            where: { id: assetId },
        });

        // Delete the S3 object too — leaving it made every deleted asset an invisible, forever-orphan
        // (unmetered bucket growth). Guard: only when NO other row still references the same key (commit
        // is client-supplied, so two rows CAN share one key). EVERYTHING after the row delete is
        // best-effort: the row delete is the source of truth, so neither the count read nor the S3 call
        // may 500 an already-successful delete — on any failure we warn and the orphan sweep reclaims it.
        try {
            const stillReferenced = await this.prisma.asset.count({ where: { s3Key: asset.s3Key } });
            if (stillReferenced === 0) {
                await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: asset.s3Key }));
            }
        } catch (e) {
            this.logger.warn(
                `asset ${assetId} row deleted but S3 object ${asset.s3Key} could not be removed (the orphan sweep will reclaim it): ${e instanceof Error ? e.message : String(e)}`,
            );
        }

        return { deleted: true };
    }
}