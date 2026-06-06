/**
 * Simulation Controller
 */
import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SimulationService } from './simulation.service';
import { CreateSimulationDto, QuickSimulationDto } from './dto';

@ApiTags('simulation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class SimulationController {
    constructor(private readonly simulationService: SimulationService) { }

    @Post('versions/:versionId/simulations')
    @ApiOperation({ summary: 'Create simulation from version' })
    async createFromVersion(
        @Param('versionId') versionId: string,
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
    async quickSim(
        @Body() dto: QuickSimulationDto,
        @CurrentUser() user: { id: string },
    ) {
        return this.simulationService.createQuickSim(dto.netlist, dto.analysisConfig, user.id, dto.modelAssetIds);
    }

    @Get('simulations/:jobId')
    @ApiOperation({ summary: 'Get simulation status' })
    async getStatus(@Param('jobId') jobId: string, @CurrentUser() user: { id: string }) {
        return this.simulationService.getStatus(jobId, user.id);
    }

    @Get('simulations/:jobId/result')
    @ApiOperation({ summary: 'Get simulation result' })
    async getResult(@Param('jobId') jobId: string, @CurrentUser() user: { id: string }) {
        return this.simulationService.getResult(jobId, user.id);
    }
}