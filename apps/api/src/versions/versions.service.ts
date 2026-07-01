/**
 * Versions Service
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { paginated, type Paginated } from '../common/dto/pagination.dto';

@Injectable()
export class VersionsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly projectsService: ProjectsService,
    ) { }

    async findAllForProject(projectId: string, userId: string, page: { limit: number; offset: number }): Promise<Paginated<unknown>> {
        await this.projectsService.findOne(projectId, userId);
        const where = { projectId };
        const [items, total] = await Promise.all([
            this.prisma.projectVersion.findMany({
                where,
                orderBy: { versionNumber: 'desc' },
                select: { id: true, versionNumber: true, createdAt: true, createdByUserId: true },
                skip: page.offset,
                take: page.limit,
            }),
            this.prisma.projectVersion.count({ where }),
        ]);
        return paginated(items, total, page.limit, page.offset);
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