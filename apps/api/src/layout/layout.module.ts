/**
 * PCB LayoutJob module — the 'pcb-layout' queue + the LRO endpoints. Self-contained queue connection
 * (like the design queue). attempts:1 — the pipeline is not checkpointed, so a crash surfaces as a
 * terminal FAILED the user can retry, never a silent re-route + re-bill of compute.
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LayoutController } from './layout.controller';
import { LayoutService } from './layout.service';
import { OrgsModule } from '../orgs/orgs.module';

@Module({
    imports: [
        OrgsModule,
        BullModule.registerQueueAsync({
            imports: [ConfigModule],
            name: 'pcb-layout',
            useFactory: (configService: ConfigService) => ({
                connection: { url: configService.get<string>('REDIS_URL') },
                defaultJobOptions: {
                    attempts: 1,
                    removeOnComplete: { age: 3600, count: 1000 },
                    removeOnFail: { age: 24 * 3600, count: 1000 },
                },
            }),
            inject: [ConfigService],
        }),
    ],
    controllers: [LayoutController],
    providers: [LayoutService],
})
export class LayoutModule {}
