/**
 * Versions Controller
 */
import { Controller, Get, Post, Body, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { VersionsService } from './versions.service';
import { BomService } from './bom.service';
import { CreateVersionDto } from './dto';
import type { CircuitJson } from '@circuit-forge/eda-core';

@ApiTags('versions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class VersionsController {
    constructor(
        private readonly versionsService: VersionsService,
        private readonly bomService: BomService,
    ) { }

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

    @Get('versions/:versionId/bom')
    @ApiOperation({ summary: 'Aggregated bill of materials for the version (JSON, or CSV via ?format=csv)' })
    @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'] })
    async bom(
        @Param('versionId') versionId: string,
        @Query('format') format: string | undefined,
        @CurrentUser() user: { id: string },
        @Res({ passthrough: true }) res: Response,
    ) {
        // findOne enforces the same org/RBAC access path as every other version read.
        const version = await this.versionsService.findOne(versionId, user.id);
        const bom = this.bomService.build(version.circuitJson as unknown as CircuitJson);
        if (format === 'csv') {
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="bom-${versionId}.csv"`);
            return this.bomService.toCsv(bom);
        }
        return bom;
    }
}