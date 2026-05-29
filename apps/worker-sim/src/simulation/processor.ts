/**
 * Simulation Job Processor
 * BullMQ processor for handling simulation jobs
 */
import { Job, Worker } from 'bullmq';
import Redis from 'ioredis';
import { prisma } from '../prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import { runSimulation, type SimulationJobResult } from './runner';
import { downloadFile, uploadJsonResult } from '../storage/s3-client';

/**
 * Job payload from the queue
 */
export interface SimulationJobPayload {
    jobId: string;
    orgId: string;
    netlist: string;
    probeNames: string[];
    analysisType: string;
    analysisConfig: Record<string, unknown>;
    modelAssets?: string[]; // S3 keys
}

/**
 * Create the simulation worker
 */
export function createSimulationWorker(): Worker {
    const connection = new Redis(config.REDIS_URL, {
        maxRetriesPerRequest: null,
    });

    const worker = new Worker<SimulationJobPayload>(
        config.QUEUE_NAME,
        async (job: Job<SimulationJobPayload>) => {
            return processJob(job);
        },
        {
            connection,
            concurrency: config.CONCURRENCY,
        },
    );

    worker.on('completed', (job) => {
        logger.info({ jobId: job.data.jobId }, 'Job completed');
    });

    worker.on('failed', (job, err) => {
        logger.error({ jobId: job?.data.jobId, error: err.message }, 'Job failed');
    });

    worker.on('error', (err) => {
        logger.error({ error: err.message }, 'Worker error');
    });

    logger.info({ queue: config.QUEUE_NAME, concurrency: config.CONCURRENCY }, 'Simulation worker started');

    return worker;
}

/**
 * Process a single simulation job
 */
async function processJob(job: Job<SimulationJobPayload>): Promise<void> {
    const { jobId, orgId, netlist, probeNames, analysisType, modelAssets } = job.data;

    logger.info({ jobId, orgId }, 'Processing simulation job');

    try {
        // Update job status to RUNNING
        await prisma.simulationJob.update({
            where: { id: jobId },
            data: {
                status: 'RUNNING',
                startedAt: new Date(),
            },
        });

        // Download model files if needed
        const modelFiles: Array<{ name: string; content: Buffer }> = [];
        if (modelAssets && modelAssets.length > 0) {
            for (const s3Key of modelAssets) {
                const content = await downloadFile(s3Key);
                const name = s3Key.split('/').pop() || 'model.lib';
                modelFiles.push({ name, content });
                logger.debug({ s3Key, name }, 'Model file downloaded');
            }
        }

        // Run the simulation
        const result = await runSimulation({
            jobId,
            netlist,
            probeNames,
            analysisType,
            modelFiles: modelFiles.length > 0 ? modelFiles : undefined,
        });

        // Handle result
        if (result.success && result.result) {
            await handleSuccess(jobId, result);
        } else {
            await handleFailure(jobId, result);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ jobId, error: errorMessage }, 'Job processing error');

        await prisma.simulationJob.update({
            where: { id: jobId },
            data: {
                status: 'FAILED',
                stderr: errorMessage,
                finishedAt: new Date(),
                metrics: {
                    error: errorMessage,
                },
            },
        });

        throw error;
    }
}

/**
 * Handle successful simulation
 */
async function handleSuccess(jobId: string, result: SimulationJobResult): Promise<void> {
    const { result: simResult, stdout, stderr, runtimeMs, outputSizeBytes } = result;

    // Decide whether to store result in DB or S3
    const resultJson = JSON.stringify(simResult);
    const resultSize = Buffer.byteLength(resultJson);

    let resultS3Key: string | undefined;
    let storedResult = simResult;

    // If result is large, store in S3
    if (resultSize > 1024 * 1024) { // > 1MB
        resultS3Key = await uploadJsonResult(jobId, simResult);
        storedResult = undefined;
        logger.info({ jobId, s3Key: resultS3Key, size: resultSize }, 'Large result stored in S3');
    }

    await prisma.simulationJob.update({
        where: { id: jobId },
        data: {
            status: 'SUCCEEDED',
            stdout: stdout.substring(0, 10000), // Limit stored stdout
            stderr: stderr.substring(0, 10000),
            resultJson: storedResult ? JSON.parse(JSON.stringify(storedResult)) : undefined,
            resultS3Key,
            finishedAt: new Date(),
            metrics: {
                runtimeMs,
                outputSizeBytes,
                pointsCount: simResult?.meta.pointsCount,
            },
        },
    });
}

/**
 * Handle failed simulation
 */
async function handleFailure(jobId: string, result: SimulationJobResult): Promise<void> {
    const { stdout, stderr, runtimeMs, error } = result;

    const status = error?.includes('timed out') ? 'TIMED_OUT' : 'FAILED';

    await prisma.simulationJob.update({
        where: { id: jobId },
        data: {
            status,
            stdout: stdout.substring(0, 10000),
            stderr: (stderr + '\n' + (error || '')).substring(0, 10000),
            finishedAt: new Date(),
            metrics: {
                runtimeMs,
                error,
            },
        },
    });
}