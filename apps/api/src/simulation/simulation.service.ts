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
import { UsageService } from '../usage/usage.service';
import { generateNetlist, safeValidateCircuitJson, safeValidateAnalysisConfig, downsampleResult } from '@circuit-forge/eda-core';
import type { CircuitJson, AnalysisConfig, SimulationResult, AcceptanceCriterion, CornerSpec } from '@circuit-forge/eda-core';
import { propagation, context as otelContext } from '@opentelemetry/api';

/** Capture the current trace context as a W3C carrier to ride on the queued job, so the worker's
 *  processing span links back to this API request (one end-to-end trace). Empty when telemetry is off. */
function otelCarrier(): Record<string, string> {
    const carrier: Record<string, string> = {};
    propagation.inject(otelContext.active(), carrier);
    return carrier;
}

/** Max uploaded model files attachable to one simulation (each is a separate S3 download in the worker). */
const MAX_MODEL_ASSETS = 32;
/** Filenames the worker uses for its own job artifacts — an uploaded model must never shadow them. */
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
        private usageService: UsageService,
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
        const orgId = version.project.orgId;

        // Validate the analysis config + the stored circuit BEFORE netlisting. generateNetlist assumes a
        // schema-valid CircuitJson and will throw a raw TypeError on a malformed one (e.g. a legacy
        // pins-as-object shape, a missing designator) — which would surface as an opaque 500. Fail loud
        // with a 400 naming the problem instead, both for a bad request and a stale stored version.
        const validAnalysis = safeValidateAnalysisConfig(analysisConfig);
        if (!validAnalysis.success) {
            const issues = validAnalysis.error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ');
            throw new BadRequestException(`Invalid analysis config: ${issues}`);
        }
        const validCircuit = safeValidateCircuitJson(version.circuitJson);
        if (!validCircuit.success) {
            const issues = validCircuit.error.errors.slice(0, 5).map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ');
            throw new BadRequestException(`Version ${versionId} has an invalid circuit: ${issues}`);
        }
        const circuitJson = validCircuit.data as CircuitJson;
        const analysis = validAnalysis.data as AnalysisConfig;

        // Resolve any user-uploaded SPICE model assets (scoped to this version's org) into S3 keys (for
        // the worker to download) + filenames (to `.include` in the generated netlist).
        const { s3Keys, includeFiles } = await this.resolveModelAssets(orgId, modelAssetIds);

        // Generate the netlist. The inputs are schema-valid above, but guard the generation itself too —
        // a model-body conflict / unknown-type / unsupported-probe is reported as a clean 400, never a 500.
        let netlist: string;
        try {
            netlist = generateNetlist(circuitJson, analysis, { probes, includeFiles });
        } catch (e) {
            throw new BadRequestException(`Netlist generation failed: ${e instanceof Error ? e.message : String(e)}`);
        }

        // Create the job under the sim-quota guard: when QUOTA_SIM_* is configured, the quota is
        // re-checked under a per-org advisory lock so concurrent enqueues can't race past the cap;
        // when unset, this is a plain create (no lock/transaction overhead). 429 thrown before insert.
        const job = await this.usageService.createSimGuarded(orgId, (tx) =>
            tx.simulationJob.create({
                data: {
                    orgId,
                    projectVersionId: versionId,
                    status: 'QUEUED',
                    engine: 'NGSPICE',
                    analysisConfig: analysisConfig as Prisma.InputJsonValue,
                    netlist,
                },
            }),
        );

        // Add to queue
        const analysisType = (analysisConfig as { type?: string }).type || 'tran';
        await this.simulationQueue.add('simulation', {
            jobId: job.id,
            orgId,
            netlist,
            probeNames: probes || [],
            analysisType,
            analysisConfig,
            otel: otelCarrier(),
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

        // Create the job under the sim-quota guard (advisory-locked re-check when a quota is set;
        // plain create otherwise) so concurrent quick sims can't race past the cap.
        const job = await this.usageService.createSimGuarded(orgId, (tx) =>
            tx.simulationJob.create({
                data: {
                    orgId,
                    status: 'QUEUED',
                    engine: 'NGSPICE',
                    analysisConfig: (analysisConfig || {}) as Prisma.InputJsonValue,
                    netlist,
                },
            }),
        );

        // Add to queue
        const analysisType = (analysisConfig as { type?: string } | undefined)?.type || 'tran';
        await this.simulationQueue.add('simulation', {
            jobId: job.id,
            orgId,
            netlist,
            probeNames: [],
            analysisType,
            analysisConfig: analysisConfig || {},
            otel: otelCarrier(),
            ...(s3Keys.length > 0 ? { modelAssets: s3Keys } : {}),
        });

        return { jobId: job.id };
    }

    /**
     * Enqueue a Monte-Carlo YIELD job: the worker runs N perturbed variants of `circuit` (each component's
     * `tolerance` sampled) and aggregates how many meet `criteria` → a yield + Wilson CI. ONE queue job (not
     * N) — so it counts as a single sim against the quota, not 300. Informational: the design loop attaches
     * the result as a non-authoritative field and never lets it flip "verified". Reuses the same 'simulation'
     * queue with a `mode` discriminator (a dedicated low-priority queue is the scale-time upgrade).
     */
    async createMonteCarloJob(
        circuit: CircuitJson,
        analysisConfig: Record<string, unknown> | undefined,
        criteria: AcceptanceCriterion[],
        opts: { n?: number; seed?: number },
        userId: string,
    ) {
        const orgs = await this.orgsService.findAllForUser(userId);
        const orgId = orgs[0]?.id;
        if (!orgId) throw new NotFoundException('No organization found for user');

        const validCircuit = safeValidateCircuitJson(circuit);
        if (!validCircuit.success) {
            const issues = validCircuit.error.errors.slice(0, 5).map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ');
            throw new BadRequestException(`Invalid circuit for Monte-Carlo: ${issues}`);
        }
        const validAnalysis = safeValidateAnalysisConfig(analysisConfig);
        if (!validAnalysis.success) {
            const issues = validAnalysis.error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ');
            throw new BadRequestException(`Invalid analysis config for Monte-Carlo: ${issues}`);
        }

        // ONE job under the quota guard (the whole batch = 1 unit, not N).
        const job = await this.usageService.createSimGuarded(orgId, (tx) =>
            tx.simulationJob.create({
                data: {
                    orgId,
                    status: 'QUEUED',
                    engine: 'NGSPICE',
                    analysisConfig: (analysisConfig || {}) as Prisma.InputJsonValue,
                    // The MC worker path regenerates a netlist PER VARIANT from montecarlo.circuit (carried on
                    // the queue payload), so the row's single netlist is unused — store empty (column is required).
                    netlist: '',
                },
            }),
        );

        await this.simulationQueue.add('simulation', {
            jobId: job.id,
            orgId,
            mode: 'monte-carlo',
            netlist: '', // the worker regenerates a netlist per variant from `montecarlo.circuit`
            probeNames: [],
            analysisType: (analysisConfig as { type?: string } | undefined)?.type || 'op',
            analysisConfig: analysisConfig || {},
            montecarlo: {
                circuit: validCircuit.data as CircuitJson,
                analysis: validAnalysis.data as AnalysisConfig,
                criteria,
                ...(opts.n ? { n: opts.n } : {}),
                ...(opts.seed ? { seed: opts.seed } : {}),
            },
            otel: otelCarrier(),
        });

        return { jobId: job.id };
    }

    /**
     * Enqueue a WORST-CASE (corner) job: the worker evaluates `criteria` at the 2^k deterministic ±tolerance
     * corners of the circuit's toleranced components and persists the result in metrics.worstCase (see the
     * worker's handleCorner). One job = one quota unit (the whole batch), mirroring createMonteCarloJob.
     */
    async createCornerJob(
        circuit: CircuitJson,
        analysisConfig: Record<string, unknown> | undefined,
        criteria: AcceptanceCriterion[],
        spec: CornerSpec,
        userId: string,
    ) {
        const orgs = await this.orgsService.findAllForUser(userId);
        const orgId = orgs[0]?.id;
        if (!orgId) throw new NotFoundException('No organization found for user');

        const validCircuit = safeValidateCircuitJson(circuit);
        if (!validCircuit.success) {
            const issues = validCircuit.error.errors.slice(0, 5).map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ');
            throw new BadRequestException(`Invalid circuit for worst-case: ${issues}`);
        }
        const validAnalysis = safeValidateAnalysisConfig(analysisConfig);
        if (!validAnalysis.success) {
            const issues = validAnalysis.error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ');
            throw new BadRequestException(`Invalid analysis config for worst-case: ${issues}`);
        }

        const job = await this.usageService.createSimGuarded(orgId, (tx) =>
            tx.simulationJob.create({
                data: {
                    orgId,
                    status: 'QUEUED',
                    engine: 'NGSPICE',
                    analysisConfig: (analysisConfig || {}) as Prisma.InputJsonValue,
                    netlist: '', // the worker regenerates a netlist per corner from corner.circuit
                },
            }),
        );

        await this.simulationQueue.add('simulation', {
            jobId: job.id,
            orgId,
            mode: 'corner',
            netlist: '',
            probeNames: [],
            analysisType: (analysisConfig as { type?: string } | undefined)?.type || 'op',
            analysisConfig: analysisConfig || {},
            corner: {
                circuit: validCircuit.data as CircuitJson,
                analysis: validAnalysis.data as AnalysisConfig,
                criteria,
                spec,
            },
            otel: otelCarrier(),
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
        // Bound the fan-out (defense-in-depth; the DTO also caps via @ArrayMaxSize): each asset is a
        // separate S3 download in the worker, and the service must not trust a direct caller.
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
        // Select only the light status fields — NEVER the heavy netlist/resultJson/stdout/stderr
        // columns. This is polled every ~1s for up to 90s per AI design round, so pulling the full
        // row (incl. the up-to-1MB resultJson) would move tens of MB per design request for nothing.
        const job = await this.prisma.simulationJob.findUnique({
            where: { id: jobId },
            select: { id: true, orgId: true, status: true, createdAt: true, startedAt: true, finishedAt: true, metrics: true },
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

    async getResult(jobId: string, userId: string, maxPoints?: number) {
        // First pull only the light fields needed to authorize + branch. The heavy resultJson (up to
        // 1MB) is fetched in a SECOND query only when the job actually SUCCEEDED and wasn't spilled to
        // S3 — so the non-success path (and the S3 path) never touches that column.
        const job = await this.prisma.simulationJob.findUnique({
            where: { id: jobId },
            select: { id: true, orgId: true, status: true, stderr: true, resultS3Key: true, metrics: true },
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

        // Large results are spilled to S3 by the worker (resultJson null, resultS3Key set); small ones
        // live in resultJson. Fetch whichever applies — the DB column only via a targeted second read.
        let result: unknown = null;
        if (job.resultS3Key) {
            result = await this.fetchResultFromS3(job.resultS3Key);
        } else {
            const row = await this.prisma.simulationJob.findUnique({ where: { id: jobId }, select: { resultJson: true } });
            result = row?.resultJson ?? null;
        }

        // Optional display decimation (?maxPoints): min-max bucketing keeps peaks/glitches, so a
        // 100k-point transient renders fast without hiding exactly the artifacts an engineer looks
        // for. The worker already caps stored series (WORKER_MAX_POINTS), so re-downsampling here is a
        // second reduction — preserve the TRUE original count (the worker's meta.downsampledFrom, else
        // the stored pointsCount) so meta.downsampledFrom doesn't degrade to the intermediate cap.
        if (
            maxPoints !== undefined &&
            result !== null &&
            typeof result === 'object' &&
            Array.isArray((result as { series?: unknown }).series)
        ) {
            const before = (result as SimulationResult).meta;
            const trueOriginal = before.downsampledFrom ?? before.pointsCount;
            const reduced = downsampleResult(result as SimulationResult, maxPoints);
            if (reduced.meta.downsampledFrom !== undefined) reduced.meta.downsampledFrom = trueOriginal;
            result = reduced;
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