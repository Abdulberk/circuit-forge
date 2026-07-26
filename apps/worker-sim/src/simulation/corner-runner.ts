/**
 * Worst-case (corner) batch runner (worker side) — the deterministic tolerance-EXTREME sibling of
 * montecarlo-runner.ts / sweep-runner.ts. The pure orchestration (2^k corner enumeration, criteria eval,
 * passAllCorners, failing-corner reporting, three-way accounting) lives in eda-core's runWorstCase; THIS file
 * supplies the real-ngspice per-variant runner (shared via variant-runner.ts) and the one reused job dir.
 *
 * Corner count is 2^k in the number of cornered components — bounded by eda-core's maxComponents cap (default 8
 * ⇒ ≤256 corners). A caller with many toleranced parts should pre-rank the most influential ones (e.g. via a
 * `.sens` run) and pass them in `corner.components`; that sensitivity-guided selection is a caller-side concern.
 */
import {
    runWorstCase,
    extraProbesForCriteria,
    type CircuitJson,
    type AnalysisConfig,
    type AcceptanceCriterion,
    type CornerSpec,
    type WorstCaseResult,
} from '@circuit-forge/eda-core';

import { logger } from '../logger';

import { withVariantJobDir } from './job-dir';

export interface CornerBatchInput {
    jobId: string;
    circuit: CircuitJson;
    analysis: AnalysisConfig;
    criteria: AcceptanceCriterion[];
    corner: CornerSpec;
    modelFiles?: Array<{ name: string; content: Buffer }>;
}

export interface CornerBatchResult extends WorstCaseResult {
    runtimeMs: number;
}

/**
 * Run a worst-case corner analysis against real ngspice, one job dir reused across all corners. Never throws on
 * a sim fault — a corner that can't run is counted `errored` (see runWorstCase). Returns the WorstCaseResult
 * (passAllCorners + failing corners + per-corner outcomes) plus runtime.
 */
export async function runCornerBatch(input: CornerBatchInput): Promise<CornerBatchResult> {
    const startTime = Date.now();

    // Reused job dir + shared per-variant runner (stale-CSV safety, OOM guard) — see job-dir.ts / variant-runner.ts.
    // Union the SAME criterion probes the nominal verify path saves (branch currents), so a current criterion is
    // measured at every corner instead of reading "probe not found" → every corner falsely failing.
    const extraProbes = extraProbesForCriteria(input.criteria);
    const result = await withVariantJobDir(input.jobId, 'corner', input.analysis, extraProbes, input.modelFiles, async (runVariant) => {
        const r = await runWorstCase(input.circuit, input.criteria, input.corner, runVariant);
        logger.info(
            { jobId: input.jobId, cornered: r.componentsCornered, evaluated: r.evaluated, passAllCorners: r.passAllCorners, omitted: r.omitted.length },
            'Worst-case corner batch complete',
        );
        return r;
    });
    return { ...result, runtimeMs: Date.now() - startTime };
}
