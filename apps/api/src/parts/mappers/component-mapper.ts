/**
 * Maps a normalized CatalogPart -> a (partial) CircuitJson Component.
 *
 * Passives (resistor/capacitor/inductor) and diodes map to a simulatable component; the value is
 * extracted from the catalog parameters. ICs/transistors/connectors are NOT representable in the
 * current ComponentType enum (the "active-component gap") — they return catalog metadata only with
 * `simulatable: false`. The mapper deliberately does NOT assign id/designator/pins: the schematic
 * layer owns those (avoids designator collisions when the same part is placed multiple times).
 */
import { Injectable } from '@nestjs/common';
import {
    parseSpiceValue,
    formatSpiceValue,
    type ComponentType,
    type ComponentSourcing,
} from '@circuit-forge/eda-core';
import type { CatalogParameter, CatalogPart } from '../provider/part-provider.interface';

/** A partial Component (no id/designator/pins — assigned by the schematic layer). */
export interface PartialComponent {
    type: ComponentType;
    value?: string;
    footprint?: string;
    mpn?: string;
    manufacturer?: string;
    sourcing?: ComponentSourcing;
}

export interface MappedComponent {
    simulatable: boolean;
    reason?: string;
    component?: PartialComponent;
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
    toComponent(part: CatalogPart): MappedComponent {
        const type = this.inferType(part);
        if (!type) {
            return {
                simulatable: false,
                reason: `No CircuitJson component type for "${part.category ?? 'this part'}" — active/IC/connector parts are catalog-only (no simulatable model yet).`,
                catalog: part,
            };
        }

        const base: PartialComponent = {
            type,
            footprint: part.footprint,
            mpn: part.mpn,
            manufacturer: part.manufacturer || undefined,
            sourcing: this.toSourcing(part),
        };

        // Diodes are value-less (model-based); other inferred types are passives needing a value.
        if (type === 'diode') {
            return { simulatable: true, component: base, catalog: part };
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

    private inferType(part: CatalogPart): ComponentType | null {
        const hay = `${part.category ?? ''} ${part.description ?? ''}`.toLowerCase();
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
