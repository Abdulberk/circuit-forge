/**
 * AI Circuit Generation Service
 *
 * Generate / edit / explain circuits via the (server-side only) llm-core. The provider API key
 * lives in LLM_API_KEY and is NEVER exposed to clients.
 */
import { safeValidateCircuitJson, type CircuitJson } from '@circuit-forge/eda-core';
import {
    generateCircuit,
    editCircuit,
    explainCircuit,
    CircuitGenerationError,
    type GenerateCircuitConfig,
    type GenerateCircuitResult,
} from '@circuitforge/llm-core';
import {
    Injectable,
    Logger,
    BadGatewayException,
    BadRequestException,
    ServiceUnavailableException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CatalogGroundingService } from './catalog-grounding.service';
import { GenerateCircuitDto, EditCircuitDto, ExplainCircuitDto } from './dto';
import { attachGenericModels } from './model-resolution';

@Injectable()
export class GenerationService {
    private readonly logger = new Logger(GenerationService.name);

    constructor(
        private readonly config: ConfigService,
        private readonly grounding: CatalogGroundingService,
    ) {}

    async generate(dto: GenerateCircuitDto) {
        const cfg = this.requireLlmConfig();
        // Ground the model in the live catalog when configured; otherwise generate ungrounded.
        const grounding = this.grounding.grounding();
        // Give the simulate-and-fix loop more tool round-trips so verification iterations don't starve
        // catalog search (the loop still terminates at the cap with a forced tool-less final answer).
        const genCfg = grounding?.simulate ? { ...cfg, maxToolIters: 10 } : cfg;

        const result = await this.runCircuit(() =>
            generateCircuit({ prompt: dto.prompt, constraints: dto.constraints }, genCfg, grounding),
        );

        // Best-effort: attach authoritative sourcing for any real MPNs the model picked (never throws).
        if (grounding) await this.grounding.enrichSourcing(result.circuit);
        return result;
    }

    async edit(dto: EditCircuitDto) {
        const cfg = this.requireLlmConfig();
        const circuit = this.requireValidCircuit(dto.circuit);
        return this.runCircuit(() =>
            editCircuit(
                {
                    circuit,
                    analysisConfig: dto.analysisConfig,
                    instruction: dto.instruction,
                    constraints: dto.constraints,
                },
                cfg,
            ),
        );
    }

    async explain(dto: ExplainCircuitDto) {
        const cfg = this.requireLlmConfig();
        const circuit = this.requireValidCircuit(dto.circuit);
        try {
            return await explainCircuit({ circuit }, cfg);
        } catch (err) {
            throw this.mapError(err);
        }
    }

    /** Shared runner for generate/edit (same result shape + error mapping). */
    private async runCircuit(fn: () => Promise<GenerateCircuitResult>) {
        try {
            const r = await fn();
            // Inject the bodies of any generic active-device models the circuit references (bjt/mosfet)
            // on EVERY producing path — generate AND edit — so the result is a self-contained,
            // simulatable circuit. (Edit can add a transistor whose .model body the LLM must not author.)
            attachGenericModels(r.circuit);
            return {
                circuit: r.circuit,
                analysisConfig: r.analysisConfig,
                explanation: r.explanation,
                repaired: r.repaired,
            };
        } catch (err) {
            throw this.mapError(err);
        }
    }

    private requireLlmConfig(): GenerateCircuitConfig {
        const apiKey = this.config.get<string>('LLM_API_KEY');
        if (!apiKey) {
            throw new ServiceUnavailableException('AI circuit generation is not configured (LLM_API_KEY is not set).');
        }
        return {
            apiKey,
            // Wire format: 'openai' for GPT/Azure-compatible gateways, else 'anthropic' (default). Env-driven
            // so a deployment swaps providers by config alone.
            protocol: this.config.get<string>('LLM_PROTOCOL') as 'anthropic' | 'openai' | undefined,
            baseUrl: this.config.get<string>('LLM_BASE_URL'),
            model: this.config.get<string>('LLM_MODEL'),
            userAgent: this.config.get<string>('LLM_USER_AGENT'),
            // Optional operator overrides; llm-core applies sane defaults (90s / 300k) when unset.
            timeoutMs: this.positiveIntEnv('LLM_TIMEOUT_MS'),
            tokenBudget: this.positiveIntEnv('LLM_TOKEN_BUDGET'),
            // Count every BILLED provider request (incl. the transient retry) on the grounded SYNC path. The
            // cost model is request-billed, so this lets us reconcile a controlled run against the invoice
            // (does a multi-tool-round generation bill as N requests or 1?). Tagged 'api:generate'.
            onLlmRequest: (info) =>
                this.logger.log(
                    `llm.request path=api:generate iter=${info.iter} attempt=${info.attempt} tools=${info.toolsOffered}`,
                ),
        };
    }

    /** Parse a positive-integer env var, or undefined if unset/invalid (so llm-core's default applies). */
    private positiveIntEnv(key: string): number | undefined {
        const raw = this.config.get<string>(key);
        const n = raw === undefined ? NaN : Number(raw);
        return Number.isFinite(n) && n > 0 ? n : undefined;
    }

    private requireValidCircuit(input: unknown): CircuitJson {
        const r = safeValidateCircuitJson(input);
        if (!r.success) {
            const issues = r.error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ');
            throw new BadRequestException(`Invalid circuit: ${issues}`);
        }
        return r.data as CircuitJson;
    }

    private mapError(err: unknown): Error {
        if (err instanceof CircuitGenerationError) {
            if (err.code === 'invalid_output') return new UnprocessableEntityException(err.message);
            if (err.code === 'config') return new ServiceUnavailableException(err.message);
            return new BadGatewayException(err.message);
        }
        if (err instanceof BadRequestException) return err;
        return new BadGatewayException('Circuit operation failed.');
    }
}
