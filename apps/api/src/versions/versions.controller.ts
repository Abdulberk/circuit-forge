/**
 * Versions Controller
 */
import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { VersionsService } from './versions.service';
import { CreateVersionDto } from './dto';

@ApiTags('versions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class VersionsController {
    constructor(private readonly versionsService: VersionsService) { }

    @Get('projects/:projectId/versions')
    @ApiOperation({ summary: 'List project versions' })
    async findAll(@Param('projectId') projectId: string, @CurrentUser() user: { id: string }) {
        return this.versionsService.findAllForProject(projectId, user.id);
    }

    @Post('projects/:projectId/versions')
    @ApiOperation({ summary: 'Create new version' })
    async create(
        @Param('projectId') projectId: string,
        @Body() dto: CreateVersionDto,
        @CurrentUser() user: { id: string },
    ) {
        return this.versionsService.create(projectId, dto.circuitJson, dto.uiJson, user.id);
    }

    @Get('versions/:versionId')
    @ApiOperation({ summary: 'Get version' })
    async findOne(@Param('versionId') versionId: string, @CurrentUser() user: { id: string }) {
        return this.versionsService.findOne(versionId, user.id);
    }
}