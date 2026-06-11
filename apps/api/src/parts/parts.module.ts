/**
 * Component catalog module. Wraps the TME v2 API behind PartProvider and exposes JWT-guarded
 * /parts endpoints. ConfigService is globally available (ConfigModule.forRoot isGlobal).
 */
import { Module } from '@nestjs/common';
import { UsageModule } from '../usage/usage.module';
import { PartsController } from './parts.controller';
import { PartsService } from './parts.service';
import { TmeTokenCache } from './tme/tme-token-cache';
import { TmeClient } from './tme/tme-client';
import { TmeProvider } from './provider/tme.provider';
import { PART_PROVIDER } from './provider/part-provider.interface';
import { TtlCache } from './cache/ttl-cache';
import { ComponentMapper } from './mappers/component-mapper';

@Module({
    imports: [UsageModule],
    controllers: [PartsController],
    providers: [
        PartsService,
        TmeTokenCache,
        TmeClient,
        TmeProvider,
        TtlCache,
        ComponentMapper,
        { provide: PART_PROVIDER, useExisting: TmeProvider },
    ],
    // Exported so other modules (e.g. GenerationModule) can ground the AI in the live catalog.
    exports: [PartsService],
})
export class PartsModule {}
