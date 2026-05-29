/**
 * Worker-Sim Main Entry Point
 */
import { createSimulationWorker } from './simulation/processor';
import { prisma, disconnectPrisma } from './prisma/client';
import { logger } from './logger';
import { config } from './config';

let worker: ReturnType<typeof createSimulationWorker> | null = null;

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Received shutdown signal');

    try {
        // Close worker
        if (worker) {
            await worker.close();
            logger.info('Worker closed');
        }

        // Disconnect Prisma
        await disconnectPrisma();

        logger.info('Shutdown complete');
        process.exit(0);
    } catch (error) {
        logger.error({ error }, 'Error during shutdown');
        process.exit(1);
    }
}

/**
 * Main function
 */
async function main(): Promise<void> {
    logger.info({ env: config.NODE_ENV }, 'Starting worker-sim');

    // Test database connection
    try {
        await prisma.$connect();
        logger.info('Database connected');
    } catch (error) {
        logger.error({ error }, 'Failed to connect to database');
        process.exit(1);
    }

    // Create and start worker
    worker = createSimulationWorker();

    // Setup shutdown handlers
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    logger.info('Worker-sim is running');
}

// Start the application
main().catch((error) => {
    logger.fatal({ error }, 'Fatal error');
    process.exit(1);
});