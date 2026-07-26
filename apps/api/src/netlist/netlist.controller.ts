/**
 * SPICE netlist import/export endpoints (JWT-guarded, throttled like the other compute routes).
 */
import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

import { ExportNetlistDto, ImportNetlistDto } from './dto';
import { NetlistService } from './netlist.service';

@ApiTags('netlist')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('netlist')
export class NetlistController {
    constructor(private readonly netlist: NetlistService) {}

    @Post('import')
    @Throttle({ default: { limit: 30, ttl: 60000 } })
    @ApiOperation({ summary: 'Parse a standard SPICE netlist into CircuitJson (+ analysis, warnings, schema verdict)' })
    import(@Body() dto: ImportNetlistDto) {
        return this.netlist.import(dto.netlist);
    }

    @Post('export')
    @Throttle({ default: { limit: 30, ttl: 60000 } })
    @ApiOperation({ summary: 'Generate a self-contained SPICE deck (generic model bodies inlined) from CircuitJson' })
    export(@Body() dto: ExportNetlistDto, @Res({ passthrough: true }) res: Response) {
        const deck = this.netlist.export(dto.circuitJson, dto.analysisConfig, dto.probes);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="circuit.cir"');
        return deck;
    }
}
