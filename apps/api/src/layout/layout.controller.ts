/**
 * Async PCB layout — the long-running-operation resource. POST returns 202 + a job id; the pcb-worker runs
 * the quality pipeline in the background; the client polls GET until a terminal status, then reads the
 * shaped result + presigned GLB/manufacturing URLs.
 */
import { Controller, Post, Get, Body, Param, Query, ParseUUIDPipe, HttpCode, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

import { CreateLayoutDto, ListLayoutsQueryDto } from './dto';
import { LayoutService } from './layout.service';

@ApiTags('pcb')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('layouts')
export class LayoutController {
    constructor(private readonly layouts: LayoutService) {}

    @Post()
    @HttpCode(202)
    // A PCB job is heavy (freerouting 10–120s); same shape as the design LRO throttle.
    @Throttle({ default: { limit: 5, ttl: 60000 } })
    @ApiOperation({ summary: 'Start an async PCB layout job. Returns 202 + a job id to poll.' })
    async start(@Body() dto: CreateLayoutDto, @CurrentUser() user: { id: string }) {
        const job = await this.layouts.create(user.id, dto);
        return { jobId: job.id, status: job.status };
    }

    @Get()
    @ApiOperation({
        summary: 'List your layout jobs (newest first), optionally filtered by ?versionId= or ?projectId=. ' +
            'Use ?versionId= to re-find the PCB(s) for a saved circuit after a page reload.',
    })
    async list(@Query() query: ListLayoutsQueryDto, @CurrentUser() user: { id: string }) {
        return this.layouts.findAllForUser(
            user.id,
            { limit: query.limit, offset: query.offset },
            { versionId: query.versionId, projectId: query.projectId },
        );
    }

    @Get(':id')
    @ApiOperation({ summary: 'Poll a layout job: status + (when finished) the shaped result + presigned artifact URLs.' })
    async status(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }) {
        return this.layouts.getForUser(id, user.id);
    }
}
