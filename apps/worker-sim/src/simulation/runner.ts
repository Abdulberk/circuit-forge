/**
 * ngspice Simulation Runner
 * Executes ngspice simulations in isolated job directories
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from '../config';
import { logger } from '../logger';
import { parseSimulationOutput, sanitizeNetlist, extractProbes } from '@circuit-forge/eda-core';
import type { SimulationResult } from '@circuit-forge/eda-core';

/**
 * Simulation job input
 */
export interface SimulationJobInput {
    jobId: string;
    netlist: string;
    probeNames: string[];
    analysisType: string;
    modelFiles?: Array<{ name: string; content: Buffer }>;
}

/**
 * Simulation job result
 */
export interface SimulationJobResult {
    success: boolean;
    result?: SimulationResult;
    stdout: string;
    stderr: string;
    runtimeMs: number;
    outputSizeBytes?: number;
    error?: string;
}

/**
 * Run an ngspice simulation
 */
export async function runSimulation(input: SimulationJobInput): Promise<SimulationJobResult> {
    const startTime = Date.now();
    const jobDir = path.join(config.SIM_TEMP_DIR, input.jobId);

    logger.info({ jobId: input.jobId, jobDir }, 'Starting simulation');

    try {
        // Create job directory
        await fs.mkdir(jobDir, { recursive: true });

        // Sanitize netlist
        const sanitizedNetlist = sanitizeNetlist(input.netlist, jobDir);

        // Write netlist file
        const netlistPath = path.join(jobDir, 'circuit.cir');
        await fs.writeFile(netlistPath, sanitizedNetlist);

        // Write model files if provided
        if (input.modelFiles) {
            for (const model of input.modelFiles) {
                const modelPath = path.join(jobDir, model.name);
                await fs.writeFile(modelPath, model.content);
                logger.debug({ modelPath }, 'Model file written');
            }
        }

        // Run ngspice
        const { stdout, stderr, exitCode, timedOut } = await executeNgspice(netlistPath);

        if (timedOut) {
            return {
                success: false,
                stdout,
                stderr,
                runtimeMs: Date.now() - startTime,
                error: 'Simulation timed out',
            };
        }

        if (exitCode !== 0) {
            return {
                success: false,
                stdout,
                stderr,
                runtimeMs: Date.now() - startTime,
                error: `ngspice exited with code ${exitCode}`,
            };
        }

        // Parse output
        const outputPath = path.join(jobDir, 'output.csv');
        let outputContent: string;

        try {
            outputContent = await fs.readFile(outputPath, 'utf-8');
        } catch (e) {
            return {
                success: false,
                stdout,
                stderr,
                runtimeMs: Date.now() - startTime,
                error: 'Simulation output file not found',
            };
        }

        // Check output size
        const outputSizeBytes = Buffer.byteLength(outputContent);
        if (outputSizeBytes > config.SIM_MAX_OUTPUT_BYTES) {
            return {
                success: false,
                stdout,
                stderr,
                runtimeMs: Date.now() - startTime,
                outputSizeBytes,
                error: `Output too large: ${outputSizeBytes} bytes (max: ${config.SIM_MAX_OUTPUT_BYTES})`,
            };
        }

        // Parse the output. If the caller didn't pass probe names (e.g. version-based sims
        // that rely on eda-core's default probes), derive them from the netlist's `wrdata`
        // line so the CSV columns can be mapped to named series instead of an empty result.
        const probeNames =
            input.probeNames.length > 0 ? input.probeNames : extractProbes(sanitizedNetlist);
        const result = parseSimulationOutput(outputContent, probeNames, input.analysisType);

        const runtimeMs = Date.now() - startTime;
        logger.info(
            { jobId: input.jobId, runtimeMs, pointsCount: result.meta.pointsCount },
            'Simulation completed',
        );

        return {
            success: true,
            result,
            stdout,
            stderr,
            runtimeMs,
            outputSizeBytes,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ jobId: input.jobId, error: errorMessage }, 'Simulation failed');

        return {
            success: false,
            stdout: '',
            stderr: '',
            runtimeMs: Date.now() - startTime,
            error: errorMessage,
        };
    } finally {
        // Cleanup job directory
        try {
            await fs.rm(jobDir, { recursive: true, force: true });
            logger.debug({ jobDir }, 'Job directory cleaned up');
        } catch (e) {
            logger.warn({ jobDir, error: e }, 'Failed to cleanup job directory');
        }
    }
}

/**
 * Execute ngspice with timeout
 */
async function executeNgspice(
    netlistPath: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
    return new Promise((resolve) => {
        const args = ['-b', '-o', 'stdout.log', netlistPath];
        const cwd = path.dirname(netlistPath);

        logger.debug({ cmd: config.NGSPICE_PATH, args, cwd }, 'Executing ngspice');

        const process: ChildProcess = spawn(config.NGSPICE_PATH, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: config.SIM_TIMEOUT_MS,
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        process.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        process.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        const timeoutId = setTimeout(() => {
            timedOut = true;
            process.kill('SIGKILL');
        }, config.SIM_TIMEOUT_MS);

        process.on('close', (code) => {
            clearTimeout(timeoutId);
            resolve({
                stdout,
                stderr,
                exitCode: code,
                timedOut,
            });
        });

        process.on('error', (err) => {
            clearTimeout(timeoutId);
            stderr += err.message;
            resolve({
                stdout,
                stderr,
                exitCode: 1,
                timedOut: false,
            });
        });
    });
}