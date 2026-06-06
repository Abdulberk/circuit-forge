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
    njf: {
        name: 'JGENNJF',
        device: 'jfet',
        tier: 'generic',
        // Generic N-channel JFET (e.g. 2N5457/J201 class): depletion-mode, negative pinch-off VTO.
        body: '.model JGENNJF NJF(VTO=-2.0 BETA=1m LAMBDA=2m RD=10 RS=10 CGS=4p CGD=4p)',
    },
    pjf: {
        name: 'JGENPJF',
        device: 'jfet',
        tier: 'generic',
        // Generic P-channel JFET (e.g. 2N5460 class): positive pinch-off VTO, lower BETA.
        body: '.model JGENPJF PJF(VTO=2.0 BETA=0.5m LAMBDA=2m RD=10 RS=10 CGS=4p CGD=4p)',
    },
    vswitch: {
        name: 'SWGEN',
        device: 'switch',
        tier: 'generic',
        // Generic voltage-controlled switch: closes (RON=1Ω) when the control voltage rises above
        // VT+VH=3V, opens (ROFF=1MΩ) below VT-VH=2V. The hysteresis prevents chatter near threshold.
        body: '.model SWGEN SW(VT=2.5 VH=0.5 RON=1 ROFF=1Meg)',
    },
    // Generic behavioral op-amp macromodel (a `.subckt`, not a `.model`). Authored, license-clean.
    // Ports (MUST be wired in this order): out, in+ , in-, V+ , V- .
    //   Gm   : transconductance input stage (1 mA/V) — current drive bounds the clamp current,
    //          which is what makes the rail limiter converge cleanly under saturation.
    //   Rpole/Cp : dominant pole — DC gain = Gm*Rpole = 1e5 (100 dB), pole ~100 Hz, GBW ~10 MHz.
    //   Dhi/Dlo  : clamp the high-impedance node to the supply rails => the output saturates near
    //              vcc/vee instead of swinging unbounded (realistic comparator / overdrive behaviour).
    //   Ebuf/Rout: unity output buffer with a finite (50 Ω) output impedance.
    // 'generic' fidelity: correct first-order behaviour for amplifiers / active filters / comparators
    // (gain, bandwidth, saturation) — NOT a specific part's measured macromodel.
    opamp: {
        name: 'OPAMPGEN',
        device: 'subckt',
        tier: 'generic',
        // pinIds in the .subckt port order — the generator binds by these, so the AI/caller may author
        // the op-amp's pins in any order and the netlist still wires out/in+/in-/V+/V- correctly.
        ports: ['out', 'in+', 'in-', 'vcc', 'vee'],
        body: [
            '.subckt OPAMPGEN out inp inn vcc vee',
            'Rin   inp inn 2Meg',
            'Gm    0 n2 inp inn 1e-3',
            'Rpole n2 0 1e8',
            'Cp    n2 0 16p',
            'Dhi   n2 vcc DCLMP',
            'Dlo   vee n2 DCLMP',
            'Ebuf  n3 0 n2 0 1',
            'Rout  n3 out 50',
            '.model DCLMP D(IS=1e-12 N=1)',
            '.ends',
        ].join('\n'),
    },
};

export interface ResolveModelInput {
    type: ComponentType;
    /** Device polarity/class hint from the catalog taxonomy: 'npn'|'pnp'|'nmos'|'pmos'|'njf'|'pjf'. */
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
    if (input.type === 'jfet') return GENERIC_MODELS[sub === 'pjf' || sub === 'pjfet' ? 'pjf' : 'njf'] ?? null;
    if (input.type === 'switch') return GENERIC_MODELS.vswitch ?? null;
    return null;
}

/**
 * Parse a breakdown-voltage string into volts. Accepts a plain number ("5.1"), a trailing-unit form
 * ("5.1V", "12 V"), the European Zener notation ("5V1" = 5.1 V), and a comma decimal ("5,1").
 * Returns null when it isn't a positive voltage.
 */
function parseBreakdownVolts(vz: string | number): number | null {
    if (typeof vz === 'number') return Number.isFinite(vz) && vz > 0 ? vz : null;
    let s = String(vz).trim().replace(',', '.');
    const vNotation = s.match(/^(\d+)[vV](\d+)$/); // 5V1 -> 5.1
    if (vNotation) s = `${vNotation[1]}.${vNotation[2]}`;
    else s = s.replace(/\s*[vV]\s*$/, ''); // strip a single trailing volt unit
    // After normalization the WHOLE remaining string must be ONE clean positive number. Using a strict
    // test + Number() (not parseFloat, which is a prefix parser) rejects MPNs ("1N4733A"->1), multi-token
    // spec strings ("5V1 0.5W"->5) and ranges ("4.5...16"->4.5) instead of silently taking a wrong value.
    if (!/^\d*\.?\d+$/.test(s)) return null;
    const v = Number(s);
    return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Build a generic Zener `.model` from a breakdown voltage. A Zener is the ordinary SPICE diode device
 * with reverse breakdown enabled via BV (the breakdown voltage) and IBV (the test current at which BV
 * holds). This is PARAMETRIC — one template yields a model for any voltage — so we never hand-author a
 * model per Zener value. The name encodes the voltage (5.1 -> DZ5P1) so distinct voltages get distinct,
 * dedup-able models. Returns null when `vz` isn't a positive voltage.
 */
/** A single SPICE numeric token: optional sign, mantissa, exponent, and engineering suffix. */
const NUMERIC_TOKEN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?(meg|[tgkmunpf])?$/i;

/**
 * True iff `s` is a single SPICE value with a strictly positive magnitude. Mirrors ngspice's lexer: a
 * number, optional exponent, optional engineering scale-factor, then any IGNORED trailing unit letters —
 * so the idiomatic "10ns" / "75ohm" / "1uF" are accepted (ngspice reads "5ns" as 5n). "-1"/"0"/"abc" no.
 */
function isPositiveSpiceValue(s: string): boolean {
    const m = /^\+?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?(meg|[tgkmunpf])?[a-zΩµμ]*$/i.exec(s.trim());
    return m ? parseFloat(m[1]!) > 0 : false; // scale factor is a positive multiplier; sign lives in the mantissa
}

/**
 * Normalize a controlled-source (E/G) gain / transconductance. ngspice's LINEAR dependent source is
 * `Exxx n+ n- nc+ nc- VALUE` where VALUE must be a SINGLE real number — any extra token (an accidental
 * "DC " prefix, or a POLY/VALUE=/{expr} keyword form) flips ngspice into the behavioral parser and
 * FATALLY aborts the whole run. So: tolerate a stray leading "DC ", then require a single numeric token.
 * Returns the clean token, or null if it isn't a bare gain (caller skips emission; ERC flags it).
 */
export function normalizeControlledSourceGain(raw: string): string | null {
    const s = raw.trim().replace(/^dc\s+/i, '');
    return NUMERIC_TOKEN.test(s) ? s : null;
}

/** Validated transformer winding inductances + coupling, ready to emit as two L's + a K statement. */
export interface TransformerParams {
    lp: string; // primary winding inductance (SPICE value, e.g. "10m")
    ls: string; // secondary winding inductance
    k: string; // coupling coefficient in (0, 1]
}

/**
 * Read + validate a transformer's parameters from a component's `properties`. A transformer is two
 * magnetically-coupled inductors: the turns ratio follows from sqrt(Lp/Ls). Both winding inductances are
 * required (single positive SPICE values); coupling is optional and defaults to a tight 0.999, and when
 * given must be a real in (0, 1]. Returns null (caller skips emission; ERC flags it) on anything invalid.
 */
export function parseTransformerParams(props: Record<string, unknown> | undefined): TransformerParams | null {
    const str = (key: string): string | undefined => {
        const v = props?.[key];
        if (typeof v === 'string') return v.trim();
        if (typeof v === 'number' && Number.isFinite(v)) return String(v);
        return undefined;
    };
    const lp = str('primaryInductance');
    const ls = str('secondaryInductance');
    // Winding inductances must be STRICTLY POSITIVE SPICE values: a negative one makes the coupled
    // inductance matrix non-positive-definite (garbage solution) and a zero one is a degenerate winding
    // that transfers nothing — both pass ngspice's parser, so they must be rejected here.
    if (!lp || !ls || !isPositiveSpiceValue(lp) || !isPositiveSpiceValue(ls)) return null;

    // Coupling is dimensionless in (0, 1]; default a tight 0.999. Validate as a CLEAN decimal (no
    // engineering suffix, no JS-coercible junk like "0x1") AND in range, then emit that exact token.
    const rawK = str('coupling');
    let k = '0.999';
    if (rawK !== undefined) {
        if (!/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(rawK)) return null;
        const kv = Number(rawK);
        if (!Number.isFinite(kv) || kv <= 0 || kv > 1) return null;
        k = rawK;
    }
    return { lp, ls, k };
}

/**
 * Validated lossless transmission-line parameters. The propagation is given EITHER by an explicit delay
 * `td` (the common form, emitted as `TD=`) OR by a frequency `f` with optional normalized length `nl`
 * (emitted as `F=` [`NL=`]). `z0` (characteristic impedance) is always required.
 */
export interface TransmissionLineParams {
    z0: string;
    td?: string;
    f?: string;
    nl?: string;
}

/**
 * Read + validate a lossless transmission line's parameters from a component's `properties`. `z0`
 * (accepts `impedance`) is required + positive; the line is specified by EITHER `td` (accepts `delay`)
 * OR `f` (accepts `frequency`) with optional `nl` — mirroring ngspice's two lossless-line forms. Values
 * may carry trailing units (e.g. "10ns", "50ohm"). Returns null (caller skips; ERC flags) otherwise.
 */
export function parseTransmissionLineParams(
    props: Record<string, unknown> | undefined,
): TransmissionLineParams | null {
    const str = (key: string): string | undefined => {
        const v = props?.[key];
        if (typeof v === 'string') return v.trim();
        if (typeof v === 'number' && Number.isFinite(v)) return String(v);
        return undefined;
    };
    const z0 = str('z0') ?? str('impedance');
    if (!z0 || !isPositiveSpiceValue(z0)) return null;

    const td = str('td') ?? str('delay');
    if (td) return isPositiveSpiceValue(td) ? { z0, td } : null;

    const f = str('f') ?? str('frequency');
    if (f && isPositiveSpiceValue(f)) {
        const nl = str('nl');
        return nl && isPositiveSpiceValue(nl) ? { z0, f, nl } : { z0, f };
    }
    return null; // neither a valid td nor a valid f
}

export function buildZenerModel(vz: string | number): ModelDef | null {
    const v = parseBreakdownVolts(vz);
    if (v === null) return null;
    const name = `DZ${String(v).replace(/\./g, 'P')}`; // 5.1 -> DZ5P1, 12 -> DZ12
    return {
        name,
        device: 'diode',
        tier: 'generic',
        body: `.model ${name} D(IS=1e-14 N=1 RS=1 BV=${v} IBV=5m)`,
    };
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
