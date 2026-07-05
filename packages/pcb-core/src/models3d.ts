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

import { KICAD_ANCHORS, type KicadAnchor } from './kicad-anchors.generated';

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

    // LEDs: the footprinter emits an SMD-passive pad (led_0603), but the iconic, recognizable part is
    // the 5mm domed through-hole emitter. Use KiCad's real LED_D5.0mm body for ANY led_* footprint so
    // an LED reads as an LED (a glassy dome), not another flat chip. Pads stay as placed; body only.
    if (/^led_/.test(id)) return `${base}LED_THT.3dshapes/LED_D5.0mm.step`;

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

export interface ModelAlignment {
    /** tscircuit footprint id this alignment was computed for. */
    id: string;
    /** Model step basename used for the anchor lookup. */
    model: string;
    /** Solved in-plane rotation (degrees, board frame) and translation (mm, board frame). */
    thetaDeg: number;
    dx: number;
    dy: number;
    /** Max pad residual (mm) after mapping KiCad's pads onto ours. */
    residual: number;
    /** 'exact' = constellation proof passed; 'centroid' = centers matched (substituted body or
     *  loose fit); 'unverified' = no anchor data, legacy zero transform. */
    mode: 'exact' | 'centroid' | 'unverified';
}

export interface InjectModelsResult {
    /** The .kicad_pcb with `(model ...)` refs injected into every matched footprint. */
    kicadPcb: string;
    /** How many footprint instances received a body. */
    injected: number;
    /** Distinct footprint ids with NO curated body (surface as a diagnostic; never silently drop). */
    unmatched: Array<{ id: string; count: number }>;
    /** Per-instance alignment decisions (proof data — surfaced by the harness, never silent). */
    alignments: ModelAlignment[];
    /** Families whose constellation proof FAILED (fell back to centroid) or had no anchor data. */
    warnings: string[];
}

// ---------------------------------------------------------------- footprint-block parsing
// The generated .kicad_pcb is machine-emitted s-expr text; we parse pad positions with a small
// quote-aware balanced-paren scanner (regexes cannot pair nested (at ...) nodes reliably).

interface Pad2 {
    n: string;
    x: number;
    y: number;
}

interface FootprintBlock {
    /** Index of `(` opening the footprint node. */
    start: number;
    /** Index just past the matching `)`. */
    end: number;
    id: string;
    pads: Pad2[];
    hasModel: boolean;
    /** Insertion point for the model ref: just after the closing quote of the id. */
    insertAt: number;
}

/** Find the index just past the paren that closes the node opening at `open`. */
function closeOf(text: string, open: number): number {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
            i++;
            while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
        } else if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) return i + 1;
    }
    return text.length;
}

export function parseFootprintBlocks(kicadPcb: string): FootprintBlock[] {
    const out: FootprintBlock[] = [];
    const re = /\(footprint\s*\n\s*"(tscircuit:[^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(kicadPcb))) {
        const start = m.index;
        const end = closeOf(kicadPcb, start);
        const body = kicadPcb.slice(start, end);
        const pads: Pad2[] = [];
        const padRe = /\(pad\s+"([^"]*)"/g;
        let p: RegExpExecArray | null;
        while ((p = padRe.exec(body))) {
            const padEnd = closeOf(body, p.index);
            const at = /\(at\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(body.slice(p.index, padEnd));
            if (at) pads.push({ n: p[1]!, x: Number(at[1]), y: Number(at[2]) });
            padRe.lastIndex = padEnd;
        }
        out.push({
            start,
            end,
            id: m[1]!,
            pads,
            hasModel: body.includes('(model '),
            insertAt: m.index + m[0].length,
        });
    }
    return out;
}

// ---------------------------------------------------------------- constellation alignment
// KiCad's official STEP bodies are exported PRE-ALIGNED to KiCad's own footprint origin. tscircuit
// footprints for the same package may use a different origin/orientation (TO-220: KiCad anchors at
// pin 1, tscircuit centers → body lands 2.54mm off; PinHeader: KiCad is vertical, tscircuit
// horizontal → body faces the wrong way). Instead of assuming origins match (the bug this replaced),
// we SOLVE the in-plane rotation (0/90/180/270) + translation mapping KiCad's pad constellation onto
// ours, pad-number to pad-number, and prove it by residual. No hand-tuned offsets anywhere.

const EXACT_TOL_MM = 0.15;

export interface AlignSolution {
    thetaDeg: number;
    dx: number;
    dy: number;
    residual: number;
}

function rot(theta: number, x: number, y: number): [number, number] {
    const c = Math.cos((theta * Math.PI) / 180);
    const s = Math.sin((theta * Math.PI) / 180);
    return [c * x - s * y, s * x + c * y];
}

/** Solve ours ≈ R(θ)·theirs + d over pads shared BY NAME; least-squares d per θ candidate. */
export function solveAlignment(ours: Pad2[], theirs: Pad2[]): AlignSolution | null {
    const theirByName = new Map(theirs.map((p) => [p.n, p]));
    const pairs = ours.filter((p) => theirByName.has(p.n)).map((p) => [p, theirByName.get(p.n)!] as const);
    if (pairs.length === 0) return null;
    let best: AlignSolution | null = null;
    for (const theta of [0, 90, 180, 270]) {
        let dx = 0;
        let dy = 0;
        for (const [our, their] of pairs) {
            const [rx, ry] = rot(theta, their.x, their.y);
            dx += our.x - rx;
            dy += our.y - ry;
        }
        dx /= pairs.length;
        dy /= pairs.length;
        let residual = 0;
        for (const [our, their] of pairs) {
            const [rx, ry] = rot(theta, their.x, their.y);
            residual = Math.max(residual, Math.hypot(our.x - (rx + dx), our.y - (ry + dy)));
        }
        if (!best || residual < best.residual) best = { thetaDeg: theta === 270 ? -90 : theta, dx, dy, residual };
    }
    return best;
}

function centroid(pads: Pad2[]): [number, number] {
    let x = 0;
    let y = 0;
    for (const p of pads) {
        x += p.x;
        y += p.y;
    }
    return pads.length ? [x / pads.length, y / pads.length] : [0, 0];
}

/** Model families whose body is a deliberate SUBSTITUTION (different package than the pads), where a
 *  constellation proof cannot exist by design — centroid alignment is the correct policy. */
const CENTROID_POLICY = [/^LED_D5\.0mm/];

const fmt = (n: number) => {
    const r = Math.round(n * 10000) / 10000;
    return Object.is(r, -0) ? '0' : String(r);
};

/**
 * Inject a `(model ...)` reference into every footprint of a generated .kicad_pcb, with the body
 * transform SOLVED from pad geometry (KiCad anchor data harvested from the pinned image by
 * scripts/extract-kicad-anchors.mjs) — see the alignment note above. Idempotent: footprints that
 * already contain a model are skipped.
 *
 * KiCad model-transform conventions (verified against kicad-cli glb export):
 *  - offset (xyz X Y Z): millimetres; X = board +x, Y = -(board +y) (3D y-up), applied AFTER rotation.
 *  - rotate (xyz .. .. Z): degrees; the FILE stores the negation of the 3D CCW angle, which equals
 *    the board-frame math angle θ directly (board y-down mirrors the sign back).
 */
export function injectModels(kicadPcb: string, base: string = KICAD_3DMODEL_BASE): InjectModelsResult {
    const unmatched = new Map<string, number>();
    const alignments: ModelAlignment[] = [];
    const warnings = new Set<string>();
    let injected = 0;

    const blocks = parseFootprintBlocks(kicadPcb);
    let out = kicadPcb;
    for (const block of [...blocks].reverse()) { // reverse: string edits keep earlier indices valid
        if (block.hasModel) continue;
        const model = resolveModel(block.id, base);
        if (!model) {
            unmatched.set(block.id, (unmatched.get(block.id) ?? 0) + 1);
            continue;
        }
        const basename = model.split('/').pop()!.replace(/\.step$/i, '');
        const anchor = (KICAD_ANCHORS as Record<string, KicadAnchor | undefined>)[basename];

        let align: ModelAlignment;
        if (!anchor) {
            align = { id: block.id, model: basename, thetaDeg: 0, dx: 0, dy: 0, residual: NaN, mode: 'unverified' };
            warnings.add(`${basename}: no anchor data — body alignment UNVERIFIED (re-run extract-kicad-anchors)`);
        } else if (CENTROID_POLICY.some((re) => re.test(basename))) {
            const [ox, oy] = centroid(block.pads);
            const [tx, ty] = centroid(anchor.pads);
            align = { id: block.id, model: basename, thetaDeg: 0, dx: ox - tx, dy: oy - ty, residual: 0, mode: 'centroid' };
        } else {
            const sol = solveAlignment(block.pads, anchor.pads);
            if (sol && sol.residual <= EXACT_TOL_MM) {
                align = { id: block.id, model: basename, ...sol, mode: 'exact' };
            } else {
                const [ox, oy] = centroid(block.pads);
                const [tx, ty] = centroid(anchor.pads);
                align = {
                    id: block.id, model: basename, thetaDeg: sol?.thetaDeg ?? 0,
                    dx: ox - tx, dy: oy - ty, residual: sol?.residual ?? NaN, mode: 'centroid',
                };
                warnings.add(`${basename}: constellation residual ${sol ? sol.residual.toFixed(3) : 'n/a'}mm > ${EXACT_TOL_MM}mm — centroid fallback (pad geometry differs from KiCad's)`);
            }
        }
        alignments.push(align);
        injected++;
        const ref =
            `\n    (model "${model}"\n      (offset (xyz ${fmt(align.dx)} ${fmt(-align.dy)} 0)) ` +
            `(scale (xyz 1 1 1)) (rotate (xyz 0 0 ${fmt(align.thetaDeg)})))`;
        out = out.slice(0, block.insertAt) + ref + out.slice(block.insertAt);
    }

    return {
        kicadPcb: out,
        injected,
        unmatched: [...unmatched.entries()].map(([id, count]) => ({ id, count })),
        alignments: alignments.reverse(),
        warnings: [...warnings],
    };
}
