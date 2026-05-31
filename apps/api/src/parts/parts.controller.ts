/**
 * Component catalog controller. JWT-guarded; throttled below TME's ~5 req/s ceiling.
 * NOTE: literal routes (search/manufacturers/categories) are declared before `:symbol`.
 */
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PartsService } from './parts.service';
import { SearchPartsDto } from './dto';

@ApiTags('parts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('parts')
export class PartsController {
    constructor(private readonly parts: PartsService) {}

    @Get('search')
    @Throttle({ default: { limit: 30, ttl: 60000 } })
    @ApiOperation({ summary: 'Search the component catalog (real manufacturer parts)' })
    search(@Query() dto: SearchPartsDto) {
        return this.parts.search(dto);
    }

    @Get('manufacturers')
    @Throttle({ default: { limit: 60, ttl: 60000 } })
    @ApiOperation({ summary: 'List manufacturers with product counts (catalog facet)' })
    manufacturers() {
        return this.parts.getManufacturers();
    }

    @Get('categories')
    @Throttle({ default: { limit: 60, ttl: 60000 } })
    @ApiOperation({ summary: 'Category tree with product counts (catalog facet)' })
    categories() {
        return this.parts.getCategories();
    }

    @Get(':symbol')
    @Throttle({ default: { limit: 30, ttl: 60000 } })
    @ApiOperation({ summary: 'Part detail: parameters, pricing tiers, stock, datasheet' })
    detail(@Param('symbol') symbol: string) {
        return this.parts.getProduct(symbol);
    }

    @Get(':symbol/component')
    @Throttle({ default: { limit: 30, ttl: 60000 } })
    @ApiOperation({ summary: 'CircuitJson component for a part (with simulatable flag)' })
    component(@Param('symbol') symbol: string) {
        return this.parts.getComponent(symbol);
    }
}
