/**
 * Projects Service
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrgsService } from '../orgs/orgs.service';

@Injectable()
export class ProjectsService {
    constructor(
        private prisma: PrismaService,
        private orgsService: OrgsService,
    ) { }

    async findAllForOrg(orgId: string, userId: string) {
        await this.orgsService.checkMembership(orgId, userId);
        return this.prisma.project.findMany({
            where: { orgId },
            orderBy: { updatedAt: 'desc' },
        });
    }

    async findOne(projectId: string, userId: string) {
        const project = await this.prisma.project.findUnique({
            where: { id: projectId },
            include: { org: true },
        });

        if (!project) {
            throw new NotFoundException('Project not found');
        }

        await this.orgsService.checkMembership(project.orgId, userId);
        return project;
    }

    async create(orgId: string, name: string, description: string | undefined, userId: string) {
        await this.orgsService.checkMembership(orgId, userId);
        return this.prisma.project.create({
            data: {
                orgId,
                name,
                description,
            },
        });
    }

    async update(projectId: string, name: string | undefined, description: string | undefined, userId: string) {
        const project = await this.findOne(projectId, userId);
        return this.prisma.project.update({
            where: { id: project.id },
            data: {
                ...(name && { name }),
                ...(description !== undefined && { description }),
            },
        });
    }

    async delete(projectId: string, userId: string) {
        const project = await this.findOne(projectId, userId);
        await this.orgsService.checkMembership(project.orgId, userId, ['OWNER', 'ADMIN']);
        await this.prisma.project.delete({ where: { id: project.id } });
    }
}