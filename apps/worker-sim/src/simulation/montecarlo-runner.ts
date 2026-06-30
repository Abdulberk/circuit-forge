/**
 * Monte-Carlo YIELD batch runner (worker side). The pure orchestration (variant draw, criteria eval,
 * adaptive-N, Wilson CI, three-way accounting) lives in eda-core's runMonteCarlo; THIS file supplies the
 * real ngspice VariantRunner and the worker-only concerns the design review flagged:
 *   - one job dir reused across all variants; STALE-CSV SAFETY: output.csv/stdout.log deleted before EVERY
 *     spawn, so a variant that produces no file can't silently read the previous variant's result;
 *   - OOM-GUARD: each variant is reduced to per-node measurements immediately and the raw series discarded
 *     (never accumulate 300 full SimulationResults);
 *   - a per-batch wall-clock BUDGET (shouldStop) so a slow batch can't hold a worker slot indefinitely —
 *     on a hit it returns an HONEST partial (the real evaluated count, never a claimed N);
 *   - a non-convergent / errored variant is counted ERRORED (excluded from the yield denominator), never a
 *     spec failure — we can't tell a solver hiccup from a genuinely-broken corner, so we exclude it (and the
 *     `errored` count surfaces it). Reuses the IDENTICAL sandboxed executeNgspice as a normal sim.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from '../config';
import { logger } from '../logger';
import {
    generateNetlist,
    sanitizeNetlist,
    extractProbes,
    parseSimulationOutput,
    parseFourierLog,
    attachFourierThd,
    summarizeSeries,
    runMonteCarlo,
    type CircuitJson,
    type AnalysisConfig,
    type AcceptanceCriterion,
    type SimMeasurement,
    type MonteCarloYield,
} from '@circuit-forge/eda-core';
import { executeNgspice } from './runner';

export interface MonteCarloBatchInput {
    jobId: string;
    circuit: CircuitJson;
    analysis: AnalysisConfig;
    criteria: AcceptanceCriterion[];
    /** Max variants (default config.MC_N_DEFAULT, capped at 300 by the orchestrator). */
    n?: number;
    seed?: number;
    modelFiles?: Array<{ name: string; content: Buffer }>;
}

export interface MonteCarloBatchResult extends MonteCarloYield {
    runtimeMs: number;
    /** True when the per-batch wall-clock budget cut the run short (the reported counts are still honest). */
    budgetHit: boolean;
}

/**
 * Run a Monte-Carlo yield batch for a (verified) design. `onProgress(ran)` is invoked after each variant so
 * the caller can checkpoint. Never throws on a sim fault — a dead ngspice just yields all-errored (the API
 * then reports "yield unavailable"). Cleans up its job dir.
 */
export async function runMonteCarloBatch(
    input: MonteCarloBatchInput,
    onProgress?: (ran: number) => void,
): Promise<MonteCarloBatchResult> {
    const startTime = Date.now();
    const jobDir = path.join(config.SIM_TEMP_DIR, `${input.jobId}-mc`);
    const netlistPath = path.join(jobDir, 'circuit.cir');
    const outputPath = path.join(jobDir, 'output.csv');
    const logPath = path.join(jobDir, 'stdout.log');
    const deadline = startTime + config.MC_BATCH_BUDGET_MS;
    let budgetHit = false;

    await fs.mkdir(jobDir, { recursive: true });
    // Legacy two-user mode needs the dropped ngspice user to write here; single-uid keeps tight perms.
    if (config.SIM_SANDBOX_USER) await fs.chmod(jobDir, 0o777).catch(() => undefined);

    // Model files are identical across variants — write them once.
    if (input.modelFiles) {
        for (const m of input.modelFiles) await fs.writeFile(path.join(jobDir, m.name), m.content);
    }

    const runVariant = async (variant: CircuitJson): Promise<SimMeasurement[] | null> => {
        let netlist: string;
        try {
            netlist = sanitizeNetlist(generateNetlist(variant, input.analysis), jobDir);
        } catch {
            return null; // a variant that won't even generate/sanitize — count errored, never crash the batch
        }
        // STALE-CSV SAFETY: clear the prior variant's artifacts so a no-output run can't read them.
        await fs.rm(outputPath, { force: true }).catch(() => undefined);
        await fs.rm(logPath, { force: true }).catch(() => undefined);
        await fs.writeFile(netlistPath, netlist);

        const { exitCode, timedOut, spawnError } = await executeNgspice(netlistPath);
        if (spawnError || timedOut || exitCode !== 0) return null; // couldn't evaluate this corner → errored

        let csv: string;
        try {
            csv = await fs.readFile(outputPath, 'utf-8');
        } catch {
            return null; // ngspice exited 0 but emitted no data (degenerate / non-converging) → errored
        }
        if (Buffer.byteLength(csv) > config.SIM_MAX_OUTPUT_BYTES) return null;

        const probes = extractProbes(netlist);
        const result = parseSimulationOutput(csv, probes, input.analysis.type);
        // OOM-GUARD: collapse to scalar measurements now; `result.series` is dropped when this returns.
        const measurements = result.series.map((s) => summarizeSeries(s, input.analysis.type));
        // ROBUST-THD: fold each variant's THD (from a fourier request) onto its measurements so a `thd` criterion
        // is evaluated PER VARIANT — without this the THD-gate would pass at nominal but the robustness tier would
        // stay 'unknown' on the THD dimension. The fourier output is in the listing (logPath), not the CSV.
        if (input.analysis.type === 'tran' && input.analysis.fourier) {
            const listing = await fs.readFile(logPath, 'utf-8').catch(() => '');
            attachFourierThd(measurements, parseFourierLog(listing));
        }
        return measurements;
    };

    try {
        const summary = await runMonteCarlo(input.circuit, input.criteria, runVariant, {
            n: input.n ?? config.MC_N_DEFAULT,
            seed: input.seed ?? 1,
            ciStopHalfWidth: config.MC_CI_HALFWIDTH_STOP,
            shouldStop: () => {
                if (Date.now() > deadline) {
                    budgetHit = true;
                    return true;
                }
                return false;
            },
            onProgress,
        });
        logger.info(
            { jobId: input.jobId, ran: summary.ran, evaluated: summary.evaluated, yield: summary.yield, budgetHit },
            'Monte-Carlo batch complete',
        );
        return { ...summary, runtimeMs: Date.now() - startTime, budgetHit };
    } finally {
        await fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
