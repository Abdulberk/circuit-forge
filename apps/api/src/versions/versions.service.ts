/**
 * Versions Service
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';

@Injectable()
export class VersionsService {
    constructor(
        private prisma: PrismaService,
        private projectsService: ProjectsService,
    ) { }

    async findAllForProject(projectId: string, userId: string) {
        await this.projectsService.findOne(projectId, userId);
        return this.prisma.projectVersion.findMany({
            where: { projectId },
            orderBy: { versionNumber: 'desc' },
            select: {
                id: true,
                versionNumber: true,
                createdAt: true,
                createdByUserId: true,
            },
        });
    }

    async findOne(versionId: string, userId: string) {
        const version = await this.prisma.projectVersion.findUnique({
            where: { id: versionId },
            include: { project: true },
        });

        if (!version) {
            throw new NotFoundException('Version not found');
        }

        await this.projectsService.findOne(version.projectId, userId);
        return version;
    }

    async create(
        projectId: string,
        circuitJson: Record<string, unknown>,
        uiJson: Record<string, unknown>,
        userId: string,
    ) {
        await this.projectsService.findOne(projectId, userId);

        // Get next version number
        const lastVersion = await this.prisma.projectVersion.findFirst({
            where: { projectId },
            orderBy: { versionNumber: 'desc' },
        });

        const versionNumber = (lastVersion?.versionNumber || 0) + 1;

        return this.prisma.projectVersion.create({
            data: {
                projectId,
                versionNumber,
                circuitJson: circuitJson as Prisma.InputJsonValue,
                uiJson: uiJson as Prisma.InputJsonValue,
                createdByUserId: userId,
            },
        });
    }
}