/**
 * Agentic circuit design: generate → simulate → (on failure) AI-fix → re-simulate, up to N rounds.
 * Closes the loop between the AI generator (llm-core), the netlist generator (eda-core), and the
 * ngspice simulation pipeline (SimulationService / worker).
 */
import {
    Injectable,
    BadGatewayException,
    HttpException,
    ServiceUnavailableException,
    UnprocessableEntityException,
    Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateCircuit, fixCircuit, CircuitGenerationError } from '@circuitforge/llm-core';
import { generateNetlist, type CircuitJson, type AnalysisConfig, type DataSeries } from '@circuit-forge/eda-core';
import { SimulationService } from '../simulation/simulation.service';
import { CatalogGroundingService } from './catalog-grounding.service';
import { attachGenericModels } from './model-resolution';
import { summarizeSeries } from './circuit-simulator.service';
import { evaluateAssertions, describeFailure, type AssertionResult } from './assertions';
import { DesignCircuitDto } from './dto';
import type { AssertionDto } from './dto';

export interface RoundRecord {
    round: number;
    status: string;
    pointsCount: number;
    jobId?: string;
    note?: string;
}

@Injectable()
export class DesignService {
    private readonly logger = new Logger(DesignService.name);
    /** Server-side poll budget (ms) per design round's simulation. Env-tunable (ops) + small in tests so
     *  the "job never consumed → inconclusive" path is fast to exercise. */
    private readonly pollTimeoutMs = Number(process.env.DESIGN_POLL_TIMEOUT_MS) || 90_000;

    constructor(
        private readonly config: ConfigService,
        private readonly simulation: SimulationService,
        private readonly grounding: CatalogGroundingService,
    ) {}

    async design(dto: DesignCircuitDto, userId: string) {
        const apiKey = this.config.get<string>('LLM_API_KEY');
        if (!apiKey) {
            throw new ServiceUnavailableException(
                'AI circuit generation is not configured (LLM_API_KEY is not set).',
            );
        }
        const llmConfig = {
            apiKey,
            baseUrl: this.config.get<string>('LLM_BASE_URL'),
            model: this.config.get<string>('LLM_MODEL'),
            userAgent: this.config.get<string>('LLM_USER_AGENT'),
        };
        const maxRounds = Math.min(Math.max(dto.maxRounds ?? 2, 1), 4);
        // Ground the initial design in the live catalog (same as /generate-circuit) when configured.
        const groundingOpts = this.grounding.grounding();

        try {
            const gen = await generateCircuit({ prompt: dto.prompt, constraints: dto.constraints }, llmConfig, groundingOpts);
            let circuit: CircuitJson = gen.circuit;
            attachGenericModels(circuit); // inject bjt/mosfet model bodies BEFORE the netlist is built
            let analysis: AnalysisConfig = gen.analysisConfig;
            let explanation = gen.explanation;
            const history: RoundRecord[] = [];
            // Acceptance criteria the model derived from the user's intent (e.g. "gain 10" → out pp ≥ 9.5).
            // Captured ONCE from the initial generation (the intent is stable across fix rounds) and checked
            // against EVERY healthy sim — "verified" means these pass, not merely that ngspice ran. Empty
            // when the prompt states no measurable target → behavior is unchanged (sim-ran = best effort).
            const criteria = (gen.acceptanceCriteria ?? []) as AssertionDto[];
            let lastAssertions: AssertionResult[] = [];

            for (let round = 1; round <= maxRounds; round++) {
                // Build the netlist; a throw here is itself a fixable problem.
                let netlist: string;
                try {
                    netlist = generateNetlist(circuit, analysis);
                } catch (e) {
                    history.push({ round, status: 'NETLIST_ERROR', pointsCount: 0, note: errMsg(e) });
                    if (round >= maxRounds) break;
                    ({ circuit, analysis, explanation } = await this.applyFix(circuit, analysis, `Netlist generation failed: ${errMsg(e)}`, llmConfig));
                    continue;
                }

                // Run the sim on the worker. Transport/infra errors (queue/Redis/DB) and operational
                // outcomes (job never consumed → POLL_TIMEOUT, or CANCELED) are NOT circuit faults: they
                // must not be fed to the LLM as something to "fix", nor reported as "design failed".
                // Handle them as INCONCLUSIVE — return the generated, sim-unverified circuit + try-again.
                let jobId: string;
                let status: { status: string; metrics?: unknown };
                let result: {
                    result?: { meta?: { pointsCount?: number }; series?: DataSeries[] };
                    metrics?: { pointsCount?: number };
                    error?: string;
                };
                try {
                    ({ jobId } = await this.simulation.createQuickSim(
                        netlist,
                        analysis as unknown as Record<string, unknown>,
                        userId,
                    ));
                    status = await this.pollJob(jobId, userId, this.pollTimeoutMs);
                    if (status.status === 'POLL_TIMEOUT' || status.status === 'CANCELED') {
                        history.push({ round, status: status.status, pointsCount: 0, jobId, note: 'simulation capacity unavailable' });
                        return this.inconclusive(circuit, analysis, explanation, history, groundingOpts,
                            'Simulation capacity was unavailable, so the design could not be verified — try again. The circuit was generated but its simulation checks did not run.');
                    }
                    result = (await this.simulation.getResult(jobId, userId)) as typeof result;
                } catch (e) {
                    if (e instanceof HttpException) throw e; // 429 QUOTA_EXCEEDED etc. carry intent — keep them
                    this.logger.error(`design round ${round} simulation infrastructure error: ${errMsg(e)}`);
                    history.push({ round, status: 'INFRA_ERROR', pointsCount: 0, note: errMsg(e) });
                    return this.inconclusive(circuit, analysis, explanation, history, groundingOpts,
                        'Simulation could not be run (worker/queue unavailable), so the design could not be verified — try again.');
                }

                // The worker tags pre/around-ngspice INFRA failures (bad NGSPICE_PATH/spawn, S3 model
                // download, DB, result upload) as status FAILED + metrics.failureClass='infra' (the
                // SimJobStatus enum has no operational value). That's an OPERATIONAL outcome, NOT a circuit
                // fault — same contract as POLL_TIMEOUT above; don't feed it to the LLM (mirror
                // verification.service.ts). Genuine ngspice faults carry 'sim' (or nothing on older rows).
                const failureClass = (status.metrics as { failureClass?: string } | undefined)?.failureClass;
                if (status.status !== 'SUCCEEDED' && failureClass === 'infra') {
                    history.push({ round, status: status.status, pointsCount: 0, jobId, note: 'worker infrastructure error' });
                    return this.inconclusive(circuit, analysis, explanation, history, groundingOpts,
                        'The worker could not run the simulation (infrastructure error), so the design could not be verified — try again.');
                }

                // pointsCount lives in `metrics` (always persisted by the worker). The full
                // `resultJson` — and thus `result.meta` — is undefined when the worker offloads
                // large results (>1MB) to S3, so reading it there falsely reports 0 points and
                // breaks the loop on big-but-valid simulations. Prefer metrics; fall back to meta.
                const statusMetrics = status.metrics as { pointsCount?: number } | undefined;
                const pointsCount =
                    statusMetrics?.pointsCount ??
                    result?.metrics?.pointsCount ??
                    result?.result?.meta?.pointsCount ??
                    0;
                const simHealthy = status.status === 'SUCCEEDED' && pointsCount > 0;

                // Check the design against the user's INTENT: a healthy sim that does NOT meet the acceptance
                // criteria is a real, fixable design fault — not a "verified" design. (No criteria → vacuously
                // met via [].every, so behavior is unchanged for prompts with no measurable numeric target.)
                if (simHealthy && criteria.length > 0) {
                    const measurements = (result.result?.series ?? []).map(summarizeSeries);
                    if (measurements.length === 0 && result?.error) {
                        // SUCCEEDED with data points (per metrics) but NO series AND getResult flagged an
                        // error → the worker offloaded the result to S3 and it couldn't be fetched here. We
                        // can't check the spec, so this is INCONCLUSIVE (a storage issue is never a design
                        // fault) — not "specs failed". Keyed on result.error to stay in lock-step with
                        // verification.service (a genuinely empty series with NO error falls through to a
                        // normal — all-unmet — evaluation, the same as a degenerate no-data fault there).
                        history.push({ round, status: status.status, pointsCount, jobId, note: 'results unavailable to check specs' });
                        return this.inconclusive(circuit, analysis, explanation, history, groundingOpts,
                            'The simulation ran but its results were unavailable to check the design specifications — try again.');
                    }
                    lastAssertions = evaluateAssertions(measurements, criteria);
                }
                const specsMet = lastAssertions.every((a) => a.pass);
                const succeeded = simHealthy && specsMet;
                history.push({
                    round,
                    status: status.status,
                    pointsCount,
                    jobId,
                    note: !simHealthy
                        ? undefined
                        : criteria.length === 0
                            ? 'no acceptance criteria'
                            : specsMet
                                ? 'all acceptance criteria met'
                                : `${lastAssertions.filter((a) => !a.pass).length}/${lastAssertions.length} acceptance criteria unmet`,
                });

                if (succeeded) {
                    // Attach authoritative sourcing to the final, simulation-AND-spec-verified circuit.
                    if (groundingOpts) await this.grounding.enrichSourcing(circuit);
                    return {
                        ok: true,
                        verified: criteria.length > 0, // true = checked against acceptance criteria AND met
                        circuit,
                        analysisConfig: analysis,
                        explanation,
                        acceptanceCriteria: criteria,
                        assertions: lastAssertions,
                        rounds: round,
                        history,
                        simulation: { jobId, status: status.status, metrics: status.metrics, result: result.result },
                    };
                }

                // Not done → ask the AI to fix. Two genuinely-fixable fault classes (operational outcomes
                // were already returned as inconclusive above):
                //   (1) the sim itself failed (FAILED / terminal TIMED_OUT, or 0 points) — a circuit fault;
                //       enrich the problem with the worker's Convergence Doctor diagnosis when present.
                //   (2) the sim is healthy but the measured behavior MISSES the spec — feed the failing
                //       criteria WITH how-far-off so the model knows marginal (4.99 vs 5) from catastrophic (3 vs 10).
                if (round < maxRounds) {
                    let problem: string;
                    if (!simHealthy) {
                        problem =
                            status.status !== 'SUCCEEDED'
                                ? `Simulation ${status.status}. ${result?.error ?? ''}`.trim()
                                : 'Simulation succeeded but produced no data points (pointsCount = 0) — likely a floating node or an analysis that does not excite the circuit.';
                        const conv = (status.metrics as { convergence?: { diagnosis?: string; triedRemedies?: string[] } } | undefined)?.convergence;
                        if (conv?.diagnosis) {
                            problem += ` Solver diagnosis: ${conv.diagnosis}${conv.triedRemedies?.length ? ` (already tried: ${conv.triedRemedies.join('; ')})` : ''}`;
                        }
                    } else {
                        const failed = lastAssertions.filter((a) => !a.pass);
                        problem =
                            'The circuit simulates cleanly but does NOT meet the required specification(s):\n' +
                            failed.map((f) => `- ${describeFailure(f)}`).join('\n') +
                            '\nRevise the design so these are satisfied; keep the parts that already pass.';
                    }
                    this.logger.log(`design round ${round} not ok (status=${status.status}, pts=${pointsCount}, specsMet=${specsMet}); asking AI to fix`);
                    ({ circuit, analysis, explanation } = await this.applyFix(circuit, analysis, problem, llmConfig));
                }
            }

            // Budget exhausted without a clean, spec-meeting run — return the best effort + history. If the
            // sim was healthy but the spec wasn't met, say so honestly (NOT "verified"), surfacing the gaps.
            if (groundingOpts) await this.grounding.enrichSourcing(circuit);
            const last = history[history.length - 1];
            // Only call it a spec-miss if the FINAL round actually simulated — otherwise lastAssertions is
            // stale from an earlier healthy round and the honest reason is "couldn't simulate".
            const lastRoundHealthy = last?.status === 'SUCCEEDED' && (last?.pointsCount ?? 0) > 0;
            const specMiss = lastRoundHealthy && lastAssertions.length > 0 && lastAssertions.some((a) => !a.pass);
            return {
                ok: false,
                verified: false,
                circuit,
                analysisConfig: analysis,
                explanation,
                acceptanceCriteria: criteria,
                assertions: lastAssertions,
                rounds: history.length,
                history,
                simulation: { status: last?.status ?? 'FAILED' },
                warning: specMiss
                    ? 'The circuit simulates but did not meet all acceptance criteria within the round budget.'
                    : 'Could not produce a successful simulation within the round budget.',
            };
        } catch (err) {
            // HTTP errors from nested services carry intent — most importantly the structured 429
            // QUOTA_EXCEEDED from the sim quota gate — and must reach the client untranslated.
            if (err instanceof HttpException) throw err;
            if (err instanceof CircuitGenerationError) {
                if (err.code === 'invalid_output') throw new UnprocessableEntityException(err.message);
                if (err.code === 'config') throw new ServiceUnavailableException(err.message);
                throw new BadGatewayException(err.message);
            }
            throw new BadGatewayException('Circuit design failed.');
        }
    }

    private async applyFix(
        circuit: CircuitJson,
        analysis: AnalysisConfig,
        problem: string,
        llmConfig: Parameters<typeof fixCircuit>[1],
    ): Promise<{ circuit: CircuitJson; analysis: AnalysisConfig; explanation?: string }> {
        const fixed = await fixCircuit({ circuit, analysisConfig: analysis, problem }, llmConfig);
        attachGenericModels(fixed.circuit); // re-inject model bodies after a fix round
        return { circuit: fixed.circuit, analysis: fixed.analysisConfig, explanation: fixed.explanation };
    }

    /** Operational outcome (no verdict): the sim couldn't run — worker/queue unavailable or the job was
     *  never consumed. Return the AI-generated circuit honestly as sim-UNVERIFIED (ok:false + inconclusive)
     *  so the client can retry — rather than asking the LLM to "fix" a sound design or claiming it failed. */
    private async inconclusive(
        circuit: CircuitJson,
        analysis: AnalysisConfig,
        explanation: string | undefined,
        history: RoundRecord[],
        grounding: unknown,
        warning: string,
    ) {
        if (grounding) await this.grounding.enrichSourcing(circuit);
        return {
            ok: false,
            inconclusive: true,
            circuit,
            analysisConfig: analysis,
            explanation,
            rounds: history.length,
            history,
            simulation: { status: history[history.length - 1]?.status ?? 'UNAVAILABLE' },
            warning,
        };
    }

    private async pollJob(
        jobId: string,
        userId: string,
        timeoutMs: number,
    ): Promise<{ status: string; metrics?: unknown }> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const s = (await this.simulation.getStatus(jobId, userId)) as { status: string; metrics?: unknown };
            if (s.status === 'SUCCEEDED' || s.status === 'FAILED' || s.status === 'TIMED_OUT' || s.status === 'CANCELED') return s;
            await new Promise((r) => setTimeout(r, 1000));
        }
        // Budget exhausted without a terminal state = nothing consumed the job (no worker / queue backlog).
        // Distinct sentinel — NOT a terminal 'TIMED_OUT' (where ngspice actually ran) — so the caller treats
        // it as an OPERATIONAL outcome, not a circuit fault to feed back to the LLM.
        return { status: 'POLL_TIMEOUT' };
    }
}

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
