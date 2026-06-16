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
})
export class HealthModule { }