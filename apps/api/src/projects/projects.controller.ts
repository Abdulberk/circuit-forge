/**
 * Projects Controller
 */
import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ProjectsService } from './projects.service';
import { CreateProjectDto, UpdateProjectDto } from './dto';

@ApiTags('projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class ProjectsController {
    constructor(private readonly projectsService: ProjectsService) { }

    @Get('orgs/:orgId/projects')
    @ApiOperation({ summary: 'List projects in organization' })
    async findAll(@Param('orgId') orgId: string, @CurrentUser() user: { id: string }) {
        return this.projectsService.findAllForOrg(orgId, user.id);
    }

    @Post('orgs/:orgId/projects')
    @ApiOperation({ summary: 'Create project' })
    async create(
        @Param('orgId') orgId: string,
        @Body() dto: CreateProjectDto,
        @CurrentUser() user: { id: string },
    ) {
        return this.projectsService.create(orgId, dto.name, dto.description, user.id);
    }

    @Get('projects/:projectId')
    @ApiOperation({ summary: 'Get project' })
    async findOne(@Param('projectId') projectId: string, @CurrentUser() user: { id: string }) {
        return this.projectsService.findOne(projectId, user.id);
    }

    @Patch('projects/:projectId')
    @ApiOperation({ summary: 'Update project' })
    async update(
        @Param('projectId') projectId: string,
        @Body() dto: UpdateProjectDto,
        @CurrentUser() user: { id: string },
    ) {
        return this.projectsService.update(projectId, dto.name, dto.description, user.id);
    }

    @Delete('projects/:projectId')
    @ApiOperation({ summary: 'Delete project' })
    async delete(@Param('projectId') projectId: string, @CurrentUser() user: { id: string }) {
        await this.projectsService.delete(projectId, user.id);
        return { success: true };
    }
}