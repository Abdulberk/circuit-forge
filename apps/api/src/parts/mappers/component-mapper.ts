/**
 * Maps a normalized CatalogPart -> a (partial) CircuitJson Component.
 *
 * Passives (resistor/capacitor/inductor) and diodes map to a simulatable component; the value is
 * extracted from the catalog parameters. ICs/transistors/connectors are NOT representable in the
 * current ComponentType enum (the "active-component gap") — they return catalog metadata only with
 * `simulatable: false`. The mapper deliberately does NOT assign id/designator/pins: the schematic
 * layer owns those (avoids designator collisions when the same part is placed multiple times).
 */
import { Injectable, Logger } from '@nestjs/common';
import {
    parseSpiceValue,
    formatSpiceValue,
    resolveModelForPart,
    type ComponentType,
    type ComponentSourcing,
    type ModelDef,
} from '@circuit-forge/eda-core';
import type { CatalogParameter, CatalogPart } from '../provider/part-provider.interface';
import { typeFromCategoryId, subtypeFromCategoryId } from './tme-category-map';

/** A partial Component (no id/designator/pins — assigned by the schematic layer). */
export interface PartialComponent {
    type: ComponentType;
    value?: string;
    model?: string; // SPICE model name for active devices (resolved from the generic library)
    footprint?: string;
    mpn?: string;
    manufacturer?: string;
    sourcing?: ComponentSourcing;
}

export interface MappedComponent {
    simulatable: boolean;
    reason?: string;
    component?: PartialComponent;
    /** The generic model body to add to circuit.models when this part is placed (active devices). */
    modelDef?: ModelDef;
    catalog: CatalogPart;
}

/** Map a passive ComponentType to the catalog parameter name that carries its value. */
const VALUE_PARAM: Partial<Record<ComponentType, RegExp>> = {
    resistor: /resistance/i,
    capacitor: /capacitance/i,
    inductor: /inductance/i,
};

@Injectable()
export class ComponentMapper {
    private readonly logger = new Logger(ComponentMapper.name);

    toComponent(part: CatalogPart): MappedComponent {
        const type = this.classify(part);

        const base: PartialComponent = {
            type,
            footprint: part.footprint,
            mpn: part.mpn,
            manufacturer: part.manufacturer || undefined,
            sourcing: this.toSourcing(part),
        };

        // Catalog-only: representable + placeable on a schematic/BOM, but not simulatable yet.
        if (type === 'generic') {
            return {
                simulatable: false,
                reason: `No simulatable model for "${part.category ?? 'this part'}" yet — placed as a catalog-only component.`,
                component: base,
                catalog: part,
            };
        }

        // Diodes are value-less (model-based); other simulatable types are passives needing a value.
        if (type === 'diode') {
            return { simulatable: true, component: base, catalog: part };
        }

        // Active devices (bjt/mosfet): resolve a generic SPICE model by polarity (from the category).
        if (type === 'bjt' || type === 'mosfet') {
            const subtype = subtypeFromCategoryId(part.categoryId);
            const modelDef = resolveModelForPart({ type, subtype, mpn: part.mpn });
            if (!modelDef) {
                return {
                    simulatable: false,
                    reason: `No generic ${type} model available — placed as catalog-only.`,
                    component: base,
                    catalog: part,
                };
            }
            return {
                simulatable: true,
                component: { ...base, model: modelDef.name },
                modelDef,
                catalog: part,
            };
        }

        const value = this.extractValue(type, part.parameters);
        if (!value) {
            return {
                simulatable: false,
                reason: `Could not determine a ${type} value from the catalog parameters.`,
                component: base,
                catalog: part,
            };
        }
        return { simulatable: true, component: { ...base, value }, catalog: part };
    }

    /**
     * Classify a catalog part into a ComponentType. PRIMARY signal is the stable, locale-independent
     * TME category id (typeFromCategoryId) — the reliable, industry-standard approach. The English
     * keyword heuristic is only a fallback for category ids we haven't mapped yet, and unmapped ids are
     * logged so the map can be extended. Returns `'generic'` for catalog-only parts.
     */
    private classify(part: CatalogPart): ComponentType {
        // A part with no stable category id (e.g. a detail-only resolve that never matched a search
        // element) loses the PRIMARY classifier and silently falls back to text — surface it as a warn
        // so the degradation is observable rather than invisible.
        if (!part.categoryId) {
            this.logger.warn(
                `Part ${part.supplierId} resolved without a category id — classification degraded to the text heuristic.`,
            );
        }
        // PRIMARY: stable category id (authoritative — includes explicit 'generic' for parts whose
        // name would otherwise fool the text fallback, e.g. Zener diodes / resistor networks).
        const byId = typeFromCategoryId(part.categoryId);
        if (byId) return byId;

        // FALLBACK: legacy English keyword heuristic, only when the category id is unmapped/absent.
        const byText = this.inferTypeFromText(part);
        if (byText) {
            this.logger.debug(
                `Classified ${part.supplierId} via text fallback (TME category ${part.categoryId ?? 'none'} ` +
                    `"${part.category ?? ''}" unmapped) -> ${byText}`,
            );
            return byText;
        }

        if (part.categoryId) {
            this.logger.debug(
                `Unmapped TME category ${part.categoryId} "${part.category ?? ''}" -> generic (${part.supplierId})`,
            );
        }
        return 'generic';
    }

    private inferTypeFromText(part: CatalogPart): ComponentType | null {
        const hay = `${part.category ?? ''} ${part.description ?? ''}`.toLowerCase();
        // Safety guard: a name can contain a primitive keyword yet NOT be a single 2-terminal primitive
        // (Zener/TVS clamps, bridges, modules, resistor/diode networks/arrays). For an UNMAPPED category
        // we refuse to guess these — letting them fall to 'generic' (placeable, not mis-simulated) is
        // safer than emitting wrong physics (e.g. a Zener as a plain DDEFAULT rectifier).
        if (/\bzener|\btvs\b|transil|suppress|\bbridge\b|\bmodule|\barray\b|\bnetwork\b/.test(hay)) {
            return null;
        }
        if (/\bresistor/.test(hay)) return 'resistor';
        if (/\bcapacitor/.test(hay)) return 'capacitor';
        if (/\binductor|\bchoke|\bcoil/.test(hay)) return 'inductor';
        if (/\bdiode/.test(hay)) return 'diode';
        return null;
    }

    private extractValue(type: ComponentType, params: CatalogParameter[]): string | undefined {
        const matcher = VALUE_PARAM[type];
        if (!matcher) return undefined;
        const param = params.find((p) => matcher.test(p.name));
        if (!param?.value) return undefined;
        return this.normalizeValue(param.value);
    }

    /** Normalize a catalog value (e.g. "10kΩ", "100nF", "10µH") into a SPICE-friendly value ("10K", "100n"). */
    private normalizeValue(raw: string): string | undefined {
        const cleaned = raw
            .replace(/[µμ]/g, 'u')
            .replace(/Ω|ohms?/gi, '')
            .trim();
        for (const candidate of [cleaned, cleaned.split(/\s+/)[0] ?? cleaned]) {
            // Reject ranges / tolerances / multi-part values (e.g. "4.5...16V", "100-470u", "±5%") —
            // those are not a single SPICE-simulatable value.
            if (/\d\s*[-–—]\s*\d|\.{2,}|[±%]/.test(candidate)) continue;
            const parsed = parseSpiceValue(candidate);
            // Guard against overflow to Infinity/NaN producing strings like "InfinityT".
            if (parsed.isValid && Number.isFinite(parsed.value)) return formatSpiceValue(parsed.value);
        }
        return undefined;
    }

    private toSourcing(part: CatalogPart): ComponentSourcing {
        return {
            supplier: part.supplier,
            supplierId: part.supplierId,
            unitCost: part.unitCost,
            currency: part.currency,
            stock: part.stock,
            datasheetUrl: part.datasheetUrl,
        };
    }
}
