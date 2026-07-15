/**
 * Project working-copy endpoints — the editor's continuous-autosave target. PUT overwrites the single
 * draft per project; GET loads it on open; DELETE reverts to last-saved. Distinct from POST /projects/
 * :projectId/versions, which snapshots the draft into an immutable version. All routes JWT-guarded; the
 * service does membership authz on the project.
 */
import { Controller, Get, Put, Delete, Body, Param, ParseUUIDPipe, HttpCode, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { WorkingCopyService } from './working-copy.service';
import { SaveWorkingCopyDto } from './dto';

@ApiTags('projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class WorkingCopyController {
    constructor(private readonly workingCopy: WorkingCopyService) {}

    @Put('projects/:projectId/working-copy')
    @ApiOperation({ summary: 'Autosave the project working copy (idempotent upsert of the live editor draft).' })
    async save(
        @Param('projectId', ParseUUIDPipe) projectId: string,
        @Body() dto: SaveWorkingCopyDto,
        @CurrentUser() user: { id: string },
    ) {
        return this.workingCopy.save(projectId, dto, user.id);
    }

    @Get('projects/:projectId/working-copy')
    @ApiOperation({ summary: 'Load the project working copy; 404 if none yet (open the latest version instead).' })
    async get(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: { id: string }) {
        return this.workingCopy.get(projectId, user.id);
    }

    @Delete('projects/:projectId/working-copy')
    @HttpCode(200)
    @ApiOperation({ summary: 'Discard the working copy (revert to last saved). Idempotent.' })
    async discard(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: { id: string }) {
        return this.workingCopy.discard(projectId, user.id);
    }
}
