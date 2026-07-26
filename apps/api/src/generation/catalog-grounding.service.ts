/**
 * Shared catalog grounding for the AI generation endpoints.
 *
 * Provides the tool executor handed to llm-core (so the model can search the LIVE parts catalog) and
 * the best-effort, server-authoritative sourcing enrichment applied to a generated circuit. Used by
 * BOTH GenerationService (/generate-circuit) and DesignService (/design-circuit) so the two endpoints
 * can't drift. Grounding is enabled only when the catalog is fully configured (TME_TOKEN && TME_SECRET).
 */
import type { CircuitJson, ComponentSourcing, AnalysisConfig } from '@circuit-forge/eda-core';
import type { GroundingOptions, ToolExecutor } from '@circuitforge/llm-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PartsService } from '../parts/parts.service';

import { CircuitSimulatorService } from './circuit-simulator.service';

@Injectable()
export class CatalogGroundingService {
    private readonly logger = new Logger(CatalogGroundingService.name);

    constructor(
        private readonly config: ConfigService,
        private readonly parts: PartsService,
        private readonly simulator: CircuitSimulatorService,
    ) {}

    /**
     * Grounding options for an AI generation call, or undefined when NEITHER capability is available.
     * Catalog grounding (search_parts/get_part_details) is enabled when TME is configured; simulation
     * verification (simulate_circuit) when an ngspice binary is configured. They are independent — the
     * loop runs if either is present — and both /generate-circuit and /design-circuit get them for free.
     */
    grounding(): GroundingOptions | undefined {
        const catalog = !!(this.config.get<string>('TME_TOKEN') && this.config.get<string>('TME_SECRET'));
        const simulate = this.simulator.available();
        if (!catalog && !simulate) return undefined;
        return { catalog, simulate, toolExecutor: this.buildToolExecutor() };
    }

    /** Dispatches the model's tool calls: catalog lookups → PartsService, simulate_circuit → ngspice. */
    private buildToolExecutor(): ToolExecutor {
        return async (name, input) => {
            if (name === 'simulate_circuit') {
                if (!input.circuit || typeof input.circuit !== 'object') return { error: 'circuit is required' };
                // Convergence Doctor: auto-applies solver remedies on a convergence failure (and tells
                // the model what fixed it / why), so the AI doesn't burn a fix-round on a solver tweak.
                return this.simulator.simulateWithRemedies(input.circuit, input.analysis as AnalysisConfig | undefined);
            }
            if (name === 'search_parts') {
                const q = String(input.query ?? '')
                    .trim()
                    .slice(0, 100);
                if (!q) return { items: [] };
                const res = await this.parts.search({ q });
                // Note: TME search does NOT carry stock (detail-only). The model must call
                // get_part_details to check availability — see GROUNDING_PROMPT.
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
                    type: m.component?.type,
                    value: m.component?.value,
                    mpn: m.catalog.mpn,
                    manufacturer: m.catalog.manufacturer,
                    description: m.catalog.description,
                    footprint: m.catalog.footprint,
                    stock: m.catalog.stock,
                    inStock: (m.catalog.stock ?? 0) > 0,
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
     * Best-effort: attach authoritative sourcing for each component the model tagged with a real `mpn`
     * (EXACT case-insensitive match only — never a different part) and backfill footprint. Never throws;
     * logs a warning when a sourced part is out of stock so the BOM honesty is observable.
     */
    async enrichSourcing(circuit: CircuitJson): Promise<void> {
        try {
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
                    if ((hit.sourcing.stock ?? 0) <= 0) {
                        this.logger.warn(
                            `Component ${c.designator || c.id} sourced to ${mpn} which is OUT OF STOCK (stock ${hit.sourcing.stock ?? 0}).`,
                        );
                    }
                }
            }
        } catch (err) {
            this.logger.warn(`Sourcing enrichment skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /**
     * Resolve one MPN to authoritative sourcing via the catalog. Requires an EXACT (case-insensitive)
     * mpn match — TME search is fuzzy, so a near-miss would otherwise rank an unrelated part first. On
     * no exact match we attach NOTHING (a component with no sourcing beats one with the wrong part's data).
     */
    private async resolveSourcing(mpn: string): Promise<{ sourcing: ComponentSourcing; footprint?: string } | null> {
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
