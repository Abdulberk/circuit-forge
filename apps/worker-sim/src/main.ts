/**
 * Worker-Sim Main Entry Point
 */
// MUST stay first: starts OpenTelemetry (when configured) before any instrumented module loads.
import './observability/instrumentation';
import { createSimulationWorker } from './simulation/processor';
import { createDesignWorker } from './design/processor';
import { prisma, disconnectPrisma } from './prisma/client';
import { logger } from './logger';
import { config } from './config';
import { shutdownTelemetry } from './observability/telemetry';
import { probeBwrap, isBwrapEnabled } from './simulation/sandbox';
import type { Worker } from 'bullmq';

let worker: ReturnType<typeof createSimulationWorker> | null = null;
let designWorker: Worker | null = null;

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Received shutdown signal');

    try {
        // Close workers — let each in-flight job drain (BullMQ waits for the active handler). The design
        // worker is closed too so a long design loop finishes its current round / lands its terminal row.
        if (worker) {
            await worker.close();
            logger.info('Worker closed');
        }
        if (designWorker) {
            await designWorker.close();
            logger.info('Design worker closed');
        }

        // Disconnect Prisma
        await disconnectPrisma();

        // Flush telemetry LAST — after the in-flight job has drained and DB queries are done — so the
        // final spans/metrics export. Telemetry deliberately owns no signal handler of its own, so this
        // graceful path is the single owner of process exit (no race that could abandon a running job).
        await shutdownTelemetry();

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

    // Preflight the optional bubblewrap isolation up front (if enabled), so we know whether the host can
    // create the namespaces it needs — and, if not, log loudly and fall back to the rlimit hardening
    // rather than failing every job. The result is cached for resolveSandboxConfig.
    if (isBwrapEnabled(config.SIM_BWRAP)) {
        await probeBwrap({
            enabled: true,
            bin: config.SIM_BWRAP_PATH,
            log: (ok, detail) =>
                ok
                    ? logger.info({ detail }, 'bubblewrap isolation ENABLED for the ngspice child (preflight passed)')
                    : logger.warn(
                          { detail },
                          'SIM_BWRAP is set but bubblewrap is NOT usable on this host (needs unprivileged user namespaces + a permissive seccomp profile) — falling back to the rlimit hardening',
                      ),
        });
    } else {
        logger.info('bubblewrap isolation disabled (SIM_BWRAP not set); ngspice runs under the rlimit + non-root hardening');
    }

    // Create and start the simulation worker.
    worker = createSimulationWorker();

    // Start the design worker ONLY when an LLM key is configured. A sim-only deployment (no LLM_API_KEY)
    // deliberately does not consume the 'design' queue — it would only fail every design job. With a key,
    // this worker is the durable home of the agentic design loop (replacing the API's detached runner).
    if (config.LLM_API_KEY) {
        designWorker = createDesignWorker();
    } else {
        logger.info('LLM_API_KEY not set — design worker NOT started (this worker processes simulations only)');
    }

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