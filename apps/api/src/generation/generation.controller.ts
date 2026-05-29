/**
 * AI Circuit Generation Controller (generate / edit / explain)
 */
import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GenerationService } from './generation.service';
import { GenerateCircuitDto, EditCircuitDto, ExplainCircuitDto } from './dto';

@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class GenerationController {
    constructor(private readonly generationService: GenerationService) {}

    @Post('generate-circuit')
    @Throttle({ default: { limit: 5, ttl: 60000 } })
    @ApiOperation({ summary: 'Generate a circuit (CircuitJson) from a natural-language prompt' })
    async generate(@Body() dto: GenerateCircuitDto) {
        return this.generationService.generate(dto);
    }

    @Post('edit-circuit')
    @Throttle({ default: { limit: 5, ttl: 60000 } })
    @ApiOperation({ summary: 'Edit an existing circuit with a natural-language instruction' })
    async edit(@Body() dto: EditCircuitDto) {
        return this.generationService.edit(dto);
    }

    @Post('explain-circuit')
    @Throttle({ default: { limit: 10, ttl: 60000 } })
    @ApiOperation({ summary: 'Explain an existing circuit in plain language' })
    async explain(@Body() dto: ExplainCircuitDto) {
        return this.generationService.explain(dto);
    }
}
