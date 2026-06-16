/**
 * Async design-job lifecycle (the long-running-operation handle behind /design-jobs).
 *
 * /design-circuit runs the agentic loop synchronously and can block for minutes — an anti-pattern at
 * scale (held connections, gateway timeouts, no cancel). This service backs the async alternative: a
 * persisted DesignJob row the client polls. The loop currently runs DETACHED in the API process (Slice
 * 1); the contract (202 + poll + cancel) is identical to where it will run later (a dedicated design
 * queue + worker), so relocating execution needs no second contract change.
 */
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { Prisma, type DesignJobStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrgsService } from '../orgs/orgs.service';
import { DesignService } from './design.service';

export interface DesignJobInput {
    prompt: string;
    constraints?: string;
    maxRounds: number;
}

@Injectable()
export class DesignJobService {
    private readonly logger = new Logger(DesignJobService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly orgs: OrgsService,
        private readonly design: DesignService,
    ) {}

    /** Create a QUEUED job under the user's (first) org — mirrors SimulationService.createQuickSim's scoping. */
    async create(userId: string, input: DesignJobInput): Promise<{ id: string; status: DesignJobStatus }> {
        const orgList = await this.orgs.findAllForUser(userId);
        const orgId = orgList[0]?.id;
        if (!orgId) throw new NotFoundException('No organization found for user');
        const job = await this.prisma.designJob.create({
            data: {
                orgId,
                userId,
                status: 'QUEUED',
                prompt: input.prompt,
                constraints: input.constraints,
                maxRounds: input.maxRounds,
            },
            select: { id: true, status: true },
        });
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
     * Cooperative cancel. QUEUED → CANCELED immediately (it hasn't started). RUNNING → set the
     * abortRequested flag; the detached runner stops at its next checkpoint (Slice 1 checks it before
     * start + after the loop; mid-loop honoring lands when the loop core is relocated). Terminal → no-op.
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

    /** Whether a cancel was requested for this job (the cooperative-abort checkpoint). */
    private async isAbortRequested(jobId: string): Promise<boolean> {
        const j = await this.prisma.designJob.findUnique({
            where: { id: jobId },
            select: { abortRequested: true },
        });
        return !!j?.abortRequested;
    }

    /**
     * Run the agentic design loop for a QUEUED job and persist its outcome. Fire-and-forget: the caller
     * `void`s this after returning 202. Never throws — every failure is captured onto the row so a poll
     * always sees a terminal status. Honors a cancel requested before the loop starts or after it ends.
     */
    async runDetached(jobId: string, input: DesignJobInput, userId: string): Promise<void> {
        try {
            if (await this.isAbortRequested(jobId)) {
                await this.prisma.designJob.update({
                    where: { id: jobId },
                    data: { status: 'CANCELED', finishedAt: new Date() },
                });
                return;
            }
            await this.prisma.designJob.update({
                where: { id: jobId },
                data: { status: 'RUNNING', startedAt: new Date() },
            });

            const result = await this.design.design(
                { prompt: input.prompt, constraints: input.constraints, maxRounds: input.maxRounds },
                userId,
            );

            // A cancel that arrived mid-run wins over the (now-unwanted) result.
            if (await this.isAbortRequested(jobId)) {
                await this.prisma.designJob.update({
                    where: { id: jobId },
                    data: { status: 'CANCELED', finishedAt: new Date() },
                });
                return;
            }
            await this.prisma.designJob.update({
                where: { id: jobId },
                data: { status: 'SUCCEEDED', result: result as unknown as Prisma.InputJsonValue, finishedAt: new Date() },
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error(`design job ${jobId} failed: ${message}`);
            await this.prisma.designJob
                .update({
                    where: { id: jobId },
                    data: { status: 'FAILED', errorMessage: message, finishedAt: new Date() },
                })
                .catch((e) => this.logger.error(`design job ${jobId} could not persist failure: ${String(e)}`));
        }
    }
}
