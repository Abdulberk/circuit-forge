/**
 * Async agentic design — the long-running-operation (LRO) resource.
 *
 * POST returns 202 + a job id immediately and the agentic loop runs in the background; the client polls
 * GET until a terminal status, then reads the full result. DELETE cancels. The synchronous /design-circuit
 * remains for back-compat, but this is the scalable contract (no multi-minute held HTTP connection).
 */
import { Controller, Post, Get, Delete, Body, Param, HttpCode, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { DesignJobService } from './design-job.service';
import { DesignCircuitDto } from './dto';

@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('design-jobs')
export class DesignJobsController {
    constructor(private readonly designJobs: DesignJobService) {}

    @Post()
    @HttpCode(202)
    // Expensive (each job runs up to N generate→simulate→fix rounds); same per-user budget as /design-circuit.
    @Throttle({ default: { limit: 3, ttl: 60000 } })
    @ApiOperation({ summary: 'Start an async agentic design (closed loop). Returns 202 + a job id to poll.' })
    async start(@Body() dto: DesignCircuitDto, @CurrentUser() user: { id: string }) {
        const input = {
            prompt: dto.prompt,
            constraints: dto.constraints,
            maxRounds: Math.min(Math.max(dto.maxRounds ?? 2, 1), 4),
        };
        // create() enqueues the job onto the durable 'design' queue; the design worker runs the agentic loop
        // and persists the outcome onto the row. The client polls GET until a terminal status. (No more
        // in-process detached execution — an API deploy/crash no longer abandons in-flight design work.)
        const job = await this.designJobs.create(user.id, input);
        return { jobId: job.id, status: job.status };
    }

    @Get(':id')
    @ApiOperation({ summary: 'Poll a design job: status + (when finished) the full design result.' })
    async status(@Param('id') id: string, @CurrentUser() user: { id: string }) {
        return this.designJobs.getForUser(id, user.id);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Cancel a design job (QUEUED → canceled; RUNNING → cooperative abort).' })
    async cancel(@Param('id') id: string, @CurrentUser() user: { id: string }) {
        return this.designJobs.requestCancel(id, user.id);
    }
}
