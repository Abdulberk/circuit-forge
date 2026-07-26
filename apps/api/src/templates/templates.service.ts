/**
 * Templates Service
 * Handles template CRUD operations with public/org scope
 */
import { safeValidateAnalysisConfig } from '@circuit-forge/eda-core';
import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { OrgsService } from '../orgs/orgs.service';
import { PrismaService } from '../prisma/prisma.service';

import { CreateTemplateDto, ListTemplatesQueryDto } from './dto';

@Injectable()
export class TemplatesService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly orgsService: OrgsService,
    ) { }

    /**
     * Create a new template
     * If orgId is provided, it's an org-private template
     * If orgId is null, it's a public template (requires special permission)
     */
    async create(userId: string, dto: CreateTemplateDto) {
        // If creating org template, verify membership
        if (dto.orgId) {
            await this.orgsService.requireMembership(dto.orgId, userId);
        } else {
            // Creating public template requires admin verification
            // For MVP, we allow authenticated users to create public templates
            // In production, this would require special admin role
        }

        // analysisConfig is optional, but when present its `analysis` must be a VALID AnalysisConfig —
        // storing a malformed one would make the frontend's "Run" emit a broken simulation request later.
        if (dto.analysisConfig !== undefined) {
            const analysis = (dto.analysisConfig as { analysis?: unknown }).analysis;
            const parsed = safeValidateAnalysisConfig(analysis);
            if (!parsed.success) {
                throw new BadRequestException(
                    `analysisConfig.analysis is not a valid AnalysisConfig: ${parsed.error.errors
                        .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
                        .join('; ')}`,
                );
            }
        }

        return this.prisma.template.create({
            data: {
                orgId: dto.orgId || null,
                name: dto.name,
                tags: dto.tags || [],
                circuitJson: dto.circuitJson as Prisma.InputJsonValue,
                analysisConfig: (dto.analysisConfig as Prisma.InputJsonValue | undefined) ?? undefined,
            },
        });
    }

    /**
     * List templates with optional filters
     * - No orgId: list public templates
     * - With orgId: list org templates (requires membership)
     */
    async findAll(userId: string | null, query: ListTemplatesQueryDto) {
        const where: Prisma.TemplateWhereInput = {};

        if (query.orgId) {
            // Org-specific templates require membership
            if (userId) {
                await this.orgsService.requireMembership(query.orgId, userId);
            } else {
                throw new ForbiddenException('Authentication required to view org templates');
            }
            where.orgId = query.orgId;
        } else {
            // Public templates only
            where.orgId = null;
        }

        // Tag filter
        if (query.tag) {
            where.tags = {
                has: query.tag,
            };
        }

        return this.prisma.template.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: query.limit || 50,
            skip: query.offset || 0,
        });
    }

    /**
     * Get a single template by ID
     * Public templates are accessible to everyone
     * Org templates require membership
     */
    async findOne(templateId: string, userId: string | null) {
        const template = await this.prisma.template.findUnique({
            where: { id: templateId },
        });

        if (!template) {
            throw new NotFoundException('Template not found');
        }

        // If org template, verify membership
        if (template.orgId) {
            if (!userId) {
                throw new ForbiddenException('Authentication required to view this template');
            }
            await this.orgsService.requireMembership(template.orgId, userId);
        }

        return template;
    }

    /**
     * Delete a template
     * Only org templates can be deleted, and only by members
     */
    async delete(templateId: string, userId: string) {
        const template = await this.prisma.template.findUnique({
            where: { id: templateId },
        });

        if (!template) {
            throw new NotFoundException('Template not found');
        }

        // Public templates cannot be deleted via API (admin only)
        if (!template.orgId) {
            throw new ForbiddenException('Public templates cannot be deleted');
        }

        // Verify membership
        const membership = await this.orgsService.requireMembership(template.orgId, userId);

        // Only OWNER or ADMIN can delete templates
        if (membership.role !== 'OWNER' && membership.role !== 'ADMIN') {
            throw new ForbiddenException('Only org owners and admins can delete templates');
        }

        await this.prisma.template.delete({
            where: { id: templateId },
        });

        return { deleted: true };
    }
}