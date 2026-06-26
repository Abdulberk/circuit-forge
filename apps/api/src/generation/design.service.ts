/**
 * Agentic circuit design (POST /design-circuit + the async /design-jobs runner). The loop ITSELF now lives in
 * llm-core (`runDesignLoop`) so the API and the (future) design-queue worker run the IDENTICAL intelligence.
 * This service is the API HOST: it builds the LLM config from ConfigService, injects the NestJS-backed
 * dependencies (SimulationService as the sim surface, CatalogGroundingService as grounding), and maps the
 * loop's framework-free errors onto HTTP exceptions. The synchronous path never aborts mid-loop
 * (isAborted → false); the async queue worker supplies a real abort check.
 */
import {
    Injectable,
    Logger,
    BadGatewayException,
    HttpException,
    ServiceUnavailableException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { runDesignLoop, DesignAbortedError, CircuitGenerationError } from '@circuitforge/llm-core';
import { SimulationService } from '../simulation/simulation.service';
import { CatalogGroundingService } from './catalog-grounding.service';
import { DesignCircuitDto } from './dto';

@Injectable()
export class DesignService {
    private readonly logger = new Logger(DesignService.name);
    /** Server-side poll budget (ms) per design round's simulation. Env-tunable (ops). */
    private readonly pollTimeoutMs = Number(process.env.DESIGN_POLL_TIMEOUT_MS) || 90_000;

    constructor(
        private readonly config: ConfigService,
        private readonly simulation: SimulationService,
        private readonly grounding: CatalogGroundingService,
    ) {}

    async design(dto: DesignCircuitDto, userId: string) {
        const apiKey = this.config.get<string>('LLM_API_KEY');
        if (!apiKey) {
            throw new ServiceUnavailableException('AI circuit generation is not configured (LLM_API_KEY is not set).');
        }
        // Optional operator overrides; llm-core applies sane defaults (90s / 300k) when unset/invalid.
        const num = (key: string): number | undefined => {
            const raw = this.config.get<string>(key);
            const n = raw === undefined ? NaN : Number(raw);
            return Number.isFinite(n) && n > 0 ? n : undefined;
        };
        const llmConfig = {
            apiKey,
            baseUrl: this.config.get<string>('LLM_BASE_URL'),
            model: this.config.get<string>('LLM_MODEL'),
            userAgent: this.config.get<string>('LLM_USER_AGENT'),
            timeoutMs: num('LLM_TIMEOUT_MS'),
            tokenBudget: num('LLM_TOKEN_BUDGET'),
            // Count every BILLED provider request (incl. the transient retry) on the grounded SYNC design
            // loop, so a controlled run can be reconciled against the request-billed invoice. Tagged 'api:design'.
            onLlmRequest: (info: { iter: number; attempt: number; toolsOffered: boolean }) =>
                this.logger.log(
                    `llm.request path=api:design iter=${info.iter} attempt=${info.attempt} tools=${info.toolsOffered}`,
                ),
        };

        try {
            return await runDesignLoop(
                { prompt: dto.prompt, constraints: dto.constraints, maxRounds: dto.maxRounds },
                {
                    llmConfig,
                    runSim: this.simulation,
                    ground: this.grounding,
                    userId,
                    pollTimeoutMs: this.pollTimeoutMs,
                    mcEnabled: this.config.get<string>('DESIGN_MC_ENABLED') !== 'false',
                    mcRuns: Number(this.config.get<string>('DESIGN_MC_RUNS')) || undefined,
                    // Synchronous /design-circuit can't be canceled mid-loop; the async worker passes a real check.
                    isAborted: () => Promise.resolve(false),
                    // A 429 QUOTA_EXCEEDED (or any HttpException) from the sim service carries intent — let it
                    // propagate untranslated instead of being folded into an "inconclusive" verdict.
                    isIntentfulError: (e) => e instanceof HttpException,
                },
            );
        } catch (err) {
            // HTTP errors from nested services carry intent (esp. the structured 429 QUOTA_EXCEEDED) — pass through.
            if (err instanceof HttpException) throw err;
            if (err instanceof DesignAbortedError) throw new BadGatewayException('Circuit design was canceled.');
            if (err instanceof CircuitGenerationError) {
                if (err.code === 'invalid_output') throw new UnprocessableEntityException(err.message);
                if (err.code === 'config') throw new ServiceUnavailableException(err.message);
                throw new BadGatewayException(err.message);
            }
            throw new BadGatewayException('Circuit design failed.');
        }
    }
}
