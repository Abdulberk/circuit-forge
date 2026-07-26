/**
 * Health Module
 * Provides health check endpoints
 */
import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { ReadinessService } from './readiness.service';

@Module({
    controllers: [HealthController],
    providers: [ReadinessService],
    // Exported so the admin health-dashboard can reuse the same fail-fast Redis/S3 probes.
    exports: [ReadinessService],
})
export class HealthModule {}
