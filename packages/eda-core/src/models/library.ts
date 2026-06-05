/**
 * Curated, license-clean GENERIC SPICE models for active devices.
 *
 * These are GENERIC behavioral parameter sets authored here (typical small-signal / general-purpose
 * values), NOT copied from any proprietary vendor model file. They give correct first-order behaviour
 * for "does this transistor circuit work" — enough to bias and swing — but are family-generic, not the
 * exact part's measured model (that is the `manufacturer` fidelity tier, sourced separately). The TME
 * catalog provides no model bodies, so a generic library + an honest fidelity tier is the realistic
 * path (mirrors Flux's full > behavioral > ideal tiering).
 */
import type { CircuitJson, ComponentType, ModelDef } from '../types/circuit';

/** Generic device models keyed by a normalized device class. */
export const GENERIC_MODELS: Record<string, ModelDef> = {
    npn: {
        name: 'QGENNPN',
        device: 'bjt',
        tier: 'generic',
        body: '.model QGENNPN NPN(IS=10f BF=200 VAF=100 IKF=0.3 ISE=1p NE=1.5 RB=10 RC=1 RE=0.5 CJE=8p CJC=4p TF=0.4n TR=50n)',
    },
    pnp: {
        name: 'QGENPNP',
        device: 'bjt',
        tier: 'generic',
        body: '.model QGENPNP PNP(IS=10f BF=180 VAF=100 IKF=0.2 ISE=1p NE=1.5 RB=10 RC=1 RE=0.5 CJE=10p CJC=6p TF=0.6n TR=80n)',
    },
    nmos: {
        name: 'MGENNMOS',
        device: 'mosfet',
        tier: 'generic',
        body: '.model MGENNMOS NMOS(LEVEL=1 VTO=2.0 KP=20u GAMMA=0 LAMBDA=0.02 CGSO=5p CGDO=2p)',
    },
    pmos: {
        name: 'MGENPMOS',
        device: 'mosfet',
        tier: 'generic',
        body: '.model MGENPMOS PMOS(LEVEL=1 VTO=-2.0 KP=10u GAMMA=0 LAMBDA=0.02 CGSO=5p CGDO=2p)',
    },
};

export interface ResolveModelInput {
    type: ComponentType;
    /** Device polarity/class hint from the catalog taxonomy: 'npn'|'pnp'|'nmos'|'pmos'. */
    subtype?: string;
    /** Manufacturer part number (reserved for a future exact-MPN model map). */
    mpn?: string;
}

/**
 * Resolve a generic model for an active device. Returns null when no generic model applies (then the
 * part stays catalog-only). When the polarity hint is absent we default to the common case (NPN / NMOS)
 * — the API mapper supplies the hint from TME's NPN/PNP / N-channel/P-channel categories.
 */
export function resolveModelForPart(input: ResolveModelInput): ModelDef | null {
    const sub = input.subtype?.toLowerCase();
    if (input.type === 'bjt') return GENERIC_MODELS[sub === 'pnp' ? 'pnp' : 'npn'] ?? null;
    if (input.type === 'mosfet') return GENERIC_MODELS[sub === 'pmos' ? 'pmos' : 'nmos'] ?? null;
    return null;
}

const GENERIC_MODELS_BY_NAME: Record<string, ModelDef> = Object.fromEntries(
    Object.values(GENERIC_MODELS).map((m) => [m.name, m]),
);

/** A generic ModelDef by its name (e.g. 'QGENNPN'), or undefined if it isn't one of ours. */
export function genericModelByName(name: string): ModelDef | undefined {
    return GENERIC_MODELS_BY_NAME[name];
}

/**
 * The generic ModelDefs a circuit's components reference by name (Component.model) but that aren't yet
 * present in circuit.models. The host injects these bodies so an AI/mapper that picked a vetted generic
 * model NAME gets the actual `.model` card emitted — without the model ever inventing a body itself.
 */
export function resolveGenericModels(circuit: Pick<CircuitJson, 'components' | 'models'>): ModelDef[] {
    const present = new Set((circuit.models ?? []).map((m) => m.name));
    const out: ModelDef[] = [];
    for (const c of circuit.components) {
        const name = c.model;
        if (name && GENERIC_MODELS_BY_NAME[name] && !present.has(name)) {
            present.add(name);
            out.push(GENERIC_MODELS_BY_NAME[name]);
        }
    }
    return out;
}
