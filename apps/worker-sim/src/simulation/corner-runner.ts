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
import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from '../config';
import { logger } from '../logger';
import {
    runWorstCase,
    type CircuitJson,
    type AnalysisConfig,
    type AcceptanceCriterion,
    type CornerSpec,
    type WorstCaseResult,
} from '@circuit-forge/eda-core';
import { makeVariantRunner } from './variant-runner';

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
    const jobDir = path.join(config.SIM_TEMP_DIR, `${input.jobId}-corner`);

    await fs.mkdir(jobDir, { recursive: true });
    // Legacy two-user mode needs the dropped ngspice user to write here; single-uid keeps tight perms.
    if (config.SIM_SANDBOX_USER) await fs.chmod(jobDir, 0o777).catch(() => undefined);

    // Model files are identical across every corner — write them once.
    if (input.modelFiles) {
        for (const m of input.modelFiles) await fs.writeFile(path.join(jobDir, m.name), m.content);
    }

    const runVariant = makeVariantRunner(jobDir, input.analysis);

    try {
        const result = await runWorstCase(input.circuit, input.criteria, input.corner, runVariant);
        logger.info(
            { jobId: input.jobId, cornered: result.componentsCornered, evaluated: result.evaluated, passAllCorners: result.passAllCorners, omitted: result.omitted.length },
            'Worst-case corner batch complete',
        );
        return { ...result, runtimeMs: Date.now() - startTime };
    } finally {
        await fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
