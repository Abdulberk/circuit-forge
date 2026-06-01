/**
 * AI Circuit Generation Module
 */
import { Module } from '@nestjs/common';
import { GenerationController } from './generation.controller';
import { GenerationService } from './generation.service';
import { DesignController } from './design.controller';
import { DesignService } from './design.service';
import { SimulationModule } from '../simulation/simulation.module';
import { PartsModule } from '../parts/parts.module';

@Module({
    // ConfigService is available globally (ConfigModule.forRoot({ isGlobal: true })).
    // SimulationModule provides SimulationService for the agentic design loop.
    // PartsModule provides PartsService so generation can ground the AI in the live parts catalog.
    imports: [SimulationModule, PartsModule],
    controllers: [GenerationController, DesignController],
    providers: [GenerationService, DesignService],
})
export class GenerationModule {}
