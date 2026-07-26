/**
 * Temperature-corner batch runner (worker side) — the AMBIENT-temperature sibling of corner-runner.ts. The pure
 * orchestration (per-temperature evaluation, per-node drift, applicable/not-applicable, three-way accounting) lives
 * in eda-core's runTempCorner; THIS file supplies the real-ngspice per-temperature runner (makeTempRunner, which
 * shares the execution/parse core with the variant runner) and reuses ONE job dir via withVariantJobDir.
 *
 * INFORMATIONAL + ambient-only: never gates the verdict (the API keeps it informational; the ambient-only ceiling
 * makes gating unjustifiable). A temperature the runner can't evaluate is counted `errored`, never a spec failure.
 */
import {
    runTempCorner,
    extraProbesForCriteria,
    type CircuitJson,
    type AnalysisConfig,
    type AcceptanceCriterion,
    type TempCornerSpec,
    type TempCornerResult,
} from '@circuit-forge/eda-core';

import { logger } from '../logger';

import { withVariantJobDir } from './job-dir';
import { makeTempRunner } from './variant-runner';

export interface TempCornerBatchInput {
    jobId: string;
    circuit: CircuitJson;
    analysis: AnalysisConfig;
    criteria: AcceptanceCriterion[];
    spec: TempCornerSpec;
    modelFiles?: Array<{ name: string; content: Buffer }>;
}

export interface TempCornerBatchResult extends TempCornerResult {
    runtimeMs: number;
}

/**
 * Run an ambient temperature-corner analysis against real ngspice, one job dir reused across all temperatures.
 * Never throws on a sim fault — a temperature that can't run is counted `errored` (see runTempCorner). Returns the
 * TempCornerResult (applicable + per-temperature outcomes + per-node drift) plus runtime.
 */
export async function runTempCornerBatch(input: TempCornerBatchInput): Promise<TempCornerBatchResult> {
    const startTime = Date.now();
    // UNION the same criterion-derived probes the nominal verify path saves (branch currents), so a current
    // criterion is measured at every temperature instead of reading "probe not found" → falsely failing.
    const extraProbes = extraProbesForCriteria(input.criteria);
    const result = await withVariantJobDir(input.jobId, 'tempcorner', input.analysis, extraProbes, input.modelFiles, async (_runVariant, jobDir) => {
        // The temperature runner varies the ambient `.temp` on the FIXED circuit (not component values), so it
        // uses makeTempRunner rather than the variant runner withVariantJobDir prepared. Same job dir + core.
        const runAtTemp = makeTempRunner(jobDir, input.circuit, input.analysis, extraProbes);
        const r = await runTempCorner(input.circuit, input.criteria, input.spec, runAtTemp);
        logger.info(
            { jobId: input.jobId, applicable: r.applicable, evaluated: r.evaluated, passAllTemps: r.passAllTemps, temps: r.temperaturesC },
            'Temperature-corner batch complete',
        );
        return r;
    });
    return { ...result, runtimeMs: Date.now() - startTime };
}
