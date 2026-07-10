/**
 * Async PCB layout-job lifecycle (the LRO behind /layouts). Mirrors DesignJobService: create() persists a
 * QUEUED LayoutJob row and ENQUEUES it onto the durable 'pcb-layout' queue where the pcb-worker runs the
 * quality pipeline and writes the outcome back onto the row. This service owns only the row lifecycle +
 * presigning the S3 artifacts on read; it does NOT run the pipeline.
 */
import { Injectable, NotFoundException, ServiceUnavailableException, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { type LayoutJobStatus } from '@prisma/client';
import { propagation, context as otelContext } from '@opentelemetry/api';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PrismaService } from '../prisma/prisma.service';
import { OrgsService } from '../orgs/orgs.service';
import { UsageService } from '../usage/usage.service';
import { CreateLayoutDto } from './dto';

function otelCarrier(): Record<string, string> {
    const carrier: Record<string, string> = {};
    propagation.inject(otelContext.active(), carrier);
    return carrier;
}

@Injectable()
export class LayoutService {
    private readonly logger = new Logger(LayoutService.name);
    private readonly s3: S3Client;
    private readonly bucket: string;

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrgsService,
        private readonly usage: UsageService,
        @InjectQueue('pcb-layout') private readonly layoutQueue: Queue,
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
     * Create a QUEUED layout job under the user's (first) org and enqueue it. The insert and the BullMQ
     * add are two stores; if the add fails we conditionally flip the row to FAILED (gated on status:QUEUED
     * so we never clobber a worker that already dequeued+advanced it — see DesignJobService for the rationale).
     */
    async create(userId: string, dto: CreateLayoutDto): Promise<{ id: string; status: LayoutJobStatus }> {
        const orgList = await this.orgs.findAllForUser(userId);
        const orgId = orgList[0]?.id;
        if (!orgId) throw new NotFoundException('No organization found for user');

        const options = {
            ...(dto.placer ? { placer: dto.placer } : {}),
            ...(dto.fabProfile ? { fabProfile: dto.fabProfile } : {}),
            ...(dto.netCurrentsA ? { netCurrentsA: dto.netCurrentsA } : {}),
        };

        // Admission control (parity with sim/design): SUSPENSION is enforced for every enqueue, and any
        // configured QUOTA_LAYOUT_* limit is re-checked under a per-org advisory lock. A plain insert until a
        // limit is set — so this changes nothing until layout quotas are configured. Keep the closure to the
        // insert ONLY; the BullMQ add happens after the lock releases (never hold a lock over Redis).
        const job = await this.usage.createLayoutGuarded(orgId, (tx) =>
            tx.layoutJob.create({
                data: {
                    orgId,
                    userId,
                    status: 'QUEUED',
                    circuit: dto.circuit as object,
                    options: Object.keys(options).length ? (options as object) : undefined,
                },
                select: { id: true, status: true },
            }),
        );

        try {
            await this.layoutQueue.add('layout', { jobId: job.id, otel: otelCarrier() }, { jobId: job.id });
        } catch (err) {
            this.logger.error(`layout job ${job.id} could not be enqueued: ${err instanceof Error ? err.message : String(err)}`);
            await this.prisma.layoutJob
                .updateMany({
                    where: { id: job.id, status: 'QUEUED' },
                    data: { status: 'FAILED', errorMessage: 'Could not queue the layout job; please retry.', finishedAt: new Date() },
                })
                .catch(() => undefined);
            throw new ServiceUnavailableException('Could not start the layout job; please retry.');
        }

        return job;
    }

    /** Status + (when finished) the shaped result + presigned URLs for the GLB / manufacturing bundle. */
    async getForUser(jobId: string, userId: string) {
        const job = await this.prisma.layoutJob.findUnique({
            where: { id: jobId },
            select: {
                id: true, orgId: true, status: true, result: true, errorMessage: true,
                glbKey: true, gerbersKey: true, createdAt: true, startedAt: true, finishedAt: true,
            },
        });
        if (!job) throw new NotFoundException('Layout job not found');
        await this.orgs.checkMembership(job.orgId, userId);

        const presign = async (key: string | null) =>
            key ? getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: 3600 }) : undefined;

        return {
            id: job.id,
            status: job.status,
            result: job.result ?? null,
            errorMessage: job.errorMessage ?? null,
            glbUrl: await presign(job.glbKey),
            gerbersUrl: await presign(job.gerbersKey),
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
        };
    }
}
