/**
 * Templates Controller
 * Provides template CRUD endpoints
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
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiParam } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { TemplatesService } from './templates.service';
import { CreateTemplateDto, ListTemplatesQueryDto } from './dto';

@ApiTags('templates')
@Controller('templates')
export class TemplatesController {
    constructor(private readonly templatesService: TemplatesService) { }

    /**
     * List templates
     * Public templates are accessible without auth
     * Org templates require auth and membership
     */
    @Get()
    @UseGuards(OptionalJwtAuthGuard)
    @ApiOperation({ summary: 'List templates (public or org-specific)' })
    @ApiQuery({ name: 'orgId', required: false, description: 'Filter by organization ID' })
    @ApiQuery({ name: 'tag', required: false, description: 'Filter by tag' })
    @ApiQuery({ name: 'limit', required: false, description: 'Max results (default 50)' })
    @ApiQuery({ name: 'offset', required: false, description: 'Offset for pagination' })
    async findAll(
        @CurrentUser() user: { id: string } | null,
        @Query() query: ListTemplatesQueryDto,
    ) {
        return this.templatesService.findAll(user?.id || null, query);
    }

    /**
     * Create a new template
     */
    @Post()
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Create a new template' })
    async create(
        @CurrentUser() user: { id: string },
        @Body() dto: CreateTemplateDto,
    ) {
        return this.templatesService.create(user.id, dto);
    }

    /**
     * Get a single template
     */
    @Get(':templateId')
    @UseGuards(OptionalJwtAuthGuard)
    @ApiOperation({ summary: 'Get template by ID' })
    @ApiParam({ name: 'templateId', description: 'Template ID' })
    async findOne(
        @CurrentUser() user: { id: string } | null,
        @Param('templateId', ParseUUIDPipe) templateId: string,
    ) {
        return this.templatesService.findOne(templateId, user?.id || null);
    }

    /**
     * Delete a template
     * Only org templates can be deleted by org admins/owners
     */
    @Delete(':templateId')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Delete a template' })
    @ApiParam({ name: 'templateId', description: 'Template ID' })
    async delete(
        @CurrentUser() user: { id: string },
        @Param('templateId', ParseUUIDPipe) templateId: string,
    ) {
        return this.templatesService.delete(templateId, user.id);
    }
}