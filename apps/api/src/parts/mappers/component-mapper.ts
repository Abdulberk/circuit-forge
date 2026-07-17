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
    buildZenerModel,
    GENERIC_MODELS,
    type ComponentType,
    type ComponentSourcing,
    type ModelDef,
} from '@circuit-forge/eda-core';
import type { CatalogParameter, CatalogPart } from '../provider/part-provider.interface';
import { typeFromCategoryId, subtypeFromCategoryId, isLedCategory } from './tme-category-map';

/** A partial Component (no id/designator/pins — assigned by the schematic layer). */
export interface PartialComponent {
    type: ComponentType;
    value?: string;
    model?: string; // SPICE model name for active devices (resolved from the generic library)
    footprint?: string;
    mpn?: string;
    manufacturer?: string;
    /** Fractional tolerance from the real part's datasheet (e.g. 0.01 = ±1%), captured from the catalog
     *  parameters — a FACT, not a guess. Set only for value-bearing passives (R/L/C) where it is meaningful. */
    tolerance?: number;
    toleranceSource?: 'user' | 'catalog';
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

        // LEDs: electrically a diode with a color-class forward voltage. Pick the generic LED model
        // (LEDRED/LEDYEL/LEDGRN/LEDBLU) by parsing the COLOR from the catalog description; the body is
        // attached as modelDef (same contract as transistors — the frontend pushes it into circuit.models).
        // A colorless LED stays catalog-only: silently simulating it as a 0.7V DDEFAULT diode would be a lie.
        if (isLedCategory(part.categoryId, part.category)) {
            const led = this.resolveLedModel(part);
            if (!led) {
                return {
                    simulatable: false,
                    reason: 'LED color could not be determined from the catalog data — place it as catalog-only, or use a diode with an LED model (LEDRED/LEDYEL/LEDGRN/LEDBLU) manually.',
                    component: { ...base, type: 'generic' },
                    catalog: part,
                };
            }
            return {
                simulatable: true,
                component: { ...base, type: 'diode', model: led.name },
                modelDef: led,
                catalog: part,
            };
        }

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

        // Zener (and unidirectional TVS): the breakdown voltage IS the value; the netlist generator
        // builds the SPICE breakdown model from it. No parseable voltage -> catalog-only (not simulated).
        if (type === 'zener') {
            const vz = this.extractZenerVoltage(part.parameters);
            if (!vz || !buildZenerModel(vz)) {
                return {
                    simulatable: false,
                    reason: 'Could not determine the Zener breakdown voltage from the catalog parameters.',
                    component: base,
                    catalog: part,
                };
            }
            return { simulatable: true, component: { ...base, value: vz }, catalog: part };
        }

        // Active devices (bjt/mosfet/jfet): resolve a generic SPICE model by polarity (from the
        // category). (JFET catalog categories aren't mapped to 'jfet' yet — that's a TME-id follow-up —
        // but the resolution path is ready, and the AI generator can already emit jfet directly.)
        if (type === 'bjt' || type === 'mosfet' || type === 'jfet') {
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
        // Capture the real part's DATASHEET tolerance (a fact, not a guess) for R/L/C — the robustness
        // verdict reads it (and its 'catalog' provenance) instead of assuming a default.
        const tolerance = this.extractTolerance(part.parameters);
        const withTol = tolerance !== undefined ? { tolerance, toleranceSource: 'catalog' as const } : {};
        return { simulatable: true, component: { ...base, value, ...withTol }, catalog: part };
    }

    /**
     * Fractional tolerance from the catalog "Tolerance" parameter (e.g. "±1%" -> 0.01, "±10%" -> 0.10).
     * Only a symmetric ± percent is captured — an asymmetric or non-percent tolerance (e.g. "+80/-20%",
     * "±0.25pF") has no single fractional form for the Monte-Carlo model, so it is left unset (honest:
     * better no tolerance than a wrong one). Ignores look-alike rows (temperature coefficient) by name.
     */
    private extractTolerance(params: CatalogParameter[]): number | undefined {
        const p = params.find((q) => /^\s*tolerance\s*$/i.test(q.name));
        if (!p?.value) return undefined;
        // Accept "±1%", "1%", "± 0.5 %"; reject asymmetric ("+80/-20%") and absolute ("±0.25pF").
        const m = /^\s*±?\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(p.value);
        if (!m) return undefined;
        const pct = Number(m[1]);
        if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return undefined;
        return pct / 100;
    }

    /**
     * Classify a catalog part into a ComponentType. PRIMARY signal is the stable, locale-independent
     * TME category id (typeFromCategoryId) — the reliable, industry-standard approach. The English
     * keyword heuristic is only a fallback for category ids we haven't mapped yet, and unmapped ids are
     * logged so the map can be extended. Returns `'generic'` for catalog-only parts.
     */
    /**
     * Pick the generic LED model for a catalog LED from its description/parameter COLOR. Color classes:
     * red/pink→LEDRED (Vf≈1.9) · yellow/amber/orange→LEDYEL (≈2.0) · green→LEDGRN (≈2.4) ·
     * blue/white/UV→LEDBLU (≈3.0). Multi-color parts (RGB/bicolor) and unparseable colors return null —
     * they need per-die modeling the single-diode mapping can't honestly represent.
     */
    private resolveLedModel(part: CatalogPart): ModelDef | null {
        const colorParam = part.parameters?.find((p) => /colou?r/i.test(p.name) && !/lens|body|case/i.test(p.name))?.value;
        const text = `${colorParam ?? ''} ; ${part.description ?? ''}`.toLowerCase();
        if (/\b(rgb|bicolou?r|bi-colou?r|multicolou?r|red-green|tricolou?r)\b/.test(text)) return null;
        if (/\b(red|pink)\b/.test(text)) return GENERIC_MODELS.led_red ?? null;
        if (/\b(yellow|amber|orange)\b/.test(text)) return GENERIC_MODELS.led_yellow ?? null;
        if (/\bgreen\b/.test(text)) return GENERIC_MODELS.led_green ?? null;
        if (/\b(blue|white|uv|ultraviolet)\b/.test(text)) return GENERIC_MODELS.led_blue ?? null;
        return null;
    }

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

    /**
     * Pull the Zener/breakdown voltage from the catalog parameters. Specific-to-general: match only an
     * unambiguous breakdown/Zener-voltage name and explicitly EXCLUDE the look-alikes that would build a
     * clamp at the wrong voltage — a TVS reverse STAND-OFF (VRWM), a rectifier's max reverse (VRRM), and
     * tolerance / temperature-coefficient rows. For a TVS, breakdown (VBR) is the right BV, not VRWM/VCL.
     */
    private extractZenerVoltage(params: CatalogParameter[]): string | undefined {
        const EXCLUDE =
            /toleranc|temperat|coefficient|stand.?off|vrwm|vrrm|maximum reverse|peak reverse|repetitive|reverse current|leakage|power|dissipation|%/i;
        const PREFER = /\bzener voltage\b|\bvz\b|nominal zener|breakdown voltage|\bvbr\b|\bv\(br\)\b/i;
        const p = params.find((q) => PREFER.test(q.name) && !EXCLUDE.test(q.name));
        return p?.value || undefined;
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
