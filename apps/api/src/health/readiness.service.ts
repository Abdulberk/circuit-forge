/**
 * Readiness dependency clients.
 *
 * Owns the clients the readiness probe pings — a dedicated, health-only Redis connection and S3 client,
 * both configured to FAIL FAST (no long retries / offline queueing) so a dead dependency makes
 * /health/ready go red immediately instead of hanging the probe. Deliberately separate from the app's
 * BullMQ connection (maxRetriesPerRequest:null — a ping there would hang when Redis is down) and from the
 * feature S3 clients.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';

/** Reject `p` if it doesn't settle within `ms` — keeps a readiness probe bounded even if a client hangs. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        p.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (e) => {
                clearTimeout(timer);
                reject(e instanceof Error ? e : new Error(String(e)));
            },
        );
    });
}

@Injectable()
export class ReadinessService implements OnModuleDestroy {
    private readonly logger = new Logger(ReadinessService.name);
    private readonly redis: Redis;
    private readonly s3: S3Client;
    private readonly bucket: string;

    constructor() {
        this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
            // Fail fast for a probe: don't queue commands while disconnected, cap per-command retries,
            // short connect timeout. The connection-level retryStrategy keeps RECONNECTING in the
            // background (never gives up) so the probe auto-recovers when Redis returns, while a live
            // ping rejects immediately when it's down.
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
            connectTimeout: 2000,
            retryStrategy: (times) => Math.min(times * 200, 2000),
        });
        // Health pings are best-effort; swallow the steady reconnect-error noise when Redis is down.
        this.redis.on('error', (e) => this.logger.debug(`readiness redis: ${e.message}`));

        this.bucket = process.env.S3_BUCKET || 'circuitforge';
        this.s3 = new S3Client({
            endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
            region: process.env.S3_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin',
                secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin',
            },
            forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
            maxAttempts: 1, // a probe wants fail-fast, not the SDK's default 3 retries
        });
    }

    /** PING Redis (the BullMQ broker). Rejects if Redis is unreachable. */
    async pingRedis(timeoutMs = 2000): Promise<void> {
        await withTimeout(this.redis.ping(), timeoutMs, 'redis ping timed out');
    }

    /** HEAD the configured bucket. Rejects if S3/MinIO is unreachable or the bucket is missing. */
    async pingS3(timeoutMs = 3000): Promise<void> {
        await withTimeout(
            this.s3.send(new HeadBucketCommand({ Bucket: this.bucket })),
            timeoutMs,
            's3 head-bucket timed out',
        );
    }

    async onModuleDestroy(): Promise<void> {
        this.s3.destroy();
        try {
            await this.redis.quit();
        } catch {
            this.redis.disconnect();
        }
    }
}
