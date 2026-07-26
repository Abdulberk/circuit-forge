/**
 * Versions Controller
 */
import type { CircuitJson } from '@circuit-forge/eda-core';
import { Controller, Get, Post, Body, Param, ParseUUIDPipe, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import type { Response } from 'express';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaginationQueryDto } from '../common/dto/pagination.dto';

import { BomService } from './bom.service';
import { CreateVersionDto } from './dto';
import { VersionsService } from './versions.service';


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
    @ApiOperation({ summary: 'List project versions (paginated: ?limit&offset)' })
    async findAll(
        @Param('projectId', ParseUUIDPipe) projectId: string,
        @Query() pagination: PaginationQueryDto,
        @CurrentUser() user: { id: string },
    ) {
        return this.versionsService.findAllForProject(projectId, user.id, pagination);
    }

    @Post('projects/:projectId/versions')
    @ApiOperation({ summary: 'Create new version' })
    async create(
        @Param('projectId', ParseUUIDPipe) projectId: string,
        @Body() dto: CreateVersionDto,
        @CurrentUser() user: { id: string },
    ) {
        return this.versionsService.create(projectId, dto.circuitJson, dto.uiJson, user.id);
    }

    @Get('versions/:versionId')
    @ApiOperation({ summary: 'Get version' })
    async findOne(@Param('versionId', ParseUUIDPipe) versionId: string, @CurrentUser() user: { id: string }) {
        return this.versionsService.findOne(versionId, user.id);
    }

    @Get('versions/:versionId/bom')
    @ApiOperation({ summary: 'Aggregated bill of materials for the version (JSON, or CSV via ?format=csv)' })
    @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'] })
    async bom(
        @Param('versionId', ParseUUIDPipe) versionId: string,
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