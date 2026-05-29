/**
 * Simulation Service
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { VersionsService } from '../versions/versions.service';
import { OrgsService } from '../orgs/orgs.service';
import { generateNetlist } from '@circuitforge/eda-core';
import type { CircuitJson, AnalysisConfig } from '@circuitforge/eda-core';

@Injectable()
export class SimulationService {
    constructor(
        private prisma: PrismaService,
        private versionsService: VersionsService,
        private orgsService: OrgsService,
        @InjectQueue('simulations') private simulationQueue: Queue,
    ) { }

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

        // If result is in S3, we would fetch it here
        // For now, return from DB
        return {
            id: job.id,
            status: job.status,
            result: job.resultJson,
            metrics: job.metrics,
        };
    }
}