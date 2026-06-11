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
import { generateNetlist, type CircuitJson, type AnalysisConfig } from '@circuit-forge/eda-core';
import { SimulationService } from '../simulation/simulation.service';
import { CatalogGroundingService } from './catalog-grounding.service';
import { attachGenericModels } from './model-resolution';
import { DesignCircuitDto } from './dto';

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

                const { jobId } = await this.simulation.createQuickSim(
                    netlist,
                    analysis as unknown as Record<string, unknown>,
                    userId,
                );
                const status = await this.pollJob(jobId, userId, 90_000);
                const result = (await this.simulation.getResult(jobId, userId)) as {
                    result?: { meta?: { pointsCount?: number } };
                    metrics?: { pointsCount?: number };
                    error?: string;
                };
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
                const succeeded = status.status === 'SUCCEEDED' && pointsCount > 0;
                history.push({ round, status: status.status, pointsCount, jobId });

                if (succeeded) {
                    // Attach authoritative sourcing to the final, simulation-verified circuit.
                    if (groundingOpts) await this.grounding.enrichSourcing(circuit);
                    return {
                        ok: true,
                        circuit,
                        analysisConfig: analysis,
                        explanation,
                        rounds: round,
                        history,
                        simulation: { jobId, status: status.status, metrics: status.metrics, result: result.result },
                    };
                }

                if (round < maxRounds) {
                    const problem =
                        status.status !== 'SUCCEEDED'
                            ? `Simulation ${status.status}. ${result?.error ?? ''}`.trim()
                            : 'Simulation succeeded but produced no data points (pointsCount = 0) — likely a floating node or an analysis that does not excite the circuit.';
                    this.logger.log(`design round ${round} not ok (${status.status}, pts=${pointsCount}); asking AI to fix`);
                    ({ circuit, analysis, explanation } = await this.applyFix(circuit, analysis, problem, llmConfig));
                }
            }

            // Budget exhausted without a clean run — return the best effort + history.
            if (groundingOpts) await this.grounding.enrichSourcing(circuit);
            const last = history[history.length - 1];
            return {
                ok: false,
                circuit,
                analysisConfig: analysis,
                explanation,
                rounds: history.length,
                history,
                simulation: { status: last?.status ?? 'FAILED' },
                warning: 'Could not produce a successful simulation within the round budget.',
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

    private async pollJob(
        jobId: string,
        userId: string,
        timeoutMs: number,
    ): Promise<{ status: string; metrics?: unknown }> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const s = (await this.simulation.getStatus(jobId, userId)) as { status: string; metrics?: unknown };
            if (s.status === 'SUCCEEDED' || s.status === 'FAILED' || s.status === 'TIMED_OUT') return s;
            await new Promise((r) => setTimeout(r, 1000));
        }
        return { status: 'TIMED_OUT' };
    }
}

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
