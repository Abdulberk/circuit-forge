/**
 * Simulation Controller
 */
import {
    Controller,
    Get,
    Post,
    Body,
    Param,
    ParseUUIDPipe,
    Query,
    UseGuards,
    BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

import { CreateSimulationDto, QuickSimulationDto } from './dto';
import { SimulationService } from './simulation.service';

@ApiTags('simulation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class SimulationController {
    constructor(private readonly simulationService: SimulationService) {}

    @Post('versions/:versionId/simulations')
    @Throttle({ default: { limit: 30, ttl: 60000 } })
    @ApiOperation({ summary: 'Create simulation from version' })
    async createFromVersion(
        @Param('versionId', ParseUUIDPipe) versionId: string,
        @Body() dto: CreateSimulationDto,
        @CurrentUser() user: { id: string },
    ) {
        return this.simulationService.createFromVersion(
            versionId,
            dto.analysisConfig,
            dto.probes,
            user.id,
            dto.modelAssetIds,
        );
    }

    @Post('simulations/quick')
    @Throttle({ default: { limit: 10, ttl: 60000 } })
    @ApiOperation({ summary: 'Quick simulation from netlist' })
    async quickSim(@Body() dto: QuickSimulationDto, @CurrentUser() user: { id: string }) {
        return this.simulationService.createQuickSim(dto.netlist, dto.analysisConfig, user.id, dto.modelAssetIds);
    }

    @Get('simulations/:jobId')
    @ApiOperation({ summary: 'Get simulation status' })
    async getStatus(@Param('jobId', ParseUUIDPipe) jobId: string, @CurrentUser() user: { id: string }) {
        return this.simulationService.getStatus(jobId, user.id);
    }

    @Get('simulations/:jobId/result')
    @ApiOperation({
        summary: 'Get simulation result (?maxPoints=N decimates each series for display, min-max bucketing)',
    })
    @ApiQuery({
        name: 'maxPoints',
        required: false,
        description:
            'Cap per-series points (10..100000); peaks survive (min-max). meta.downsampledFrom carries the original count.',
    })
    async getResult(
        @Param('jobId', ParseUUIDPipe) jobId: string,
        @CurrentUser() user: { id: string },
        @Query('maxPoints') maxPointsRaw?: string,
    ) {
        let maxPoints: number | undefined;
        if (maxPointsRaw !== undefined) {
            const n = Number(maxPointsRaw);
            if (!Number.isFinite(n) || n < 10 || n > 100_000) {
                throw new BadRequestException('maxPoints must be a number between 10 and 100000');
            }
            maxPoints = Math.floor(n);
        }
        return this.simulationService.getResult(jobId, user.id, maxPoints);
    }
}
