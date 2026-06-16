/**
 * AI Circuit Generation Module
 */
import { Module } from '@nestjs/common';
import { GenerationController } from './generation.controller';
import { GenerationService } from './generation.service';
import { DesignController } from './design.controller';
import { DesignService } from './design.service';
import { DesignJobsController } from './design-jobs.controller';
import { DesignJobService } from './design-job.service';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';
import { CatalogGroundingService } from './catalog-grounding.service';
import { CircuitSimulatorService } from './circuit-simulator.service';
import { SimulationModule } from '../simulation/simulation.module';
import { PartsModule } from '../parts/parts.module';
import { OrgsModule } from '../orgs/orgs.module';

@Module({
    // ConfigService is available globally (ConfigModule.forRoot({ isGlobal: true })).
    // SimulationModule provides SimulationService for the agentic design loop.
    // PartsModule provides PartsService so generation can ground the AI in the live parts catalog.
    // OrgsModule provides OrgsService so the async design-job resource can scope/auth jobs by org.
    imports: [SimulationModule, PartsModule, OrgsModule],
    controllers: [GenerationController, DesignController, DesignJobsController, VerificationController],
    providers: [GenerationService, DesignService, DesignJobService, VerificationService, CatalogGroundingService, CircuitSimulatorService],
})
export class GenerationModule {}
