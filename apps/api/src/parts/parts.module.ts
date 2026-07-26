/**
 * Component catalog module. Wraps the TME v2 API behind PartProvider and exposes JWT-guarded
 * /parts endpoints. ConfigService is globally available (ConfigModule.forRoot isGlobal).
 */
import { Module } from '@nestjs/common';

import { UsageModule } from '../usage/usage.module';

import { TtlCache } from './cache/ttl-cache';
import { ComponentMapper } from './mappers/component-mapper';
import { PartsController } from './parts.controller';
import { PartsService } from './parts.service';
import { PART_PROVIDER } from './provider/part-provider.interface';
import { TmeProvider } from './provider/tme.provider';
import { TmeClient } from './tme/tme-client';
import { TmeTokenCache } from './tme/tme-token-cache';

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
