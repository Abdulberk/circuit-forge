/**
 * AI Circuit Generation Module
 */
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { OrgsModule } from '../orgs/orgs.module';
import { PartsModule } from '../parts/parts.module';
import { SimulationModule } from '../simulation/simulation.module';
import { UsageModule } from '../usage/usage.module';

import { CatalogGroundingService } from './catalog-grounding.service';
import { CircuitSimulatorService } from './circuit-simulator.service';
import { DesignJobService } from './design-job.service';
import { DesignJobsController } from './design-jobs.controller';
import { DesignController } from './design.controller';
import { DesignService } from './design.service';
import { GenerationController } from './generation.controller';
import { GenerationService } from './generation.service';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';

@Module({
    // ConfigService is available globally (ConfigModule.forRoot({ isGlobal: true })).
    // SimulationModule provides SimulationService for the agentic design loop.
    // PartsModule provides PartsService so generation can ground the AI in the live parts catalog.
    // OrgsModule provides OrgsService so the async design-job resource can scope/auth jobs by org.
    // UsageModule provides UsageService to gate a design job as one billable/admission unit at enqueue.
    imports: [
        SimulationModule,
        PartsModule,
        OrgsModule,
        UsageModule,
        // The 'design' queue: the durable home of the agentic loop (the design worker consumes it). Its own
        // connection (not the sim BullModule.forRoot) keeps this module self-contained. attempts:1 — the loop
        // is NOT idempotent (no checkpoint), so a BullMQ retry would restart from round 1 and re-bill the LLM;
        // a crash therefore surfaces as a terminal FAILED the user can retry, never a silent re-run.
        BullModule.registerQueueAsync({
            imports: [ConfigModule],
            name: 'design',
            useFactory: (configService: ConfigService) => ({
                connection: { url: configService.get<string>('REDIS_URL') },
                defaultJobOptions: {
                    attempts: 1,
                    // The DesignJob row in Postgres is the source of truth the client polls; the queue record
                    // is disposable once finished. Keep a short window for dashboard triage, then auto-evict.
                    removeOnComplete: { age: 3600, count: 1000 },
                    removeOnFail: { age: 24 * 3600, count: 1000 },
                },
            }),
            inject: [ConfigService],
        }),
    ],
    controllers: [GenerationController, DesignController, DesignJobsController, VerificationController],
    providers: [
        GenerationService,
        DesignService,
        DesignJobService,
        VerificationService,
        CatalogGroundingService,
        CircuitSimulatorService,
    ],
})
export class GenerationModule {}
