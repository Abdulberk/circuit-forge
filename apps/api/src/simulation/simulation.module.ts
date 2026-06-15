/**
 * Simulation Module
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SimulationController } from './simulation.controller';
import { SimulationService } from './simulation.service';
import { VersionsModule } from '../versions/versions.module';
import { OrgsModule } from '../orgs/orgs.module';
import { UsageModule } from '../usage/usage.module';

@Module({
    imports: [
        BullModule.forRootAsync({
            imports: [ConfigModule],
            useFactory: async (configService: ConfigService) => ({
                connection: {
                    url: configService.get<string>('REDIS_URL'),
                },
            }),
            inject: [ConfigService],
        }),
        BullModule.registerQueue({
            name: 'simulations',
            defaultJobOptions: {
                // INFRA-ONLY retry. Only a THROWN job is retried; the worker RETURNS genuine simulation
                // faults (non-convergence, bad circuit) so those complete-as-failed and are NEVER retried
                // — re-running a deterministically-bad deck just wastes a slot. The worker only THROWS on
                // infrastructure hiccups (ngspice couldn't launch, a transient S3/DB/Redis blip), which a
                // retry can genuinely recover. Backoff spaces the 2 retries (1s, 2s) past a brief outage.
                attempts: 3,
                backoff: { type: 'exponential', delay: 1000 },
                // Bound Redis memory: the job's lifecycle status/result lives in Postgres (the API polls
                // there, never BullMQ), so the queue record is disposable once finished. Keep a short
                // window for debugging via any queue dashboard, then auto-evict.
                removeOnComplete: { age: 3600, count: 1000 }, // 1h or last 1000, whichever first
                removeOnFail: { age: 24 * 3600, count: 1000 }, // keep failures a day for triage
            },
        }),
        VersionsModule,
        OrgsModule,
        UsageModule,
    ],
    controllers: [SimulationController],
    providers: [SimulationService],
    exports: [SimulationService],
})
export class SimulationModule { }