/**
 * Organizations Service
 */
import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OrgsService {
    constructor(private prisma: PrismaService) { }

    async findAllForUser(userId: string) {
        const memberships = await this.prisma.orgMembership.findMany({
            where: { userId },
            include: {
                org: true,
            },
            // Stable order: callers treat [0] as the user's primary org (e.g. quick-sim quota
            // attribution), so the result must not depend on the query plan.
            orderBy: { createdAt: 'asc' },
        });
        return memberships.map((m) => ({
            ...m.org,
            role: m.role,
        }));
    }

    async findOne(id: string, userId: string) {
        const membership = await this.prisma.orgMembership.findUnique({
            where: {
                orgId_userId: { orgId: id, userId },
            },
            include: {
                org: true,
            },
        });

        if (!membership) {
            throw new NotFoundException('Organization not found or access denied');
        }

        return {
            ...membership.org,
            role: membership.role,
        };
    }

    async create(name: string, userId: string) {
        return this.prisma.organization.create({
            data: {
                name,
                memberships: {
                    create: {
                        userId,
                        role: 'OWNER',
                    },
                },
            },
        });
    }

    async checkMembership(orgId: string, userId: string, requiredRoles?: string[]) {
        const membership = await this.prisma.orgMembership.findUnique({
            where: {
                orgId_userId: { orgId, userId },
            },
        });

        if (!membership) {
            throw new ForbiddenException('Not a member of this organization');
        }

        if (requiredRoles && !requiredRoles.includes(membership.role)) {
            throw new ForbiddenException('Insufficient permissions');
        }

        return membership;
    }

    /**
     * Alias for checkMembership - used by templates and assets services
     */
    async requireMembership(orgId: string, userId: string, requiredRoles?: string[]) {
        return this.checkMembership(orgId, userId, requiredRoles);
    }
}