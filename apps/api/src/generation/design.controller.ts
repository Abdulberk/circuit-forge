/**
 * Agentic AI Circuit Design Controller
 */
import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

import { DesignService } from './design.service';
import { DesignCircuitDto } from './dto';

@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class DesignController {
    constructor(private readonly designService: DesignService) {}

    @Post('design-circuit')
    // Expensive: each request runs up to N (generate/fix → simulate) rounds. The AI also
    // chooses a sensible analysis; on a failed/empty simulation it self-corrects and retries.
    @Throttle({ default: { limit: 3, ttl: 60000 } })
    @ApiOperation({
        summary: 'Agentic design: generate a circuit, simulate it, and AI-fix on failure (closed loop)',
    })
    async design(@Body() dto: DesignCircuitDto, @CurrentUser() user: { id: string }) {
        return this.designService.design(dto, user.id);
    }
}
