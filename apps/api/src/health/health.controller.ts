/**
 * Health Controller
 * Provides health check endpoints for monitoring
 */
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { PrismaService } from '../prisma/prisma.service';

import { ReadinessService } from './readiness.service';

interface CheckResult {
    status: 'ok' | 'error';
    latencyMs?: number;
    error?: string;
}

// Monitoring/orchestrator probes (k8s liveness/readiness) poll frequently and must never be
// rate-limited — exempt the whole controller from the global throttler.
@SkipThrottle()
@ApiTags('health')
@Controller('health')
export class HealthController {
    constructor(
        private readonly prisma: PrismaService,
        private readonly readinessService: ReadinessService,
    ) {}

    /** Run one dependency check, capturing latency and any error. Never throws — a failing dependency
     *  must not mask the others, so each check is isolated and reported independently. */
    private async runCheck(name: string, fn: () => Promise<unknown>): Promise<[string, CheckResult]> {
        const start = Date.now();
        try {
            await fn();
            return [name, { status: 'ok', latencyMs: Date.now() - start }];
        } catch (error) {
            return [
                name,
                {
                    status: 'error',
                    latencyMs: Date.now() - start,
                    error: error instanceof Error ? error.message : 'Unknown error',
                },
            ];
        }
    }

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
        // Probe every HARD dependency the API needs to actually serve traffic: Postgres (data), Redis
        // (the BullMQ broker — without it sims can't be enqueued) and S3/MinIO (model + result storage).
        // Run them concurrently so the probe costs the SLOWEST check, not their sum; each runCheck
        // swallows its own error so one dead dependency doesn't mask the others.
        const results = await Promise.all([
            this.runCheck('database', () => this.prisma.$queryRaw`SELECT 1`),
            this.runCheck('redis', () => this.readinessService.pingRedis()),
            this.runCheck('s3', () => this.readinessService.pingS3()),
        ]);

        const checks: Record<string, CheckResult> = Object.fromEntries(results);
        const allOk = results.every(([, c]) => c.status === 'ok');

        const payload = {
            status: allOk ? 'ok' : 'degraded',
            timestamp: new Date().toISOString(),
            service: 'circuit-forge-api',
            checks,
        };

        // A readiness probe MUST signal not-ready with a non-2xx, or the orchestrator keeps routing
        // traffic to a pod that can't enqueue sims or reach storage. 503 + the same payload pulls the pod
        // from rotation (k8s readiness) while staying debuggable. Liveness (/health/live) is unaffected —
        // the process is alive, it just shouldn't receive traffic until its dependencies recover.
        if (!allOk) {
            throw new ServiceUnavailableException(payload);
        }

        return payload;
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
