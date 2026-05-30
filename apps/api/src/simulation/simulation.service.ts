/**
 * Simulation Service
 */
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { PrismaService } from '../prisma/prisma.service';
import { VersionsService } from '../versions/versions.service';
import { OrgsService } from '../orgs/orgs.service';
import { generateNetlist } from '@circuit-forge/eda-core';
import type { CircuitJson, AnalysisConfig } from '@circuit-forge/eda-core';

@Injectable()
export class SimulationService {
    private readonly logger = new Logger(SimulationService.name);
    private readonly s3: S3Client;
    private readonly bucket: string;

    constructor(
        private prisma: PrismaService,
        private versionsService: VersionsService,
        private orgsService: OrgsService,
        @InjectQueue('simulations') private simulationQueue: Queue,
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

    async createFromVersion(
        versionId: string,
        analysisConfig: Record<string, unknown>,
        probes: string[] | undefined,
        userId: string,
    ) {
        const version = await this.versionsService.findOne(versionId, userId);
        const circuitJson = version.circuitJson as unknown as CircuitJson;

        // Generate netlist - cast to AnalysisConfig for eda-core
        const netlist = generateNetlist(circuitJson, analysisConfig as unknown as AnalysisConfig, { probes });

        // Create job record
        const job = await this.prisma.simulationJob.create({
            data: {
                orgId: version.project.orgId,
                projectVersionId: versionId,
                status: 'QUEUED',
                engine: 'NGSPICE',
                analysisConfig: analysisConfig as Prisma.InputJsonValue,
                netlist,
            },
        });

        // Add to queue
        const analysisType = (analysisConfig as { type?: string }).type || 'tran';
        await this.simulationQueue.add('simulation', {
            jobId: job.id,
            orgId: version.project.orgId,
            netlist,
            probeNames: probes || [],
            analysisType,
            analysisConfig,
        });

        return { jobId: job.id };
    }

    async createQuickSim(
        netlist: string,
        analysisConfig: Record<string, unknown> | undefined,
        userId: string,
    ) {
        // Get user's first org for quick sim
        const orgs = await this.orgsService.findAllForUser(userId);
        if (orgs.length === 0) {
            throw new NotFoundException('No organization found for user');
        }

        const orgId = orgs[0]?.id;
        if (!orgId) {
            throw new NotFoundException('No organization found for user');
        }

        // Create job record
        const job = await this.prisma.simulationJob.create({
            data: {
                orgId,
                status: 'QUEUED',
                engine: 'NGSPICE',
                analysisConfig: (analysisConfig || {}) as Prisma.InputJsonValue,
                netlist,
            },
        });

        // Add to queue
        const analysisType = (analysisConfig as { type?: string } | undefined)?.type || 'tran';
        await this.simulationQueue.add('simulation', {
            jobId: job.id,
            orgId,
            netlist,
            probeNames: [],
            analysisType,
            analysisConfig: analysisConfig || {},
        });

        return { jobId: job.id };
    }

    async getStatus(jobId: string, userId: string) {
        const job = await this.prisma.simulationJob.findUnique({
            where: { id: jobId },
        });

        if (!job) {
            throw new NotFoundException('Simulation job not found');
        }

        await this.orgsService.checkMembership(job.orgId, userId);

        return {
            id: job.id,
            status: job.status,
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            metrics: job.metrics,
        };
    }

    async getResult(jobId: string, userId: string) {
        const job = await this.prisma.simulationJob.findUnique({
            where: { id: jobId },
        });

        if (!job) {
            throw new NotFoundException('Simulation job not found');
        }

        await this.orgsService.checkMembership(job.orgId, userId);

        if (job.status !== 'SUCCEEDED') {
            return {
                id: job.id,
                status: job.status,
                error: job.stderr,
            };
        }

        // Large results (>1MB) are spilled to S3 by the worker, which leaves resultJson
        // null and sets resultS3Key. Hydrate from S3 so the response always carries the
        // full SimulationResult ({ meta, series }) — matching small, DB-stored results.
        let result: unknown = job.resultJson ?? null;
        if (result === null && job.resultS3Key) {
            result = await this.fetchResultFromS3(job.resultS3Key);
        }

        return {
            id: job.id,
            status: job.status,
            result,
            metrics: job.metrics,
            // A SUCCEEDED job should always carry a result; a null here means the payload was
            // spilled to S3 and could not be fetched/parsed. Surface it so clients can tell
            // "temporarily unavailable" apart from a genuinely empty dataset.
            ...(result === null ? { error: 'Result data is currently unavailable from storage.' } : {}),
        };
    }

    /**
     * Fetch a simulation result the worker spilled to S3 (key: results/{jobId}/result.json).
     * Returns the parsed SimulationResult ({ meta, series }), or null if it cannot be
     * fetched/parsed — callers already treat a null result as "data unavailable".
     */
    private async fetchResultFromS3(key: string): Promise<unknown | null> {
        try {
            const response = await this.s3.send(
                new GetObjectCommand({ Bucket: this.bucket, Key: key }),
            );
            const body = await response.Body?.transformToString();
            return body ? JSON.parse(body) : null;
        } catch (err) {
            // The job succeeded and the worker wrote a result to S3, so a failure here
            // (missing/corrupt object, connectivity) is a real problem — log it instead of
            // silently returning null, which is indistinguishable from "no data" downstream.
            this.logger.error(
                `Failed to fetch/parse S3 result at key "${key}": ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return null;
        }
    }
}