/**
 * AI Circuit Generation Service
 *
 * Generate / edit / explain circuits via the (server-side only) llm-core. The provider API key
 * lives in LLM_API_KEY and is NEVER exposed to clients.
 */
import {
    Injectable,
    BadGatewayException,
    BadRequestException,
    ServiceUnavailableException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    generateCircuit,
    editCircuit,
    explainCircuit,
    CircuitGenerationError,
    type GenerateCircuitConfig,
    type GenerateCircuitResult,
} from '@circuitforge/llm-core';
import { safeValidateCircuitJson, type CircuitJson } from '@circuit-forge/eda-core';
import { GenerateCircuitDto, EditCircuitDto, ExplainCircuitDto } from './dto';

@Injectable()
export class GenerationService {
    constructor(private readonly config: ConfigService) {}

    async generate(dto: GenerateCircuitDto) {
        const cfg = this.requireLlmConfig();
        return this.runCircuit(() =>
            generateCircuit({ prompt: dto.prompt, constraints: dto.constraints }, cfg),
        );
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
            throw new ServiceUnavailableException(
                'AI circuit generation is not configured (LLM_API_KEY is not set).',
            );
        }
        return {
            apiKey,
            baseUrl: this.config.get<string>('LLM_BASE_URL'),
            model: this.config.get<string>('LLM_MODEL'),
            userAgent: this.config.get<string>('LLM_USER_AGENT'),
        };
    }

    private requireValidCircuit(input: unknown): CircuitJson {
        const r = safeValidateCircuitJson(input);
        if (!r.success) {
            const issues = r.error.errors
                .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
                .join('; ');
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
