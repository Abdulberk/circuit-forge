/**
 * Versions Service
 */
import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { paginated, type Paginated } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';

@Injectable()
export class VersionsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly projectsService: ProjectsService,
    ) {}

    async findAllForProject(
        projectId: string,
        userId: string,
        page: { limit: number; offset: number },
    ): Promise<Paginated<unknown>> {
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

        // Allocate the next versionNumber + insert ATOMICALLY. The old read-MAX-then-create was a race: two
        // concurrent saves for the same project both read the same MAX, both computed the same +1, and collided
        // on @@unique([projectId, versionNumber]) — one 500'd and that save was lost. We serialize per-project
        // with a transaction-scoped Postgres advisory lock (the same pattern UsageService uses): concurrent
        // saves for one project queue on the lock and each reads a fresh MAX, so numbers stay gapless + unique.
        // Different projects hash to different keys and never contend. The lock auto-releases at COMMIT/ROLLBACK.
        try {
            const lockKey = `projectversion:${projectId}`;
            return await this.prisma.$transaction(async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
                const lastVersion = await tx.projectVersion.findFirst({
                    where: { projectId },
                    orderBy: { versionNumber: 'desc' },
                    select: { versionNumber: true },
                });
                const versionNumber = (lastVersion?.versionNumber ?? 0) + 1;
                return tx.projectVersion.create({
                    data: {
                        projectId,
                        versionNumber,
                        circuitJson: circuitJson as Prisma.InputJsonValue,
                        uiJson: uiJson as Prisma.InputJsonValue,
                        createdByUserId: userId,
                    },
                });
            });
        } catch (e) {
            // Defense in depth: if a duplicate versionNumber ever slips past the lock, surface a retryable 409
            // (a client can just re-save) instead of a raw 500. The advisory lock makes this path unreachable
            // in practice, but a unique-violation must never read as an internal error.
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
                throw new ConflictException('A concurrent save took this version number; please retry.');
            }
            throw e;
        }
    }
}
