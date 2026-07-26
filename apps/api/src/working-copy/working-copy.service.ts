/**
 * Project working-copy service — the mutable "current draft" half of continuous autosave. The editor
 * PUTs the live circuit here (debounced) and it OVERWRITES one row per project (last-writer-wins). "Save
 * version" is a separate, immutable snapshot (VersionsService.create). This service owns only the draft:
 * a single-row upsert on save, a single-row read on load. No history, no growth — the row is reused.
 */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';

import { SaveWorkingCopyDto } from './dto';

@Injectable()
export class WorkingCopyService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly projectsService: ProjectsService,
    ) {}

    /**
     * Upsert the project's single working copy. Authz first (findOne throws 404/403), then — if a
     * baseVersionId is given — verify it is a version OF THIS project (a draft can't point at another
     * project's version). Idempotent: create on first save, overwrite thereafter.
     */
    async save(projectId: string, dto: SaveWorkingCopyDto, userId: string) {
        await this.projectsService.findOne(projectId, userId);

        if (dto.baseVersionId) {
            const base = await this.prisma.projectVersion.findUnique({
                where: { id: dto.baseVersionId },
                select: { projectId: true },
            });
            if (!base || base.projectId !== projectId) {
                throw new BadRequestException('baseVersionId does not belong to this project');
            }
        }

        const content = {
            circuitJson: dto.circuitJson as Prisma.InputJsonValue,
            uiJson: dto.uiJson as Prisma.InputJsonValue,
            updatedByUserId: userId,
        };
        // Provenance is STICKY: it's set once when the editor opens/branches from a version and must survive
        // circuit-only keystroke autosaves that omit it (else the "N unsaved changes since vX" indicator
        // resets to nothing). So on UPDATE we only touch baseVersionId when the client actually sends one;
        // an omitted field means "leave the base unchanged". On CREATE there's nothing to keep, so default null.
        return this.prisma.projectWorkingCopy.upsert({
            where: { projectId },
            create: { projectId, ...content, baseVersionId: dto.baseVersionId ?? null },
            update: { ...content, ...(dto.baseVersionId === undefined ? {} : { baseVersionId: dto.baseVersionId }) },
            // The client already holds the circuit/UI it just uploaded — echoing the blobs back on the app's
            // highest-frequency write wastes bandwidth and defeats this table's keep-blobs-out-of-hot-paths
            // rationale. Return only the server-owned fields the client reconciles. GET returns the full row.
            select: { projectId: true, baseVersionId: true, updatedByUserId: true, updatedAt: true },
        });
    }

    /** Load the project's working copy. 404 when none exists yet — the client then opens the latest version. */
    async get(projectId: string, userId: string) {
        await this.projectsService.findOne(projectId, userId);
        const wc = await this.prisma.projectWorkingCopy.findUnique({ where: { projectId } });
        if (!wc) throw new NotFoundException('No working copy for this project');
        return wc;
    }

    /** Discard the draft (e.g. "revert to last saved"). Idempotent — no error if there is nothing to drop. */
    async discard(projectId: string, userId: string) {
        await this.projectsService.findOne(projectId, userId);
        await this.prisma.projectWorkingCopy.deleteMany({ where: { projectId } });
        return { discarded: true };
    }
}
