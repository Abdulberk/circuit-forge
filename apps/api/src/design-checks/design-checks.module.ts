import { Module } from '@nestjs/common';

import { DesignChecksController } from './design-checks.controller';
import { DesignChecksService } from './design-checks.service';

/**
 * The cheap, synchronous design checks. No database, no queue, no quota — so this module depends on
 * nothing, which is also what keeps the endpoints fast enough for an editor to call on every idle pause.
 */
@Module({
    controllers: [DesignChecksController],
    providers: [DesignChecksService],
})
export class DesignChecksModule {}
