/**
 * Organizations Controller
 */
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaginationQueryDto } from '../common/dto/pagination.dto';

import { CreateOrgDto, OrgAuditQueryDto, UpdateMemberRoleDto, RemoveMemberDto } from './dto';
import { OrgsService } from './orgs.service';

@ApiTags('organizations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('orgs')
export class OrgsController {
    constructor(private readonly orgsService: OrgsService) { }

    @Get()
    @ApiOperation({ summary: 'List user organizations' })
    async findAll(@CurrentUser() user: { id: string }) {
        return this.orgsService.findAllForUser(user.id);
    }

    @Post()
    @ApiOperation({ summary: 'Create organization' })
    async create(@CurrentUser() user: { id: string }, @Body() dto: CreateOrgDto) {
        return this.orgsService.create(dto.name, user.id);
    }

    @Get(':orgId')
    @ApiOperation({ summary: 'Get organization' })
    async findOne(@Param('orgId', ParseUUIDPipe) orgId: string, @CurrentUser() user: { id: string }) {
        return this.orgsService.findOne(orgId, user.id);
    }

    @Get(':orgId/audit-logs')
    @ApiOperation({
        summary: "Read this org's own audit trail (access transparency). OWNER/ADMIN only; operator PII redacted.",
    })
    async auditLogs(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Query() query: OrgAuditQueryDto,
        @CurrentUser() user: { id: string },
    ) {
        // OWNER/ADMIN gate — a plain MEMBER cannot read the trail.
        await this.orgsService.checkMembership(orgId, user.id, ['OWNER', 'ADMIN']);
        return this.orgsService.listAuditLogs(
            orgId,
            { limit: query.limit, offset: query.offset },
            { action: query.action, entityType: query.entityType, userId: query.userId },
        );
    }

    // ---------------------------------------------------------------- self-serve team management

    @Get(':orgId/members')
    @ApiOperation({ summary: 'List org members (any member may read).' })
    async listMembers(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Query() page: PaginationQueryDto,
        @CurrentUser() user: { id: string },
    ) {
        await this.orgsService.checkMembership(orgId, user.id); // any member
        return this.orgsService.listMembers(orgId, { limit: page.limit, offset: page.offset });
    }

    @Patch(':orgId/members/:userId')
    @ApiOperation({ summary: "Change a member's role (OWNER/ADMIN; only an OWNER may grant/revoke OWNER)." })
    async updateMemberRole(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Param('userId', ParseUUIDPipe) targetUserId: string,
        @Body() dto: UpdateMemberRoleDto,
        @CurrentUser() user: { id: string },
    ) {
        const actor = await this.orgsService.checkMembership(orgId, user.id, [OrgRole.OWNER, OrgRole.ADMIN]);
        return this.orgsService.updateMemberRole(orgId, targetUserId, dto.role, user.id, actor.role, dto.reason);
    }

    @Delete(':orgId/members/:userId')
    @ApiOperation({ summary: 'Remove a member (OWNER/ADMIN; the last OWNER cannot be removed).' })
    async removeMember(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Param('userId', ParseUUIDPipe) targetUserId: string,
        @Body() dto: RemoveMemberDto,
        @CurrentUser() user: { id: string },
    ) {
        const actor = await this.orgsService.checkMembership(orgId, user.id, [OrgRole.OWNER, OrgRole.ADMIN]);
        return this.orgsService.removeMember(orgId, targetUserId, user.id, actor.role, dto.reason);
    }
}