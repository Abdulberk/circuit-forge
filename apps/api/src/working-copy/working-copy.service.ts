/**
 * Project working-copy service — the mutable "current draft" half of continuous autosave. The editor
 * PUTs the live circuit here (debounced) and it OVERWRITES one row per project (last-writer-wins). "Save
 * version" is a separate, immutable snapshot (VersionsService.create). This service owns only the draft:
 * a single-row upsert on save, a single-row read on load. No history, no growth — the row is reused.
 */
import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
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
        // ---- Optimistic concurrency, when the caller asked for it.
        //
        // A conditional updateMany is the whole mechanism: it matches on (projectId, updatedAt) and reports
        // how many rows it touched. Zero means the row moved since the client read it — someone else's save
        // landed in between — so we refuse and hand back the CURRENT state rather than overwriting work
        // that was never shown to anyone. Prisma's @updatedAt already maintains the token, so this needs no
        // migration and no new column.
        //
        // Deliberately not wrapped in a transaction: the conditional update IS the atomic compare-and-set.
        // A read-then-write inside a transaction would need SERIALIZABLE to be equivalent, and would still
        // be no safer than the single statement.
        if (dto.expectedUpdatedAt !== undefined) {
            const expected = new Date(dto.expectedUpdatedAt);
            if (Number.isNaN(expected.getTime())) {
                throw new BadRequestException('expectedUpdatedAt is not a valid timestamp');
            }
            const { count } = await this.prisma.projectWorkingCopy.updateMany({
                where: { projectId, updatedAt: expected },
                data: { ...content, ...(dto.baseVersionId === undefined ? {} : { baseVersionId: dto.baseVersionId }) },
            });
            if (count === 0) {
                // Either the row moved, or there is no row at all and the client believed there was. Both
                // are the same answer to the client — "your base is stale, here is what is actually there".
                const current = await this.prisma.projectWorkingCopy.findUnique({
                    where: { projectId },
                    select: { updatedAt: true, updatedByUserId: true },
                });
                throw new ConflictException({
                    message: current
                        ? 'The working copy changed since you loaded it — reload before saving.'
                        : 'There is no working copy to update; save without expectedUpdatedAt to create one.',
                    code: 'WORKING_COPY_CONFLICT',
                    currentUpdatedAt: current?.updatedAt ?? null,
                    currentUpdatedByUserId: current?.updatedByUserId ?? null,
                });
            }
            return this.prisma.projectWorkingCopy.findUniqueOrThrow({
                where: { projectId },
                select: { projectId: true, baseVersionId: true, updatedByUserId: true, updatedAt: true },
            });
        }

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
        if (!wc) {
            // Carries a machine-readable code for the same reason the 409 above does. This route can answer
            // 404 for TWO different reasons — the project does not exist (or is not yours), thrown by
            // `findOne` a line earlier, and the project exists but has no draft, thrown here. Both arrive as
            // a bare 404, so a client that wants to render "no working copy yet" for the second while
            // reporting a genuine error for the first has nothing to branch on but the English message. That
            // is not a contract; it is prose that a rewording silently breaks.
            throw new NotFoundException({
                message: 'No working copy for this project',
                code: 'NO_WORKING_COPY',
            });
        }
        return wc;
    }

    /** Discard the draft (e.g. "revert to last saved"). Idempotent — no error if there is nothing to drop. */
    async discard(projectId: string, userId: string) {
        await this.projectsService.findOne(projectId, userId);
        await this.prisma.projectWorkingCopy.deleteMany({ where: { projectId } });
        return { discarded: true };
    }
}
