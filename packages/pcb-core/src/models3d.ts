/**
 * 3D body mapping — tscircuit footprint identifier -> KiCad standard 3D model, injected into a
 * generated .kicad_pcb so `kicad-cli pcb export glb --subst-models` (run in the KiCad Docker image by
 * the harness/worker) resolves a real component body for every placed part.
 *
 * PURE string transform — no Docker, no filesystem. The model PATHS point at KiCad's bundled library
 * (`/usr/share/kicad/3dmodels`, present in the export container; verified live 3 Tem 2026 — injected
 * SOIC-8/0603/PinHeader bodies rendered in the GLB). The identifiers were harvested from the emitted
 * boards across the whole v1 palette (`resistor_res0603`, `capacitor_0603`, `transistor_sot23`,
 * `chip_soic8`, `pin_header_pinrow2`, ...): the type token differs per family, the size token drives
 * the passive variant.
 */

/** Default KiCad bundled-model root (the export Docker image); override for other layouts. */
export const KICAD_3DMODEL_BASE = '/usr/share/kicad/3dmodels/';

/** Imperial passive size -> KiCad step-name metric suffix. */
const PASSIVE_METRIC: Record<string, string> = {
    '0402': '1005Metric',
    '0603': '1608Metric',
    '0805': '2012Metric',
    '1206': '3216Metric',
};

/** type-token -> [library dir, step-name prefix] for size-parametric passives. */
const PASSIVE_FAMILY: Record<string, [string, string]> = {
    resistor_res: ['Resistor_SMD.3dshapes', 'R'],
    capacitor_: ['Capacitor_SMD.3dshapes', 'C'],
    inductor_: ['Inductor_SMD.3dshapes', 'L'],
    led_: ['LED_SMD.3dshapes', 'LED'],
};

/** SOIC pin count -> KiCad step name (the 3.9mm-body JEDEC variant). */
const SOIC_MODEL: Record<string, string> = {
    '8': 'SOIC-8_3.9x4.9mm_P1.27mm',
    '14': 'SOIC-14_3.9x8.7mm_P1.27mm',
    '16': 'SOIC-16_3.9x9.9mm_P1.27mm',
};

/** Fixed (non-parametric) footprint id -> library-relative step path. */
const FIXED_MODEL: Array<[RegExp, string]> = [
    [/^diode_sod123/, 'Diode_SMD.3dshapes/D_SOD-123.step'],
    [/^(transistor|mosfet)_sot23/, 'Package_TO_SOT_SMD.3dshapes/SOT-23.step'], // BJT and MOSFET both use SOT-23
    [/^(transistor|mosfet)_to92/, 'Package_TO_SOT_THT.3dshapes/TO-92.step'],
    [/^chip_to220/, 'Package_TO_SOT_THT.3dshapes/TO-220-3_Vertical.step'], // 3-pin regulators (7805, LM317, ...)
];

/**
 * Resolve a KiCad 3D model path for a tscircuit footprint id (`tscircuit:chip_soic8` or bare
 * `chip_soic8`). Returns null when no curated body exists — the caller reports it, never guesses.
 */
export function resolveModel(footprintId: string, base: string = KICAD_3DMODEL_BASE): string | null {
    const id = footprintId.replace(/^tscircuit:/, '');

    const passive = /^(resistor_res|capacitor_|inductor_|led_)(0402|0603|0805|1206)/.exec(id);
    if (passive) {
        const [dir, prefix] = PASSIVE_FAMILY[passive[1]!]!;
        return `${base}${dir}/${prefix}_${passive[2]}_${PASSIVE_METRIC[passive[2]!]}.step`;
    }

    const soic = /^chip_soic(\d+)/.exec(id);
    if (soic) {
        const name = SOIC_MODEL[soic[1]!];
        return name ? `${base}Package_SO.3dshapes/${name}.step` : null;
    }

    // pin headers: 1×N vertical, N from the footprint (voltage sources → pinrow2, ICSP → pinrow6, ...)
    const pinrow = /^pin_header_pinrow(\d+)/.exec(id);
    if (pinrow) {
        return `${base}Connector_PinHeader_2.54mm.3dshapes/PinHeader_1x${String(pinrow[1]).padStart(2, '0')}_P2.54mm_Vertical.step`;
    }

    for (const [re, rel] of FIXED_MODEL) {
        if (re.test(id)) return `${base}${rel}`;
    }
    return null;
}

export interface InjectModelsResult {
    /** The .kicad_pcb with `(model ...)` refs injected into every matched footprint. */
    kicadPcb: string;
    /** How many footprint instances received a body. */
    injected: number;
    /** Distinct footprint ids with NO curated body (surface as a diagnostic; never silently drop). */
    unmatched: Array<{ id: string; count: number }>;
}

/**
 * Inject a `(model ...)` reference into every footprint of a generated .kicad_pcb. Idempotent-ish:
 * only footprints WITHOUT an existing model get one (re-running won't double-inject). The ref uses the
 * KiCad library path so `--subst-models` resolves the body at glb/render time.
 */
export function injectModels(kicadPcb: string, base: string = KICAD_3DMODEL_BASE): InjectModelsResult {
    const unmatched = new Map<string, number>();
    let injected = 0;

    // Match a footprint open + its library id, capturing any (model ...) we already appended right after
    // the id so a re-run is a genuine no-op (idempotent — see docstring). A footprint bodied elsewhere in
    // its block by a different tool is not our concern; we only guard against double-injecting our own.
    const out = kicadPcb.replace(/\(footprint\s*\n\s*"(tscircuit:[^"]+)"(\s*\n\s*\(model )?/g, (full, id: string, existingModel: string | undefined) => {
        if (existingModel) return full; // already bodied — skip (idempotent)
        const model = resolveModel(id, base);
        if (!model) {
            unmatched.set(id, (unmatched.get(id) ?? 0) + 1);
            return full;
        }
        injected++;
        const ref = `\n    (model "${model}"\n      (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))`;
        return `${full}${ref}`;
    });

    return { kicadPcb: out, injected, unmatched: [...unmatched.entries()].map(([id, count]) => ({ id, count })) };
}
