/**
 * pcb-worker entry point — a trimmed BullMQ bootstrap (no OTel/ngspice/bwrap; the PCB pipeline shells out
 * to freerouting + kicad-cli which the pcb-runtime image provides). Mirrors worker-sim's lifecycle:
 * connect Prisma → start the worker → drain in-flight work on SIGTERM/SIGINT.
 */
import type { Worker } from 'bullmq';

import { config } from './config';
import { createLayoutWorker } from './layout/processor';
import { startLayoutReaper } from './layout/reaper';
import { logger } from './logger';
import { prisma, disconnectPrisma } from './prisma/client';

let worker: Worker | null = null;
let reaper: { stop: () => Promise<void> } | null = null;

async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Received shutdown signal');
    try {
        if (worker) {
            // BullMQ waits for the active handler — a mid-route PCB job drains + lands its terminal row.
            await worker.close();
            logger.info('Layout worker closed');
        }
        if (reaper) {
            await reaper.stop();
            logger.info('Layout reaper stopped');
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
    // Recovers layout jobs orphaned by a worker death (rolling-deploy SIGKILL) or the API's insert↔enqueue
    // gap. Idempotent + conditional, so running it on every worker instance is safe.
    reaper = startLayoutReaper();

    // `void`: shutdown() owns its own error handling end-to-end (try/catch → logger → process.exit),
    // so there is nothing for the caller to await or catch. Marking it explicitly keeps the promise
    // from being silently discarded by a void-returning signal handler.
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
    logger.info('pcb-worker is running');
}

main().catch((error) => {
    logger.fatal({ error }, 'Fatal error');
    process.exit(1);
});
