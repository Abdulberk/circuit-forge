/**
 * Prisma Service
 */
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Ensure the connection URL carries an explicit `connection_limit`. Prisma's default is
 * `num_cpus * 2 + 1` (≈5 on a small box), which the AI design loop exhausts easily — it polls job
 * status ~1×/s for up to 90s, holding a pooled connection each time → P2024 "timed out fetching a
 * connection". We set a sane floor (override via DB_CONNECTION_LIMIT) unless the operator already
 * specified one in DATABASE_URL.
 */
function withConnectionLimit(raw?: string): string | undefined {
    if (!raw) return undefined;
    if (/[?&]connection_limit=/.test(raw)) return raw; // operator set it explicitly — respect it
    // Append by string concat (NOT new URL().toString(), which re-encodes the whole string and would
    // corrupt a password containing characters Prisma tolerates raw). DB_CONNECTION_LIMIT must be a
    // bare integer; anything else falls back to the default.
    const configured = process.env.DB_CONNECTION_LIMIT;
    const limit = configured && /^\d+$/.test(configured) ? configured : '10';
    return raw + (raw.includes('?') ? '&' : '?') + `connection_limit=${limit}`;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PrismaService.name);

    constructor() {
        const url = withConnectionLimit(process.env.DATABASE_URL);
        super(url ? { datasources: { db: { url } } } : undefined);
    }

    async onModuleInit() {
        await this.$connect();
        this.logger.log('Database connected');
    }

    async onModuleDestroy() {
        await this.$disconnect();
        this.logger.log('Database disconnected');
    }
}
