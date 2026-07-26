/**
 * Platform Admin API — cross-tenant operator surface, gated by PlatformAdminGuard.
 *
 * Guard stack: JwtAuthGuard (authenticate) -> PlatformAdminGuard (authorize by live DB platformRole).
 * Class-level @PlatformRoles(SUPPORT) makes every route require SUPPORT+; Phase 2 mutations raise the
 * bar per method (OPERATOR to mutate, ADMIN for role/config). Not tenant-scoped: an admin sees every org.
 *
 * Route ORDER matters: the literal `orgs/usage` is declared BEFORE `orgs/:id` so it isn't captured by
 * the :id param (which would 400 in ParseUUIDPipe).
 */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PlatformRole } from '@prisma/client';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaginationQueryDto } from '../common/dto/pagination.dto';

import { AdminService } from './admin.service';
import { CurrentPlatformActor, PlatformActor } from './decorators/platform-actor.decorator';
import { PlatformRoles } from './decorators/platform-roles.decorator';
import {
    AdminUsersQueryDto,
    AdminOrgsQueryDto,
    AdminSimJobsQueryDto,
    AdminDesignJobsQueryDto,
    AdminAuditQueryDto,
    LockUserDto,
    SetPlatformRoleDto,
    SetEmailVerifiedDto,
    RenameOrgDto,
    SuspendOrgDto,
    AddMemberDto,
    UpdateMemberRoleDto,
    SetQuotaOverrideDto,
    ActionReasonDto,
    PurgeQueueDto,
    SweepOrphanModelsDto,
} from './dto';
import { PlatformAdminGuard } from './guards/platform-admin.guard';


@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@PlatformRoles(PlatformRole.SUPPORT) // class default: every /admin/* route needs at least SUPPORT
export class AdminController {
    constructor(private readonly adminService: AdminService) {}

    @Get('me')
    @ApiOperation({ summary: 'Return the calling platform admin (identity + live role)' })
    me(@CurrentPlatformActor() actor: PlatformActor) {
        return { id: actor.id, email: actor.email, platformRole: actor.platformRole };
    }

    // -------- users
    @Get('users')
    @ApiOperation({ summary: 'List/search all users (paginated)' })
    listUsers(@Query() q: AdminUsersQueryDto) {
        return this.adminService.listUsers({ limit: q.limit, offset: q.offset }, q.search);
    }

    @Get('users/:id')
    @ApiOperation({ summary: 'User detail: profile, memberships, active sessions, lock state' })
    getUser(@Param('id', ParseUUIDPipe) id: string, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.getUser(id, actor);
    }

    // -------- orgs (usage BEFORE :id — see class comment)
    @Get('orgs/usage')
    @ApiOperation({ summary: 'Usage across a page of orgs (top-consumers view)' })
    allOrgsUsage(@Query() q: PaginationQueryDto) {
        return this.adminService.allOrgsUsage({ limit: q.limit, offset: q.offset });
    }

    @Get('orgs')
    @ApiOperation({ summary: 'List/search all orgs (paginated)' })
    listOrgs(@Query() q: AdminOrgsQueryDto) {
        return this.adminService.listOrgs({ limit: q.limit, offset: q.offset }, q.search);
    }

    @Get('orgs/:id')
    @ApiOperation({ summary: 'Org detail: members + usage snapshot + effective quotas' })
    getOrg(@Param('id', ParseUUIDPipe) id: string, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.getOrg(id, actor);
    }

    // -------- jobs (cross-tenant)
    @Get('jobs/simulation')
    @ApiOperation({ summary: 'List simulation jobs across all tenants (filter ?orgId&status)' })
    listSimJobs(@Query() q: AdminSimJobsQueryDto) {
        return this.adminService.listSimJobs({ limit: q.limit, offset: q.offset }, q.orgId, q.status);
    }

    @Get('jobs/simulation/:id')
    @ApiOperation({ summary: 'Full simulation-job detail for any tenant (netlist/config/result/metrics)' })
    getSimJob(@Param('id', ParseUUIDPipe) id: string, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.getSimJob(id, actor);
    }

    @Get('jobs/design')
    @ApiOperation({ summary: 'List design jobs across all tenants (filter ?orgId&status)' })
    listDesignJobs(@Query() q: AdminDesignJobsQueryDto) {
        return this.adminService.listDesignJobs({ limit: q.limit, offset: q.offset }, q.orgId, q.status);
    }

    @Get('jobs/design/:id')
    @ApiOperation({ summary: 'Full design-job detail for any tenant (prompt/result)' })
    getDesignJob(@Param('id', ParseUUIDPipe) id: string, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.getDesignJob(id, actor);
    }

    // -------- queues + audit + health
    @Get('queues/health')
    @ApiOperation({ summary: 'BullMQ depth for the simulation + design queues' })
    queueHealth() {
        return this.adminService.queueHealth();
    }

    @Get('audit-logs')
    @ApiOperation({ summary: 'Search the platform-wide audit trail (paginated)' })
    listAuditLogs(@Query() q: AdminAuditQueryDto) {
        return this.adminService.listAuditLogs(
            { limit: q.limit, offset: q.offset },
            { orgId: q.orgId, userId: q.userId, adminActorId: q.adminActorId, action: q.action, entityType: q.entityType },
        );
    }

    @Get('health/dashboard')
    @ApiOperation({ summary: 'System-wide dependency + queue health' })
    healthDashboard() {
        return this.adminService.healthDashboard();
    }

    // ================================================================ Phase 2: mutations
    // OPERATOR+ for tenant control; ADMIN for platform-role changes. All audited server-side.

    // -------- user lifecycle
    @Patch('users/:id/lock')
    @PlatformRoles(PlatformRole.OPERATOR)
    @ApiOperation({ summary: 'Lock/unlock a user (locking also revokes live sessions)' })
    lockUser(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LockUserDto, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.lockUser(id, dto, actor);
    }

    @Post('users/:id/logout-all')
    @HttpCode(HttpStatus.OK)
    @PlatformRoles(PlatformRole.OPERATOR)
    @ApiOperation({ summary: 'Revoke all of a user’s sessions (refresh-token families)' })
    logoutAll(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ActionReasonDto, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.logoutAll(id, dto, actor);
    }

    @Patch('users/:id/role')
    @PlatformRoles(PlatformRole.ADMIN)
    @ApiOperation({ summary: 'Change a user’s platform role (ADMIN only; demotion revokes sessions)' })
    setPlatformRole(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetPlatformRoleDto, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.setPlatformRole(id, dto, actor);
    }

    @Patch('users/:id/email-verified')
    @PlatformRoles(PlatformRole.OPERATOR)
    @ApiOperation({ summary: 'Override a user’s email-verified flag' })
    setEmailVerified(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetEmailVerifiedDto, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.setEmailVerified(id, dto, actor);
    }

    // -------- org lifecycle
    @Patch('orgs/:id')
    @PlatformRoles(PlatformRole.OPERATOR)
    @ApiOperation({ summary: 'Rename an organization' })
    renameOrg(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RenameOrgDto, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.renameOrg(id, dto, actor);
    }

    @Patch('orgs/:id/suspend')
    @PlatformRoles(PlatformRole.OPERATOR)
    @ApiOperation({ summary: 'Suspend/reinstate an org (suspend blocks all its writes with 403)' })
    suspendOrg(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SuspendOrgDto, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.suspendOrg(id, dto, actor);
    }

    // -------- membership
    @Post('orgs/:id/members')
    @PlatformRoles(PlatformRole.OPERATOR)
    @ApiOperation({ summary: 'Add (or re-role) a member in any org' })
    addMember(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddMemberDto, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.addMember(id, dto, actor);
    }

    @Patch('orgs/:id/members/:userId')
    @PlatformRoles(PlatformRole.OPERATOR)
    @ApiOperation({ summary: 'Change a member’s tenant role (blocks demoting the last owner)' })
    updateMemberRole(
        @Param('id', ParseUUIDPipe) id: string,
        @Param('userId', ParseUUIDPipe) userId: string,
        @Body() dto: UpdateMemberRoleDto,
        @CurrentPlatformActor() actor: PlatformActor,
    ) {
        return this.adminService.updateMemberRole(id, userId, dto, actor);
    }

    @Delete('orgs/:id/members/:userId')
    @PlatformRoles(PlatformRole.OPERATOR)
    @ApiOperation({ summary: 'Remove a member from any org (blocks removing the last owner)' })
    removeMember(
        @Param('id', ParseUUIDPipe) id: string,
        @Param('userId', ParseUUIDPipe) userId: string,
        @Body() dto: ActionReasonDto,
        @CurrentPlatformActor() actor: PlatformActor,
    ) {
        return this.adminService.removeMember(id, userId, dto, actor);
    }

    // -------- per-org quota override
    @Patch('orgs/:id/quota')
    @PlatformRoles(PlatformRole.OPERATOR)
    @ApiOperation({ summary: 'Set per-org quota overrides (null clears a field → inherit env)' })
    setQuotaOverride(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetQuotaOverrideDto, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.setQuotaOverride(id, dto, actor);
    }

    @Delete('orgs/:id/quota')
    @PlatformRoles(PlatformRole.OPERATOR)
    @ApiOperation({ summary: 'Clear all per-org quota overrides (inherit env everywhere)' })
    clearQuotaOverride(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ActionReasonDto, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.clearQuotaOverride(id, dto, actor);
    }

    // -------- jobs (cancel / retry)
    @Post('jobs/simulation/:id/cancel')
    @HttpCode(HttpStatus.OK)
    @PlatformRoles(PlatformRole.OPERATOR)
    @ApiOperation({ summary: 'Cancel a QUEUED simulation (removes it from the queue)' })
    cancelSimJob(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ActionReasonDto, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.cancelSimJob(id, dto, actor);
    }

    @Post('jobs/simulation/:id/retry')
    @HttpCode(HttpStatus.OK)
    @PlatformRoles(PlatformRole.OPERATOR)
    @ApiOperation({ summary: 'Re-enqueue a failed/timed-out/canceled simulation' })
    retrySimJob(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ActionReasonDto, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.retrySimJob(id, dto, actor);
    }

    @Post('jobs/design/:id/cancel')
    @HttpCode(HttpStatus.OK)
    @PlatformRoles(PlatformRole.OPERATOR)
    @ApiOperation({ summary: 'Cancel a design job (QUEUED → CANCELED, RUNNING → cooperative abort)' })
    cancelDesignJob(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ActionReasonDto, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.cancelDesignJob(id, dto, actor);
    }

    // -------- queue kill-switch + maintenance (ADMIN — platform-wide blast radius)
    @Post('queues/:name/pause')
    @HttpCode(HttpStatus.OK)
    @PlatformRoles(PlatformRole.ADMIN)
    @ApiOperation({ summary: 'Pause a queue (simulations|design) — in-flight drains, no new jobs start' })
    pauseQueue(@Param('name') name: string, @Body() dto: ActionReasonDto, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.pauseQueue(name, dto, actor);
    }

    @Post('queues/:name/resume')
    @HttpCode(HttpStatus.OK)
    @PlatformRoles(PlatformRole.ADMIN)
    @ApiOperation({ summary: 'Resume a paused queue (simulations|design)' })
    resumeQueue(@Param('name') name: string, @Body() dto: ActionReasonDto, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.resumeQueue(name, dto, actor);
    }

    @Post('queues/:name/purge')
    @HttpCode(HttpStatus.OK)
    @PlatformRoles(PlatformRole.ADMIN)
    @ApiOperation({ summary: 'Purge terminal job-record cruft (completed|failed) from a queue' })
    purgeQueue(@Param('name') name: string, @Body() dto: PurgeQueueDto, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.purgeQueue(name, dto, actor);
    }

    // ---------------------------------------------------------------- storage (Phase 3 ops levers)

    @Post('storage/sweep-orphan-models')
    @HttpCode(HttpStatus.OK)
    @PlatformRoles(PlatformRole.ADMIN)
    @ApiOperation({ summary: 'Delete S3 model objects with no Asset row, older than the grace window (dryRun supported)' })
    sweepOrphanModels(@Body() dto: SweepOrphanModelsDto, @CurrentPlatformActor() actor: PlatformActor) {
        return this.adminService.sweepOrphanModels(dto, actor);
    }
}
