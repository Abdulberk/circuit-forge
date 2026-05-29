/**
 * Prisma client singleton for worker
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../logger';

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined;
};

export const prisma =
    globalForPrisma.prisma ??
    new PrismaClient({
        log: [
            { level: 'query', emit: 'event' },
            { level: 'error', emit: 'stdout' },
            { level: 'warn', emit: 'stdout' },
        ],
    });

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}

// Log slow queries
prisma.$on('query' as never, (e: { duration: number; query: string }) => {
    if (e.duration > 100) {
        logger.warn({ duration: e.duration, query: e.query }, 'Slow query detected');
    }
});

export async function disconnectPrisma(): Promise<void> {
    await prisma.$disconnect();
    logger.info('Prisma disconnected');
}