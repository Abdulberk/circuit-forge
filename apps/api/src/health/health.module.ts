/**
 * Health Module
 * Provides health check endpoints
 */
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({
    controllers: [HealthController],
})
export class HealthModule { }