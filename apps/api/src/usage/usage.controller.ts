/**
 * Org usage snapshot — "this month you used X of Y" for the frontend's usage page.
 */
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OrgsService } from '../orgs/orgs.service';
import { UsageService } from './usage.service';

@ApiTags('usage')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class UsageController {
    constructor(
        private readonly usage: UsageService,
        private readonly orgs: OrgsService,
    ) {}

    @Get('orgs/:orgId/usage')
    @ApiOperation({ summary: 'Current-month usage (sim jobs/runtime/in-flight, storage, parts calls) + configured limits (null = unlimited)' })
    async getUsage(@Param('orgId') orgId: string, @CurrentUser() user: { id: string }) {
        await this.orgs.checkMembership(orgId, user.id);
        return this.usage.getOrgUsage(orgId, user.id);
    }
}
