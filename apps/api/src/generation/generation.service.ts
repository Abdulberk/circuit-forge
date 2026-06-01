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
    type ToolExecutor,
} from '@circuitforge/llm-core';
import { safeValidateCircuitJson, type CircuitJson, type ComponentSourcing } from '@circuit-forge/eda-core';
import { PartsService } from '../parts/parts.service';
import { GenerateCircuitDto, EditCircuitDto, ExplainCircuitDto } from './dto';

@Injectable()
export class GenerationService {
    constructor(
        private readonly config: ConfigService,
        private readonly parts: PartsService,
    ) {}

    async generate(dto: GenerateCircuitDto) {
        const cfg = this.requireLlmConfig();
        // Ground the model in the live catalog only when the catalog is fully configured (both creds,
        // matching requireTmeConfig); otherwise fall back to plain (ungrounded) generation so the
        // endpoint still works without TME creds.
        const grounding =
            this.config.get<string>('TME_TOKEN') && this.config.get<string>('TME_SECRET')
                ? { toolExecutor: this.buildToolExecutor() }
                : undefined;

        const result = await this.runCircuit(() =>
            generateCircuit({ prompt: dto.prompt, constraints: dto.constraints }, cfg, grounding),
        );

        // Best-effort: attach full sourcing (price/stock/datasheet) for any real MPNs the model picked.
        if (grounding) {
            try {
                await this.enrichSourcing(result.circuit);
            } catch {
                /* sourcing enrichment is best-effort — never fail generation over it */
            }
        }
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

    /**
     * Tool executor handed to llm-core: maps the model's tool calls onto the live PartsService.
     * Returns compact, JSON-serializable results (the loop in llm-core stringifies + caps them).
     */
    private buildToolExecutor(): ToolExecutor {
        return async (name, input) => {
            if (name === 'search_parts') {
                const q = String(input.query ?? '').trim().slice(0, 100);
                if (!q) return { items: [] };
                const res = await this.parts.search({ q });
                return {
                    items: res.items.slice(0, 8).map((p) => ({
                        supplierId: p.supplierId,
                        mpn: p.mpn,
                        manufacturer: p.manufacturer,
                        description: p.description,
                        category: p.category,
                    })),
                };
            }
            if (name === 'get_part_details') {
                const symbol = String(input.supplierId ?? '').trim();
                if (!symbol) return { error: 'supplierId is required' };
                const m = await this.parts.getComponent(symbol);
                return {
                    simulatable: m.simulatable,
                    reason: m.reason,
                    // The normalized, classified component the host derived — the decision-relevant facts.
                    type: m.component?.type,
                    value: m.component?.value,
                    mpn: m.catalog.mpn,
                    manufacturer: m.catalog.manufacturer,
                    description: m.catalog.description,
                    footprint: m.catalog.footprint,
                    stock: m.catalog.stock,
                    unitCost: m.catalog.unitCost,
                    currency: m.catalog.currency,
                    datasheetUrl: m.catalog.datasheetUrl,
                    parameters: m.catalog.parameters.slice(0, 20),
                };
            }
            return { error: `Unknown tool: ${name}` };
        };
    }

    /**
     * Best-effort server-side BOM enrichment: for each component the model tagged with a real `mpn`,
     * look the part up in the catalog and attach the authoritative `sourcing` (supplier/price/stock/
     * datasheet) + backfill `footprint`. The model never copies pricing itself (the server owns it).
     */
    private async enrichSourcing(circuit: CircuitJson): Promise<void> {
        const targets = circuit.components.filter((c) => c.mpn && !c.sourcing).slice(0, 30);
        const resolved = new Map<string, { sourcing: ComponentSourcing; footprint?: string } | null>();
        for (const c of targets) {
            const mpn = c.mpn as string;
            if (!resolved.has(mpn)) {
                resolved.set(mpn, await this.resolveSourcing(mpn).catch(() => null));
            }
            const hit = resolved.get(mpn);
            if (hit) {
                c.sourcing = hit.sourcing;
                if (!c.footprint && hit.footprint) c.footprint = hit.footprint;
            }
        }
    }

    /**
     * Resolve one MPN to authoritative sourcing via the catalog. Requires an EXACT (case-insensitive)
     * mpn match — TME search is fuzzy/full-text, so a near-miss would otherwise rank an unrelated part
     * first. On no exact match we attach NOTHING: a component with no sourcing is strictly better than
     * one advertising part X's mpn with part Y's price/stock.
     */
    private async resolveSourcing(
        mpn: string,
    ): Promise<{ sourcing: ComponentSourcing; footprint?: string } | null> {
        const res = await this.parts.search({ q: mpn });
        const target = mpn.trim().toLowerCase();
        const hit = res.items.find((p) => p.mpn.trim().toLowerCase() === target);
        if (!hit) return null;
        const part = await this.parts.getProduct(hit.supplierId);
        return {
            sourcing: {
                supplier: part.supplier,
                supplierId: part.supplierId,
                unitCost: part.unitCost,
                currency: part.currency,
                stock: part.stock,
                datasheetUrl: part.datasheetUrl,
            },
            footprint: part.footprint,
        };
    }
}
