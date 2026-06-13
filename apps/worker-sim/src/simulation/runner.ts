/**
 * ngspice Simulation Runner
 * Executes ngspice simulations in isolated job directories
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from '../config';
import { logger } from '../logger';
import {
    parseSimulationOutput,
    sanitizeNetlist,
    extractProbes,
    parseSpiceValue,
    diagnoseConvergence,
    convergenceRemedyLadder,
    applySolverOptions,
} from '@circuit-forge/eda-core';
import type { SimulationResult, ConvergenceReport } from '@circuit-forge/eda-core';
import { sandboxedCommand, resolveSandboxConfig } from './sandbox';

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
    /** True when the failure is INFRASTRUCTURE/setup — ngspice couldn't be launched (bad NGSPICE_PATH /
     *  missing sandbox), or an fs/mkdir/writeFile/parse error — NOT a genuine ngspice result. The API
     *  maps this to an 'inconclusive' verify verdict: an infra outage must never be reported to the user
     *  as a design failure. */
    infra?: boolean;
    /** True when ngspice was SIGKILL'd at the wall-clock SIM_TIMEOUT_MS (a terminal sim outcome → status
     *  TIMED_OUT). Used to STOP escalating the remedy ladder: a too-slow run only gets slower under heavier
     *  remedies (more Newton iterations / gear), so there's no point burning the rest of the budget. */
    timedOut?: boolean;
    /** Convergence Doctor report — present when the FIRST run hit a convergence-class failure and the
     *  solver-remedy ladder was walked locally (recovered:true with the remedy that fixed it, or
     *  recovered:false with every remedy tried). Persisted in job metrics so the API can surface it. */
    convergence?: ConvergenceReport;
}

/**
 * Run an ngspice simulation
 */
export async function runSimulation(input: SimulationJobInput): Promise<SimulationJobResult> {
    const startTime = Date.now();
    const jobDir = path.join(config.SIM_TEMP_DIR, input.jobId);

    logger.info({ jobId: input.jobId, jobDir }, 'Starting simulation');

    try {
        // Create the isolated per-job directory. Make it group/other-writable so that when ngspice runs
        // as a dedicated low-privilege user (SIM_SANDBOX_USER on Linux), it can still write output.csv
        // here (the worker writes circuit.cir/model files as its own user). No-op on Windows. The dir is
        // an ephemeral per-job temp under SIM_TEMP_DIR and is removed in the finally block.
        await fs.mkdir(jobDir, { recursive: true });
        await fs.chmod(jobDir, 0o777).catch(() => undefined);

        // Sanitize the netlist ONCE. Each convergence-remedy attempt only injects validated `.options`
        // tokens onto this already-sanitized deck (applySolverOptions), so remedies need no re-sanitizing.
        const sanitizedNetlist = sanitizeNetlist(input.netlist, jobDir);
        const netlistPath = path.join(jobDir, 'circuit.cir');

        // Write model files once — they don't change across remedy attempts.
        if (input.modelFiles) {
            for (const model of input.modelFiles) {
                const modelPath = path.join(jobDir, model.name);
                await fs.writeFile(modelPath, model.content);
                logger.debug({ modelPath }, 'Model file written');
            }
        }

        // First (and, on the happy path, only) attempt — the netlist exactly as the API generated it.
        const first = await runOneAttempt(input, netlistPath, sanitizedNetlist, startTime);
        if (first.success) return first;

        // Convergence Doctor (prod path): if ngspice ACTUALLY RAN and failed with a convergence-class
        // error, walk the solver-remedy ladder LOCALLY — re-emit the deck with each remedy's `.options`
        // merged in and re-run ngspice right here (no queue round-trip per remedy). Skipped for infra
        // failures (ngspice never ran — re-running can't help) and for non-convergence faults (bad
        // netlist, wall-clock timeout — remedies can't fix those). Mirrors the inline simulateWithRemedies.
        // Diagnose only the FIRST convergence-looking LINE of ngspice's (possibly multi-KB) -o listing, not
        // the whole blob — so a stray word in the echoed deck / iteration counts can't be misread as a
        // convergence class. Fall back to the constructed `error` (early-truncation / no-output messages).
        const diag = diagnoseConvergence(firstConvergenceLine(first.stderr) || (first.error ?? ''), input.analysisType);
        if (first.infra || !diag.isConvergence) return first;

        logger.info({ jobId: input.jobId, kind: diag.kind }, 'Convergence failure — walking remedy ladder');
        const ladder = convergenceRemedyLadder(input.analysisType);
        const tried: string[] = [];
        for (const remedy of ladder) {
            const remediedNetlist = applySolverOptions(sanitizedNetlist, remedy.options);
            const retry = await runOneAttempt(input, netlistPath, remediedNetlist, startTime);
            if (retry.success) {
                logger.info({ jobId: input.jobId, remedy: remedy.label }, 'Convergence remedy recovered the run');
                return {
                    ...retry,
                    convergence: {
                        recovered: true,
                        kind: diag.kind,
                        diagnosis: diag.explanation,
                        remedyApplied: remedy.label,
                        rationale: remedy.rationale,
                        attempts: tried.length + 1,
                    },
                };
            }
            // An infra failure mid-ladder (e.g. the spawn died) is NOT a circuit fault — surface it as-is
            // (→ API inconclusive) rather than burying it as a convergence exhaustion.
            if (retry.infra) return retry;
            // A remedy that TIMED OUT means the circuit is too slow to simulate in the budget; escalating
            // to heavier remedies only makes it slower. Stop walking and report the original failure as
            // remedy-resistant (below) rather than burning the rest of the budget on near-certain timeouts.
            if (retry.timedOut) break;
            tried.push(remedy.label);
        }

        // No remedy converged — return the ORIGINAL failure annotated with the diagnosis + what was tried.
        return {
            ...first,
            convergence: { recovered: false, kind: diag.kind, diagnosis: diag.explanation, attempts: tried.length, triedRemedies: tried },
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ jobId: input.jobId, error: errorMessage }, 'Simulation failed');

        return {
            success: false,
            stdout: '',
            stderr: '',
            runtimeMs: Date.now() - startTime,
            // Reached via mkdir / writeFile / readFile / parse throwing — setup/IO, i.e. INFRA, not a
            // circuit fault → the API reports inconclusive, not a design failure.
            infra: true,
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

/** The first line of `text` that diagnoseConvergence classifies as a convergence failure, or '' if none.
 *  Scoping the diagnosis to a single matched line (rather than the whole multi-KB ngspice -o listing)
 *  keeps an incidental keyword in the echoed deck / iteration counts from being read as a convergence
 *  class. Cheap: a handful of anchored regexes per short line. */
function firstConvergenceLine(text: string): string {
    for (const line of text.split('\n')) {
        if (diagnoseConvergence(line).isConvergence) return line.trim();
    }
    return '';
}

/**
 * Run ngspice ONCE on `netlistText` (written to `netlistPath`) and evaluate the outcome into a
 * SimulationJobResult. Holds no ladder logic — runSimulation calls it for the first run and for each
 * remedy attempt. `runtimeMs` is cumulative from `startTime`, i.e. the honest total wall-clock the job
 * spent (across remedies), which is what the metrics + OTel duration should reflect.
 */
async function runOneAttempt(
    input: SimulationJobInput,
    netlistPath: string,
    netlistText: string,
    startTime: number,
): Promise<SimulationJobResult> {
    await fs.writeFile(netlistPath, netlistText);
    const jobDir = path.dirname(netlistPath);

    const { stdout, stderr, exitCode, timedOut, spawnError } = await executeNgspice(netlistPath);

    if (timedOut) {
        return { success: false, stdout, stderr, runtimeMs: Date.now() - startTime, timedOut: true, error: 'Simulation timed out' };
    }

    if (exitCode !== 0) {
        // ngspice writes its detailed listing (including convergence messages like "Timestep too small"
        // and "singular matrix") to the `-o` log file, not always to the stderr pipe. Fold the log tail
        // into stderr so BOTH the Convergence Doctor's diagnosis and the persisted debug info carry the
        // real cause. Skipped on a spawn error (ngspice never ran, so there's no log).
        const logTail = spawnError
            ? ''
            : await fs.readFile(path.join(jobDir, 'stdout.log'), 'utf-8').catch(() => '');
        const fullStderr = logTail ? `${stderr}\n${logTail}`.slice(-8000) : stderr;
        return {
            success: false,
            stdout,
            stderr: fullStderr,
            runtimeMs: Date.now() - startTime,
            // A spawn failure = ngspice NEVER RAN (infra: wrong NGSPICE_PATH, choco GUI shim, missing
            // sandbox), distinct from ngspice running and exiting non-zero (a genuine sim fault).
            ...(spawnError ? { infra: true } : {}),
            error: spawnError
                ? `ngspice could not be launched (check NGSPICE_PATH / sandbox): ${stderr.trim() || 'spawn error'}`
                : `ngspice exited with code ${exitCode}`,
        };
    }

    // Parse output
    const outputPath = path.join(jobDir, 'output.csv');
    let outputContent: string;
    try {
        outputContent = await fs.readFile(outputPath, 'utf-8');
    } catch (e) {
        // ngspice exited 0 but produced no data file — typically a degenerate / non-converging run.
        // Phrase it so diagnoseConvergence recognizes a remediable 'no_output' (the ladder can still help).
        return {
            success: false,
            stdout,
            stderr,
            runtimeMs: Date.now() - startTime,
            error: 'ngspice produced no output file (likely a non-converging or degenerate circuit)',
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
    const emittedProbes = extractProbes(netlistText);
    let probeNames = input.probeNames.length > 0 ? input.probeNames : emittedProbes;
    // The generator can DROP a probe it can't emit (e.g. a current probe on a diode/transistor or a
    // digital a-device). When that happens the caller's explicit list is LONGER than the emitted wrdata
    // columns, and the positional CSV mapping would shift every series. The emitted `wrdata` tokens are
    // the column ground truth, so fall back to them on a count mismatch (a same-count rewrite like
    // i(R1)->@r1[i] keeps the caller's nicer labels, since position still maps correctly).
    if (input.probeNames.length > 0 && emittedProbes.length !== input.probeNames.length) {
        probeNames = emittedProbes;
    }
    const result = parseSimulationOutput(outputContent, probeNames, input.analysisType);

    // Detect a SILENTLY TRUNCATED transient: ngspice can exit 0 yet stop far before the requested
    // stopTime when the adaptive timestep collapses (floating node / hard switching). Fail the attempt
    // instead of persisting a misleading partial result; the message is phrased so the Convergence Doctor
    // treats it as a remediable timestep collapse. stopTime is read from the netlist's .tran card.
    if (input.analysisType === 'tran') {
        const tranMatch = netlistText.match(/^\s*\.tran\s+\S+\s+(\S+)/im);
        let want = 0;
        if (tranMatch && tranMatch[1]) {
            const parsedStop = parseSpiceValue(tranMatch[1]);
            if (parsedStop.isValid) want = parsedStop.value;
        }
        const lastT = Math.max(
            0,
            ...result.series.map((s) => (s.points.length ? s.points[s.points.length - 1]!.x : 0)),
        );
        if (want > 0 && lastT > 0 && lastT < 0.9 * want) {
            return {
                success: false,
                stdout,
                stderr,
                runtimeMs: Date.now() - startTime,
                outputSizeBytes,
                error: `Transient ended early at t=${lastT.toExponential(2)}s of ${tranMatch![1]} (timestep collapse / non-convergence — often a floating node or missing DC path to ground)`,
            };
        }
    }

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
}

/**
 * Execute ngspice with timeout
 */
async function executeNgspice(
    netlistPath: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; spawnError?: boolean }> {
    return new Promise((resolve) => {
        const args = ['-b', '-o', 'stdout.log', netlistPath];
        const cwd = path.dirname(netlistPath);

        // Wrap with OS resource limits (Linux prod) so an untrusted circuit can't OOM/fill-disk/spin
        // the host. No-op (runs ngspice directly) on Windows dev or when SIM_SANDBOX=none.
        const sandbox = resolveSandboxConfig(config);
        const { file, args: spawnArgs } = sandboxedCommand(config.NGSPICE_PATH, args, sandbox);

        logger.debug({ cmd: file, args: spawnArgs, cwd, sandbox: sandbox.mode }, 'Executing ngspice');

        const process: ChildProcess = spawn(file, spawnArgs, {
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
            // spawn failed (ENOENT/EACCES — wrong NGSPICE_PATH, the choco GUI shim, or a missing bash
            // sandbox wrapper). ngspice never ran: flag it as a spawn error so the caller marks the job
            // INFRA (→ inconclusive), not a design failure.
            resolve({
                stdout,
                stderr,
                exitCode: 1,
                timedOut: false,
                spawnError: true,
            });
        });
    });
}