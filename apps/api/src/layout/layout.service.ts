/**
 * Async PCB layout-job lifecycle (the LRO behind /layouts). Mirrors DesignJobService: create() persists a
 * QUEUED LayoutJob row and ENQUEUES it onto the durable 'pcb-layout' queue where the pcb-worker runs the
 * quality pipeline and writes the outcome back onto the row. This service owns only the row lifecycle +
 * presigning the S3 artifacts on read; it does NOT run the pipeline.
 */
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException, ServiceUnavailableException, Logger } from '@nestjs/common';
import { propagation, context as otelContext } from '@opentelemetry/api';
import { type LayoutJobStatus } from '@prisma/client';
import { Queue } from 'bullmq';

import { paginated, type Paginated } from '../common/dto/pagination.dto';
import { OrgsService } from '../orgs/orgs.service';
import { PrismaService } from '../prisma/prisma.service';
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
        // Resolve the org this layout belongs to. When the client tags a saved version, the layout is
        // authoritatively scoped to THAT version's org (and we derive its project) after verifying the
        // caller is a member — the client can't spoof a project/version it can't access. Only the ad-hoc
        // (no versionId) path falls back to the user's first org.
        let orgId: string;
        let projectId: string | undefined;
        let versionId: string | undefined;
        if (dto.versionId) {
            const version = await this.prisma.projectVersion.findUnique({
                where: { id: dto.versionId },
                select: { id: true, projectId: true, project: { select: { orgId: true } } },
            });
            if (!version) throw new NotFoundException('Version not found');
            await this.orgs.checkMembership(version.project.orgId, userId);
            orgId = version.project.orgId;
            projectId = version.projectId;
            versionId = version.id;
        } else {
            const orgList = await this.orgs.findAllForUser(userId);
            const first = orgList[0]?.id;
            if (!first) throw new NotFoundException('No organization found for user');
            orgId = first;
        }

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
                    projectId,
                    versionId,
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
            this.logger.error(
                `layout job ${job.id} could not be enqueued: ${err instanceof Error ? err.message : String(err)}`,
            );
            await this.prisma.layoutJob
                .updateMany({
                    where: { id: job.id, status: 'QUEUED' },
                    data: {
                        status: 'FAILED',
                        errorMessage: 'Could not queue the layout job; please retry.',
                        finishedAt: new Date(),
                    },
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
                id: true,
                orgId: true,
                projectId: true,
                versionId: true,
                status: true,
                result: true,
                errorMessage: true,
                glbKey: true,
                gerbersKey: true,
                createdAt: true,
                startedAt: true,
                finishedAt: true,
            },
        });
        if (!job) throw new NotFoundException('Layout job not found');
        await this.orgs.checkMembership(job.orgId, userId);

        const presign = async (key: string | null) =>
            key
                ? getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: 3600 })
                : undefined;

        return {
            id: job.id,
            projectId: job.projectId,
            versionId: job.versionId,
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

    /**
     * List the caller's layout jobs (across every org they belong to), newest first, optionally narrowed to
     * one version or project. This is how the client re-hydrates the PCB tab after a page reload: it holds the
     * versionId (durable) rather than the jobId (browser-memory-only), and asks `?versionId=` for the layouts.
     * Bounded by the shared pagination envelope; light rows only (no S3 presign) — the detail view presigns.
     */
    async findAllForUser(
        userId: string,
        page: { limit: number; offset: number },
        filter: { versionId?: string; projectId?: string } = {},
    ): Promise<Paginated<unknown>> {
        const orgList = await this.orgs.findAllForUser(userId);
        const orgIds = orgList.map((o) => o.id);
        if (orgIds.length === 0) return paginated([], 0, page.limit, page.offset);

        const where = {
            orgId: { in: orgIds },
            ...(filter.versionId ? { versionId: filter.versionId } : {}),
            ...(filter.projectId ? { projectId: filter.projectId } : {}),
        };
        const [items, total] = await Promise.all([
            this.prisma.layoutJob.findMany({
                where,
                // id tiebreaker → a TOTAL order so skip/take paging can't skip/duplicate a row when two jobs
                // share a createdAt (matches ProjectsService / AssetsService / AdminService list convention).
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                select: {
                    id: true,
                    projectId: true,
                    versionId: true,
                    status: true,
                    errorMessage: true,
                    createdAt: true,
                    startedAt: true,
                    finishedAt: true,
                    // Not returned — mapped to the `manufacturable` verdict below.
                    gerbersKey: true,
                },
                skip: page.offset,
                take: page.limit,
            }),
            this.prisma.layoutJob.count({ where }),
        ]);
        // A board KiCad rejected and a board it certified BOTH finish as SUCCEEDED with no errorMessage —
        // the analysis completed in each case, and only the verdict differs. Without a field for it, a list
        // view could not render a truthful badge without one detail request per row, and each of those
        // returns the whole result blob (tens of KB of geometry and DRC checks) purely to read one boolean.
        //
        // `gerbersKey` IS the verdict: the worker writes it only on the manufacturable branch and never on
        // the withhold branch, so no new column or migration is needed. The key itself stays internal — a
        // storage path is not part of the client contract, and the detail endpoint presigns it anyway.
        const rows = items.map(({ gerbersKey, ...job }) => ({
            ...job,
            // null, not false, while the question does not yet have an answer: a queued, running or failed
            // job has no manufacturability verdict, and reporting `false` would read as "we checked it and
            // it failed" — the exact over-claim this codebase keeps having to remove.
            manufacturable: job.status === 'SUCCEEDED' ? gerbersKey !== null : null,
        }));
        return paginated(rows, total, page.limit, page.offset);
    }
}
