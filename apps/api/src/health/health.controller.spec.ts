import { ServiceUnavailableException, HttpStatus } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';

import { HealthController } from './health.controller';
import type { ReadinessService } from './readiness.service';

/**
 * Builds a HealthController with mocked dependencies. Pass an Error for any of db/redis/s3 to make that
 * dependency's check fail; omit it to make the check pass.
 */
function makeController(fail: { db?: Error; redis?: Error; s3?: Error } = {}) {
    const prisma = {
        $queryRaw: jest.fn(() => (fail.db ? Promise.reject(fail.db) : Promise.resolve([{ '?column?': 1 }]))),
    } as unknown as PrismaService;

    const readinessService = {
        pingRedis: jest.fn(() => (fail.redis ? Promise.reject(fail.redis) : Promise.resolve())),
        pingS3: jest.fn(() => (fail.s3 ? Promise.reject(fail.s3) : Promise.resolve())),
    } as unknown as ReadinessService;

    return { controller: new HealthController(prisma, readinessService), prisma, readinessService };
}

/** Invoke readiness() and return either the resolved body or the thrown exception. */
async function callReadiness(
    controller: HealthController,
): Promise<{ ok: boolean; body: any; exc?: ServiceUnavailableException }> {
    try {
        const body = await controller.readiness();
        return { ok: true, body };
    } catch (e) {
        if (e instanceof ServiceUnavailableException) return { ok: false, body: e.getResponse(), exc: e };
        throw e;
    }
}

describe('HealthController.readiness', () => {
    it('returns ok and reports all three dependency checks when everything is healthy', async () => {
        const { controller } = makeController();
        const { ok, body } = await callReadiness(controller);

        expect(ok).toBe(true);
        expect(body.status).toBe('ok');
        expect(body.service).toBe('circuit-forge-api');
        expect(Object.keys(body.checks).sort()).toEqual(['database', 'redis', 's3']);
        expect(body.checks.database.status).toBe('ok');
        expect(body.checks.redis.status).toBe('ok');
        expect(body.checks.s3.status).toBe('ok');
        // every check carries a latency measurement
        for (const c of Object.values<any>(body.checks)) {
            expect(typeof c.latencyMs).toBe('number');
        }
    });

    it('throws 503 (degraded) when Redis is down, while still reporting the healthy checks', async () => {
        const { controller } = makeController({ redis: new Error('Redis down') });
        const { ok, body, exc } = await callReadiness(controller);

        expect(ok).toBe(false);
        expect(exc!.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE); // 503 — pulls the pod from rotation
        expect(body.status).toBe('degraded');
        expect(body.checks.redis).toEqual(expect.objectContaining({ status: 'error', error: 'Redis down' }));
        // independence: a dead Redis must not mask the others
        expect(body.checks.database.status).toBe('ok');
        expect(body.checks.s3.status).toBe('ok');
    });

    it('throws 503 (degraded) when S3 is down', async () => {
        const { controller } = makeController({ s3: new Error('NoSuchBucket') });
        const { ok, body, exc } = await callReadiness(controller);

        expect(ok).toBe(false);
        expect(exc!.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        expect(body.status).toBe('degraded');
        expect(body.checks.s3).toEqual(expect.objectContaining({ status: 'error', error: 'NoSuchBucket' }));
        expect(body.checks.database.status).toBe('ok');
        expect(body.checks.redis.status).toBe('ok');
    });

    it('throws 503 (degraded) when the database is down', async () => {
        const { controller } = makeController({ db: new Error('ECONNREFUSED 5432') });
        const { ok, body } = await callReadiness(controller);

        expect(ok).toBe(false);
        expect(body.status).toBe('degraded');
        expect(body.checks.database).toEqual(expect.objectContaining({ status: 'error', error: 'ECONNREFUSED 5432' }));
        expect(body.checks.redis.status).toBe('ok');
        expect(body.checks.s3.status).toBe('ok');
    });

    it('surfaces ALL failing dependencies at once (no short-circuit between checks)', async () => {
        const { controller } = makeController({
            db: new Error('db gone'),
            redis: new Error('redis gone'),
            s3: new Error('s3 gone'),
        });
        const { ok, body } = await callReadiness(controller);

        expect(ok).toBe(false);
        expect(body.status).toBe('degraded');
        expect(body.checks.database.status).toBe('error');
        expect(body.checks.redis.status).toBe('error');
        expect(body.checks.s3.status).toBe('error');
    });

    it('falls back to "Unknown error" when a check rejects with a non-Error value', async () => {
        const { controller, readinessService } = makeController();
        (readinessService.pingRedis as jest.Mock).mockRejectedValueOnce('weird string');
        const { ok, body } = await callReadiness(controller);

        expect(ok).toBe(false);
        expect(body.checks.redis).toEqual(expect.objectContaining({ status: 'error', error: 'Unknown error' }));
    });

    it('runs each dependency check exactly once per probe', async () => {
        const { controller, prisma, readinessService } = makeController();
        await callReadiness(controller);

        expect(prisma.$queryRaw as jest.Mock).toHaveBeenCalledTimes(1);
        expect(readinessService.pingRedis as jest.Mock).toHaveBeenCalledTimes(1);
        expect(readinessService.pingS3 as jest.Mock).toHaveBeenCalledTimes(1);
    });
});
