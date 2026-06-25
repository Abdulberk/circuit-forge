/**
 * Async design-job lifecycle (the long-running-operation handle behind /design-jobs).
 *
 * /design-circuit runs the agentic loop synchronously and can block for minutes — an anti-pattern at
 * scale (held connections, gateway timeouts, no cancel). This service backs the async alternative: a
 * persisted DesignJob row the client polls. create() ENQUEUES the job onto the durable 'design' queue,
 * where a dedicated worker runs the loop and writes the outcome back onto the row (an API deploy/crash no
 * longer abandons in-flight work). This service owns only the row lifecycle + the cancel signal; it does
 * NOT run the loop.
 */
import { Injectable, NotFoundException, ServiceUnavailableException, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { type DesignJobStatus } from '@prisma/client';
import { propagation, context as otelContext } from '@opentelemetry/api';
import { PrismaService } from '../prisma/prisma.service';
import { OrgsService } from '../orgs/orgs.service';
import { UsageService } from '../usage/usage.service';

export interface DesignJobInput {
    prompt: string;
    constraints?: string;
    maxRounds: number;
}

/** Capture the current trace context as a W3C carrier so the design worker's span links to this request. */
function otelCarrier(): Record<string, string> {
    const carrier: Record<string, string> = {};
    propagation.inject(otelContext.active(), carrier);
    return carrier;
}

@Injectable()
export class DesignJobService {
    private readonly logger = new Logger(DesignJobService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrgsService,
        private readonly usage: UsageService,
        @InjectQueue('design') private readonly designQueue: Queue,
    ) {}

    /**
     * Create a QUEUED design job under the user's (first) org and ENQUEUE it onto the durable 'design'
     * queue, where a dedicated worker runs the agentic loop (replacing the old in-process detached runner).
     *
     * Admission control: the whole DESIGN JOB is the billable unit (gated once here), NOT the per-round sims
     * — those now run locally in the worker and never touch the sim-quota counter. createDesignGuarded is a
     * plain insert until a QUOTA_DESIGN_* limit is configured (then an advisory-locked re-check).
     *
     * The insert and the BullMQ add are two stores, so a crash strictly between them could orphan a QUEUED
     * row (a boot-time reaper — deferred — sweeps that rare case). What we CAN close synchronously: if the
     * add itself fails, flip the row to FAILED so the client polls a terminal status instead of hanging.
     */
    async create(userId: string, input: DesignJobInput): Promise<{ id: string; status: DesignJobStatus }> {
        const orgList = await this.orgs.findAllForUser(userId);
        const orgId = orgList[0]?.id;
        if (!orgId) throw new NotFoundException('No organization found for user');

        const job = await this.usage.createDesignGuarded(orgId, (tx) =>
            tx.designJob.create({
                data: {
                    orgId,
                    userId,
                    status: 'QUEUED',
                    prompt: input.prompt,
                    constraints: input.constraints,
                    maxRounds: input.maxRounds,
                },
                select: { id: true, status: true },
            }),
        );

        try {
            await this.designQueue.add(
                'design',
                {
                    jobId: job.id,
                    userId,
                    prompt: input.prompt,
                    constraints: input.constraints,
                    maxRounds: input.maxRounds,
                    otel: otelCarrier(),
                },
                // Use the DesignJob row id AS the BullMQ job id. Two payoffs: (1) the orphan reaper can look the
                // queue job up by row id (queue.getJob(row.id)) to tell a real orphan from a job still waiting;
                // (2) idempotency — a duplicate enqueue of the same row can't create a second queue job.
                { jobId: job.id },
            );
        } catch (err) {
            this.logger.error(`design job ${job.id} could not be enqueued: ${err instanceof Error ? err.message : String(err)}`);
            // CONDITIONAL flip — only fail the row if it is STILL QUEUED. queue.add is a Redis write whose
            // reply can be lost AFTER the job was durably stored (connection reset / socket timeout), so the
            // SEPARATE design worker may have already dequeued it and advanced it to RUNNING/SUCCEEDED. An
            // unconditional update would clobber that real work with FAILED; `updateMany` gated on
            // status:'QUEUED' touches 0 rows in that case, leaving the worker's outcome intact. (The worker
            // mirrors this with an atomic QUEUED→RUNNING claim — see design/processor.ts.)
            await this.prisma.designJob
                .updateMany({
                    where: { id: job.id, status: 'QUEUED' },
                    data: { status: 'FAILED', errorMessage: 'Could not queue the design job; please retry.', finishedAt: new Date() },
                })
                .catch(() => undefined);
            throw new ServiceUnavailableException('Could not start the design job; please retry.');
        }

        return job;
    }

    /** Status + result, org-membership-checked (any member of the owning org can read it, like sim jobs). */
    async getForUser(jobId: string, userId: string) {
        const job = await this.prisma.designJob.findUnique({
            where: { id: jobId },
            select: {
                id: true,
                orgId: true,
                status: true,
                result: true,
                errorMessage: true,
                createdAt: true,
                startedAt: true,
                finishedAt: true,
            },
        });
        if (!job) throw new NotFoundException('Design job not found');
        await this.orgs.checkMembership(job.orgId, userId);
        return {
            id: job.id,
            status: job.status,
            result: job.result ?? undefined,
            ...(job.errorMessage ? { error: job.errorMessage } : {}),
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
        };
    }

    /**
     * Cooperative cancel. QUEUED → CANCELED immediately (it hasn't started; the worker's QUEUED→RUNNING
     * claim will then find it unclaimable and skip). RUNNING → set the abortRequested flag; the design
     * worker honors it mid-loop (checked at each round start + before each paid LLM call) + post-loop.
     * Terminal → no-op.
     */
    async requestCancel(jobId: string, userId: string): Promise<{ id: string; status: DesignJobStatus }> {
        const job = await this.prisma.designJob.findUnique({
            where: { id: jobId },
            select: { id: true, orgId: true, status: true },
        });
        if (!job) throw new NotFoundException('Design job not found');
        await this.orgs.checkMembership(job.orgId, userId);

        if (job.status === 'QUEUED') {
            await this.prisma.designJob.update({
                where: { id: jobId },
                data: { status: 'CANCELED', abortRequested: true, finishedAt: new Date() },
            });
            return { id: jobId, status: 'CANCELED' };
        }
        if (job.status === 'RUNNING') {
            await this.prisma.designJob.update({ where: { id: jobId }, data: { abortRequested: true } });
            return { id: jobId, status: 'RUNNING' };
        }
        return { id: jobId, status: job.status }; // already terminal
    }
}
