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
import { config } from '../config';
import { logger } from '../logger';
import {
    runMonteCarlo,
    type CircuitJson,
    type AnalysisConfig,
    type AcceptanceCriterion,
    type MonteCarloYield,
} from '@circuit-forge/eda-core';
import { withVariantJobDir } from './job-dir';

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
    const deadline = startTime + config.MC_BATCH_BUDGET_MS;
    let budgetHit = false;

    // The per-variant ngspice execution (stale-CSV safety, OOM guard, THD/gain fold) + the reused job dir are
    // shared with the sweep/corner batches (see job-dir.ts + variant-runner.ts). MC only differs in HOW variants
    // are drawn (random).
    const summary = await withVariantJobDir(input.jobId, 'mc', input.analysis, input.modelFiles, async (runVariant) => {
        const s = await runMonteCarlo(input.circuit, input.criteria, runVariant, {
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
            { jobId: input.jobId, ran: s.ran, evaluated: s.evaluated, yield: s.yield, budgetHit },
            'Monte-Carlo batch complete',
        );
        return s;
    });
    return { ...summary, runtimeMs: Date.now() - startTime, budgetHit };
}
