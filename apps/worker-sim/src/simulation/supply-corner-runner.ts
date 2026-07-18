/**
 * Supply-voltage corner batch runner (worker side) — perturbs each trusted power rail's driving source ±tolerance
 * and reports pass/fail + per-node drift vs the nominal run. The pure orchestration (rail validation with the
 * refutation-asymmetry, nominal reference, drift, three-way accounting) lives in eda-core's runSupplyCorner; THIS
 * file supplies the real-ngspice runner + the reused job dir.
 *
 * Unlike the temperature corner (a `.temp` global), a supply corner is a component-VALUE perturbation on the
 * source — exactly what the SHARED variant runner already does — so it reuses withVariantJobDir's runVariant
 * directly (no bespoke runner). INFORMATIONAL: the API keeps it from gating the verdict; a corner the runner
 * can't evaluate is counted `errored`, never a spec failure.
 */
import { logger } from '../logger';
import {
    runSupplyCorner,
    extraProbesForCriteria,
    type CircuitJson,
    type AnalysisConfig,
    type AcceptanceCriterion,
    type SupplyCornerSpec,
    type SupplyCornerResult,
} from '@circuit-forge/eda-core';
import { withVariantJobDir } from './job-dir';

export interface SupplyCornerBatchInput {
    jobId: string;
    circuit: CircuitJson;
    analysis: AnalysisConfig;
    criteria: AcceptanceCriterion[];
    spec: SupplyCornerSpec;
    modelFiles?: Array<{ name: string; content: Buffer }>;
}

export interface SupplyCornerBatchResult extends SupplyCornerResult {
    runtimeMs: number;
}

/**
 * Run a supply-voltage corner analysis against real ngspice, one job dir reused across the nominal + ±tolerance
 * corner runs. Never throws on a sim fault (a dead corner is counted `errored` by runSupplyCorner). Returns the
 * SupplyCornerResult (applicable + rail validations + per-corner outcomes + per-node drift) plus runtime.
 */
export async function runSupplyCornerBatch(input: SupplyCornerBatchInput): Promise<SupplyCornerBatchResult> {
    const startTime = Date.now();
    // UNION the same criterion-derived probes the nominal verify path saves (branch currents), so a current
    // criterion is measured at every corner instead of reading "probe not found" → falsely failing. Node
    // voltages (incl. the rails, needed for drift) are already saved by the generator's default probes.
    const extraProbes = extraProbesForCriteria(input.criteria);
    const result = await withVariantJobDir(input.jobId, 'supplycorner', input.analysis, extraProbes, input.modelFiles, async (runVariant) => {
        const r = await runSupplyCorner(input.circuit, input.criteria, input.spec, runVariant);
        logger.info(
            { jobId: input.jobId, applicable: r.applicable, rails: r.rails.length, evaluated: r.evaluated, passAllCorners: r.passAllCorners },
            'Supply-voltage corner batch complete',
        );
        return r;
    });
    return { ...result, runtimeMs: Date.now() - startTime };
}
