/**
 * Org invitation endpoints. The org-scoped routes (create/list/revoke) are OWNER/ADMIN-gated via
 * OrgsService.checkMembership; POST /invitations/accept is open to any authenticated user (the invitee),
 * who is verified by the token + an email match inside the service.
 */
import { Controller, Get, Post, Delete, Body, Param, Query, ParseUUIDPipe, HttpCode, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { OrgsService } from '../orgs/orgs.service';
import { InvitationsService } from './invitations.service';
import { CreateInvitationDto, AcceptInvitationDto } from './dto';

@ApiTags('organizations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class InvitationsController {
    constructor(
        private readonly invitations: InvitationsService,
        private readonly orgs: OrgsService,
    ) {}

    @Post('orgs/:orgId/invitations')
    @ApiOperation({ summary: 'Invite someone by email to join the org (OWNER/ADMIN). Sends an invite email.' })
    async create(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Body() dto: CreateInvitationDto,
        @CurrentUser() user: { id: string },
    ) {
        const actor = await this.orgs.checkMembership(orgId, user.id, [OrgRole.OWNER, OrgRole.ADMIN]);
        return this.invitations.create(orgId, user.id, actor.role, dto.email, dto.role);
    }

    @Get('orgs/:orgId/invitations')
    @ApiOperation({ summary: 'List the org invitations and their status (OWNER/ADMIN).' })
    async list(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Query() page: PaginationQueryDto,
        @CurrentUser() user: { id: string },
    ) {
        await this.orgs.checkMembership(orgId, user.id, [OrgRole.OWNER, OrgRole.ADMIN]);
        return this.invitations.list(orgId, { limit: page.limit, offset: page.offset });
    }

    @Delete('orgs/:orgId/invitations/:invitationId')
    @HttpCode(204)
    @ApiOperation({ summary: 'Revoke a pending invitation (OWNER/ADMIN).' })
    async revoke(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Param('invitationId', ParseUUIDPipe) invitationId: string,
        @CurrentUser() user: { id: string },
    ) {
        await this.orgs.checkMembership(orgId, user.id, [OrgRole.OWNER, OrgRole.ADMIN]);
        await this.invitations.revoke(orgId, invitationId, user.id);
    }

    @Post('invitations/accept')
    @HttpCode(200)
    @ApiOperation({ summary: 'Accept an invitation as the logged-in invitee (token from the email link).' })
    async accept(@Body() dto: AcceptInvitationDto, @CurrentUser() user: { id: string }) {
        return this.invitations.accept(dto.token, user.id);
    }
}
