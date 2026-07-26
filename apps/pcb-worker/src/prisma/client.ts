/** Prisma client singleton (mirrors worker-sim). */
import { PrismaClient } from '@prisma/client';

import { logger } from '../logger';

import { withConnectionLimit } from './connection-limit';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };
const datasourceUrl = withConnectionLimit(process.env.DATABASE_URL);

export const prisma =
    globalForPrisma.prisma ??
    new PrismaClient({
        ...(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : {}),
        log: [{ level: 'error', emit: 'stdout' }, { level: 'warn', emit: 'stdout' }],
    });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export async function disconnectPrisma(): Promise<void> {
    await prisma.$disconnect();
    logger.info('Prisma disconnected');
}
