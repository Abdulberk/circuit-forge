/**
 * Organizations Controller
 */
import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OrgsService } from './orgs.service';
import { CreateOrgDto } from './dto';

@ApiTags('organizations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('orgs')
export class OrgsController {
    constructor(private readonly orgsService: OrgsService) { }

    @Get()
    @ApiOperation({ summary: 'List user organizations' })
    async findAll(@CurrentUser() user: { id: string }) {
        return this.orgsService.findAllForUser(user.id);
    }

    @Post()
    @ApiOperation({ summary: 'Create organization' })
    async create(@CurrentUser() user: { id: string }, @Body() dto: CreateOrgDto) {
        return this.orgsService.create(dto.name, user.id);
    }

    @Get(':orgId')
    @ApiOperation({ summary: 'Get organization' })
    async findOne(@Param('orgId') orgId: string, @CurrentUser() user: { id: string }) {
        return this.orgsService.findOne(orgId, user.id);
    }
}