/**
 * Projects Controller
 */
import { Controller, Get, Post, Patch, Delete, Body, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaginationQueryDto } from '../common/dto/pagination.dto';

import { CreateProjectDto, UpdateProjectDto } from './dto';
import { ProjectsService } from './projects.service';

@ApiTags('projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class ProjectsController {
    constructor(private readonly projectsService: ProjectsService) {}

    @Get('orgs/:orgId/projects')
    @ApiOperation({ summary: 'List projects in organization (paginated: ?limit&offset)' })
    async findAll(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Query() pagination: PaginationQueryDto,
        @CurrentUser() user: { id: string },
    ) {
        return this.projectsService.findAllForOrg(orgId, user.id, pagination);
    }

    @Post('orgs/:orgId/projects')
    @ApiOperation({ summary: 'Create project' })
    async create(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Body() dto: CreateProjectDto,
        @CurrentUser() user: { id: string },
    ) {
        return this.projectsService.create(orgId, dto.name, dto.description, user.id);
    }

    @Get('projects/:projectId')
    @ApiOperation({ summary: 'Get project' })
    async findOne(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: { id: string }) {
        return this.projectsService.findOne(projectId, user.id);
    }

    @Patch('projects/:projectId')
    @ApiOperation({ summary: 'Update project' })
    async update(
        @Param('projectId', ParseUUIDPipe) projectId: string,
        @Body() dto: UpdateProjectDto,
        @CurrentUser() user: { id: string },
    ) {
        return this.projectsService.update(projectId, dto.name, dto.description, user.id);
    }

    @Delete('projects/:projectId')
    @ApiOperation({ summary: 'Delete project' })
    async delete(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: { id: string }) {
        await this.projectsService.delete(projectId, user.id);
        return { success: true };
    }
}
