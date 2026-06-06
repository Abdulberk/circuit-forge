/**
 * Simulation Service
 */
import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { PrismaService } from '../prisma/prisma.service';
import { VersionsService } from '../versions/versions.service';
import { OrgsService } from '../orgs/orgs.service';
import { generateNetlist } from '@circuit-forge/eda-core';
import type { CircuitJson, AnalysisConfig } from '@circuit-forge/eda-core';

/** Max uploaded model files attachable to one simulation (each is a separate S3 download in the worker). */
const MAX_MODEL_ASSETS = 32;
/** Filenames the worker uses for its own job artifacts — an uploaded model must never shadow them. */
const RESERVED_JOB_FILES = new Set(['circuit.cir', 'output.csv', 'stdout.log']);

/** Filenames the worker writes into the per-job dir (netlist + ngspice outputs) — a model asset must
 * not use one of these names or it would clobber a job file. See worker-sim runner.ts. */
const RESERVED_JOB_FILES = new Set(['circuit.cir', 'output.csv', 'stdout.log']);

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
        modelAssetIds?: string[],
    ) {
        const version = await this.versionsService.findOne(versionId, userId);
        const circuitJson = version.circuitJson as unknown as CircuitJson;

        // Resolve any user-uploaded SPICE model assets (scoped to this version's org) into S3 keys (for
        // the worker to download) + filenames (to `.include` in the generated netlist).
        const { s3Keys, includeFiles } = await this.resolveModelAssets(version.project.orgId, modelAssetIds);

        // Generate netlist - cast to AnalysisConfig for eda-core
        const netlist = generateNetlist(circuitJson, analysisConfig as unknown as AnalysisConfig, {
            probes,
            includeFiles,
        });

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
            ...(s3Keys.length > 0 ? { modelAssets: s3Keys } : {}),
        });

        return { jobId: job.id };
    }

    async createQuickSim(
        netlist: string,
        analysisConfig: Record<string, unknown> | undefined,
        userId: string,
        modelAssetIds?: string[],
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

        // The caller supplies the raw netlist (it must already `.include` each model by filename); we
        // only resolve the assets to S3 keys so the worker downloads the files into the job dir.
        const { s3Keys } = await this.resolveModelAssets(orgId, modelAssetIds);

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
            ...(s3Keys.length > 0 ? { modelAssets: s3Keys } : {}),
        });

        return { jobId: job.id };
    }

    /**
     * Resolve uploaded SPICE-model asset IDs into the worker's `modelAssets` (S3 keys it downloads) and
     * the netlist `includeFiles` (the filenames the worker writes into the job dir, referenced by
     * `.include`). Security-critical:
     *  - assets are scoped to `orgId` (a user can't pull another org's model into their sim);
     *  - every requested id MUST resolve in this org (else reject — no silent drop / cross-org leak);
     *  - the filename must be sandbox-safe (no path traversal / separators) before it enters a netlist;
     *  - two assets can't share a filename (the worker writes by basename — a collision would clobber).
     */
    private async resolveModelAssets(
        orgId: string,
        assetIds: string[] | undefined,
    ): Promise<{ s3Keys: string[]; includeFiles: string[] }> {
        const ids = Array.from(new Set((assetIds ?? []).filter((x) => typeof x === 'string' && x.length > 0)));
        if (ids.length === 0) return { s3Keys: [], includeFiles: [] };
        // Defense-in-depth cap (the DTO also bounds this via @ArrayMaxSize, but the service must not
        // trust a direct caller): too many assets => too many worker S3 downloads.
        if (ids.length > 32) {
            throw new BadRequestException('Too many model assets attached (max 32).');
        }
        // Bound the fan-out: each asset is a separate S3 download in the worker.
        if (ids.length > MAX_MODEL_ASSETS) {
            throw new BadRequestException(`Too many model assets requested (max ${MAX_MODEL_ASSETS}).`);
        }

        const assets = await this.prisma.asset.findMany({
            where: { id: { in: ids }, orgId, type: 'SPICE_MODEL' },
        });
        if (assets.length !== ids.length) {
            throw new BadRequestException(
                'One or more model assets were not found as SPICE models in this organization.',
            );
        }

        const s3Keys: string[] = [];
        const includeFiles: string[] = [];
        const seen = new Set<string>();
        for (const a of assets) {
            const filename = a.s3Key.split('/').pop() ?? '';
            // Must be a bare, sandbox-safe filename — it is written into the job dir and `.include`d.
            if (!/^[A-Za-z0-9_.\-]+$/.test(filename) || filename.includes('..')) {
                throw new BadRequestException(`Model asset has an unsafe filename: "${filename}"`);
            }
            // The worker writes model files into the same job dir as (and AFTER) the netlist + outputs;
            // a model named like a job file would clobber it. Reserve those names.
            if (RESERVED_JOB_FILES.has(filename.toLowerCase())) {
                throw new BadRequestException(`Model filename "${filename}" is reserved by the simulator; rename the asset.`);
            }
            // Never let an uploaded file clobber the worker's own job files (the runner writes the
            // netlist FIRST, then model files — a model named circuit.cir would overwrite the netlist).
            if (RESERVED_JOB_FILES.has(filename.toLowerCase())) {
                throw new BadRequestException(
                    `Model filename "${filename}" is reserved by the simulator; rename the asset before simulating.`,
                );
            }
            if (seen.has(filename)) {
                throw new BadRequestException(
                    `Two model assets resolve to the same filename "${filename}"; rename one before simulating.`,
                );
            }
            seen.add(filename);
            s3Keys.push(a.s3Key);
            includeFiles.push(filename);
        }
        return { s3Keys, includeFiles };
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