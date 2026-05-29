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
        }),
        VersionsModule,
        OrgsModule,
    ],
    controllers: [SimulationController],
    providers: [SimulationService],
    exports: [SimulationService],
})
export class SimulationModule { }