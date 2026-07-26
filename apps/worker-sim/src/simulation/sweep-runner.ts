/**
 * Parametric-sweep batch runner (worker side) — the DETERMINISTIC sibling of montecarlo-runner.ts. The pure
 * orchestration (variant generation, criteria eval, passAll/passRange, three-way accounting) lives in eda-core's
 * runParametricSweep; THIS file supplies the real-ngspice per-variant runner (shared with MC via variant-runner.ts)
 * and the worker-only concerns: one reused job dir, and a hard cap on the number of swept points so a runaway
 * sweep (e.g. a 10 000-point dec range) can't hold a worker slot indefinitely.
 */
import {
    runParametricSweep,
    extraProbesForCriteria,
    type CircuitJson,
    type AnalysisConfig,
    type AcceptanceCriterion,
    type SweepSpec,
    type SweepResult,
} from '@circuit-forge/eda-core';

import { logger } from '../logger';

import { withVariantJobDir } from './job-dir';

/** Hard cap on swept points (mirrors runMonteCarlo's 300-variant cap) — a runaway sweep can't spin forever. */
const MAX_SWEEP_POINTS = 100;

export interface SweepBatchInput {
    jobId: string;
    circuit: CircuitJson;
    analysis: AnalysisConfig;
    criteria: AcceptanceCriterion[];
    sweep: SweepSpec;
    modelFiles?: Array<{ name: string; content: Buffer }>;
}

export interface SweepBatchResult extends SweepResult {
    runtimeMs: number;
    /** True when the requested sweep exceeded MAX_SWEEP_POINTS and was clamped (honest: fewer points ran). */
    clamped: boolean;
}

/** Clamp a sweep spec to at most MAX_SWEEP_POINTS points (truncate an explicit list, or cap a generated range). */
function clampSpec(spec: SweepSpec): { spec: SweepSpec; clamped: boolean } {
    if (spec.values && spec.values.length > MAX_SWEEP_POINTS) {
        return { spec: { ...spec, values: spec.values.slice(0, MAX_SWEEP_POINTS) }, clamped: true };
    }
    if (spec.points && spec.points > MAX_SWEEP_POINTS) {
        return { spec: { ...spec, points: MAX_SWEEP_POINTS }, clamped: true };
    }
    return { spec, clamped: false };
}

/**
 * Run a parametric sweep against real ngspice, one job dir reused across all points. Never throws on a sim
 * fault — a point that can't run is counted `errored` (see runParametricSweep). Returns the SweepResult
 * (passAll + passRange + per-point outcomes) plus runtime and whether the point count was clamped.
 */
export async function runSweepBatch(input: SweepBatchInput): Promise<SweepBatchResult> {
    const startTime = Date.now();
    const { spec, clamped } = clampSpec(input.sweep);

    // Reused job dir + shared per-variant runner (stale-CSV safety, OOM guard) — see job-dir.ts / variant-runner.ts.
    // Union the SAME criterion probes the nominal verify path saves (branch currents), so a current criterion is
    // measured at every swept point instead of reading "probe not found".
    const extraProbes = extraProbesForCriteria(input.criteria);
    const result = await withVariantJobDir(
        input.jobId,
        'sweep',
        input.analysis,
        extraProbes,
        input.modelFiles,
        async (runVariant) => {
            const r = await runParametricSweep(input.circuit, input.criteria, spec, runVariant);
            logger.info(
                {
                    jobId: input.jobId,
                    parameter: r.parameter,
                    evaluated: r.evaluated,
                    passed: r.passed,
                    passAll: r.passAll,
                    clamped,
                },
                'Parametric sweep complete',
            );
            return r;
        },
    );
    return { ...result, runtimeMs: Date.now() - startTime, clamped };
}
