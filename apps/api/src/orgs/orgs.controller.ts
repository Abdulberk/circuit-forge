/**
 * Organizations Controller
 */
import { Controller, Get, Post, Body, Param, Query, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OrgsService } from './orgs.service';
import { CreateOrgDto, OrgAuditQueryDto } from './dto';

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
}