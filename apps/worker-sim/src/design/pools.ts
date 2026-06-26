/**
 * PROCESS-GLOBAL resource pools — created once at module load and shared by EVERY design job, every candidate,
 * and the Monte-Carlo pass (and, when wired, the sim queue). This is the load-bearing performance lever for
 * multi-candidate generation: once a single job runs candidates concurrently, the per-queue concurrency
 * (DESIGN_CONCURRENCY) no longer bounds CPU — only a global ngspice semaphore does, so peak concurrent ngspice
 * stays fixed regardless of how many candidates a job fans out.
 *
 * Sizing (when NGSPICE_GLOBAL_CONCURRENCY is unset): max(1, floor(cores * 0.75) - CONCURRENCY) — leaves
 * ~25% of cores as headroom and reserves CONCURRENCY cores for the 'simulations' queue so design fan-out
 * can't starve verify-design / quick-sim. The LLM semaphore caps in-flight LLM requests process-wide so a
 * burst of candidate generations stays under the provider's rate limits.
 */
import os from 'os';
import { config } from '../config';
import { Semaphore } from '../util/semaphore';
import { logger } from '../logger';

const cores = os.cpus()?.length ?? 4;
const ngspicePermits = config.NGSPICE_GLOBAL_CONCURRENCY ?? Math.max(1, Math.floor(cores * 0.75) - config.CONCURRENCY);
const llmPermits = config.GLOBAL_LLM_CONCURRENCY ?? 6;

/** Caps concurrent ngspice processes across the whole worker. */
export const ngspiceSem = new Semaphore(ngspicePermits);
/** Caps concurrent in-flight LLM requests across the whole worker (wired into the multi-candidate fan-out). */
export const llmSem = new Semaphore(llmPermits);

logger.info(
    { cores, ngspiceConcurrency: ngspicePermits, llmConcurrency: llmPermits },
    'Global resource pools initialized',
);
