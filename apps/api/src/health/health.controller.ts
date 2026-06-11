/**
 * Health Controller
 * Provides health check endpoints for monitoring
 */
import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';

// Monitoring/orchestrator probes (k8s liveness/readiness) poll frequently and must never be
// rate-limited — exempt the whole controller from the global throttler.
@SkipThrottle()
@ApiTags('health')
@Controller('health')
export class HealthController {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * Basic health check
     */
    @Get()
    @ApiOperation({ summary: 'Basic health check' })
    async health() {
        return {
            status: 'ok',
            timestamp: new Date().toISOString(),
            service: 'circuit-forge-api',
        };
    }

    /**
     * Detailed health check including dependencies
     */
    @Get('ready')
    @ApiOperation({ summary: 'Readiness check with dependency status' })
    async readiness() {
        const checks: Record<string, { status: string; latencyMs?: number; error?: string }> = {};

        // Check database
        const dbStart = Date.now();
        try {
            await this.prisma.$queryRaw`SELECT 1`;
            checks['database'] = { status: 'ok', latencyMs: Date.now() - dbStart };
        } catch (error) {
            checks['database'] = {
                status: 'error',
                latencyMs: Date.now() - dbStart,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }

        // Determine overall status
        const allOk = Object.values(checks).every((c) => c.status === 'ok');

        return {
            status: allOk ? 'ok' : 'degraded',
            timestamp: new Date().toISOString(),
            service: 'circuit-forge-api',
            checks,
        };
    }

    /**
     * Liveness check
     */
    @Get('live')
    @ApiOperation({ summary: 'Liveness check' })
    live() {
        return {
            status: 'ok',
            timestamp: new Date().toISOString(),
        };
    }
}