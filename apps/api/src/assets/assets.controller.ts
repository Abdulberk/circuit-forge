/**
 * Assets Controller
 * Handles file upload and management for SPICE models
 */
import {
    Controller,
    Get,
    Post,
    Delete,
    Body,
    Param,
    Query,
    UseGuards,
    ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AssetsService } from './assets.service';
import { PresignUploadDto, CommitAssetDto } from './dto';

@ApiTags('assets')
@Controller()
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AssetsController {
    constructor(private readonly assetsService: AssetsService) { }

    /**
     * Get presigned URL for uploading a model file
     */
    @Post('orgs/:orgId/assets/models/presign')
    @ApiOperation({ summary: 'Get presigned URL for model upload' })
    @ApiParam({ name: 'orgId', description: 'Organization ID' })
    async presignUpload(
        @CurrentUser() user: { id: string },
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Body() dto: PresignUploadDto,
    ) {
        return this.assetsService.presignUpload(orgId, user.id, dto);
    }

    /**
     * Commit uploaded asset to database
     */
    @Post('orgs/:orgId/assets/models/commit')
    @ApiOperation({ summary: 'Commit uploaded model to database' })
    @ApiParam({ name: 'orgId', description: 'Organization ID' })
    async commitAsset(
        @CurrentUser() user: { id: string },
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Body() dto: CommitAssetDto,
    ) {
        return this.assetsService.commitAsset(orgId, user.id, dto);
    }

    /**
     * List organization assets
     */
    @Get('orgs/:orgId/assets/models')
    @ApiOperation({ summary: 'List organization model assets' })
    @ApiParam({ name: 'orgId', description: 'Organization ID' })
    @ApiQuery({ name: 'type', required: false, description: 'Filter by asset type' })
    async listAssets(
        @CurrentUser() user: { id: string },
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Query('type') type?: string,
    ) {
        return this.assetsService.listAssets(orgId, user.id, type);
    }

    /**
     * Get asset details
     */
    @Get('assets/:assetId')
    @ApiOperation({ summary: 'Get asset details' })
    @ApiParam({ name: 'assetId', description: 'Asset ID' })
    async getAsset(
        @CurrentUser() user: { id: string },
        @Param('assetId', ParseUUIDPipe) assetId: string,
    ) {
        return this.assetsService.getAsset(assetId, user.id);
    }

    /**
     * Get download URL for asset
     */
    @Get('assets/:assetId/download')
    @ApiOperation({ summary: 'Get presigned download URL for asset' })
    @ApiParam({ name: 'assetId', description: 'Asset ID' })
    async getDownloadUrl(
        @CurrentUser() user: { id: string },
        @Param('assetId', ParseUUIDPipe) assetId: string,
    ) {
        return this.assetsService.getDownloadUrl(assetId, user.id);
    }

    /**
     * Delete asset
     */
    @Delete('assets/:assetId')
    @ApiOperation({ summary: 'Delete an asset' })
    @ApiParam({ name: 'assetId', description: 'Asset ID' })
    async deleteAsset(
        @CurrentUser() user: { id: string },
        @Param('assetId', ParseUUIDPipe) assetId: string,
    ) {
        return this.assetsService.deleteAsset(assetId, user.id);
    }
}