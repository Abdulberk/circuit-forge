/**
 * AI Circuit Generation Module
 */
import { Module } from '@nestjs/common';
import { GenerationController } from './generation.controller';
import { GenerationService } from './generation.service';
import { DesignController } from './design.controller';
import { DesignService } from './design.service';
import { SimulationModule } from '../simulation/simulation.module';

@Module({
    // ConfigService is available globally (ConfigModule.forRoot({ isGlobal: true })).
    // SimulationModule provides SimulationService for the agentic design loop.
    imports: [SimulationModule],
    controllers: [GenerationController, DesignController],
    providers: [GenerationService, DesignService],
})
export class GenerationModule {}
