/**
 * Projects Service
 */
import { Injectable, NotFoundException } from '@nestjs/common';

import { paginated, type Paginated } from '../common/dto/pagination.dto';
import { OrgsService } from '../orgs/orgs.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProjectsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly orgsService: OrgsService,
    ) {}

    async findAllForOrg(
        orgId: string,
        userId: string,
        page: { limit: number; offset: number },
    ): Promise<Paginated<unknown>> {
        await this.orgsService.checkMembership(orgId, userId);
        const where = { orgId };
        const [items, total] = await Promise.all([
            // id is the unique tie-breaker → a TOTAL order, so offset/limit paging can't skip/duplicate rows
            // when several projects share an updatedAt (batch touch / same-ms collision).
            this.prisma.project.findMany({
                where,
                orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
                skip: page.offset,
                take: page.limit,
            }),
            this.prisma.project.count({ where }),
        ]);
        return paginated(items, total, page.limit, page.offset);
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
