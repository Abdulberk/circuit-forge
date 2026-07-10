/**
 * Admin Module — the platform-operator API. Stands alone: imported by AppModule, and imports the
 * services it reuses cross-tenant (OrgsModule for Phase 2 member mgmt, UsageModule for usage snapshots
 * + quota overrides, HealthModule for the readiness probes). PrismaService + AuditService are global.
 *
 * It registers its OWN handles to the 'simulations' and 'design' queues (inline connection, mirroring
 * GenerationModule) so AdminQueueService can read depth / (Phase 3) pause without importing the feature
 * modules' queue providers.
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { OrgsModule } from '../orgs/orgs.module';
import { UsageModule } from '../usage/usage.module';
import { HealthModule } from '../health/health.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminQueueService } from './admin-queue.service';
import { AdminStorageService } from './admin-storage.service';
import { PlatformAdminGuard } from './guards/platform-admin.guard';

@Module({
    imports: [
        OrgsModule,
        UsageModule,
        HealthModule,
        BullModule.registerQueueAsync(
            {
                imports: [ConfigModule],
                name: 'simulations',
                useFactory: (config: ConfigService) => ({ connection: { url: config.get<string>('REDIS_URL') } }),
                inject: [ConfigService],
            },
            {
                imports: [ConfigModule],
                name: 'design',
                useFactory: (config: ConfigService) => ({ connection: { url: config.get<string>('REDIS_URL') } }),
                inject: [ConfigService],
            },
        ),
    ],
    controllers: [AdminController],
    providers: [AdminService, AdminQueueService, AdminStorageService, PlatformAdminGuard],
})
export class AdminModule {}
