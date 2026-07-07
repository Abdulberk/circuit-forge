/**
 * pcb-worker entry point — a trimmed BullMQ bootstrap (no OTel/ngspice/bwrap; the PCB pipeline shells out
 * to freerouting + kicad-cli which the pcb-runtime image provides). Mirrors worker-sim's lifecycle:
 * connect Prisma → start the worker → drain in-flight work on SIGTERM/SIGINT.
 */
import { createLayoutWorker } from './layout/processor';
import { prisma, disconnectPrisma } from './prisma/client';
import { logger } from './logger';
import { config } from './config';
import type { Worker } from 'bullmq';

let worker: Worker | null = null;

async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Received shutdown signal');
    try {
        if (worker) {
            // BullMQ waits for the active handler — a mid-route PCB job drains + lands its terminal row.
            await worker.close();
            logger.info('Layout worker closed');
        }
        await disconnectPrisma();
        logger.info('Shutdown complete');
        process.exit(0);
    } catch (error) {
        logger.error({ error }, 'Error during shutdown');
        process.exit(1);
    }
}

async function main(): Promise<void> {
    logger.info({ env: config.NODE_ENV, queue: config.PCB_QUEUE_NAME }, 'Starting pcb-worker');
    try {
        await prisma.$connect();
        logger.info('Database connected');
    } catch (error) {
        logger.error({ error }, 'Failed to connect to database');
        process.exit(1);
    }

    worker = createLayoutWorker();

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    logger.info('pcb-worker is running');
}

main().catch((error) => {
    logger.fatal({ error }, 'Fatal error');
    process.exit(1);
});
