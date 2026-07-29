/**
 * Harvest KiCad footprint anchor data (pad constellations + native model transforms) from the
 * PINNED kicad/kicad:10.0-full Docker image into a GENERATED TypeScript module.
 *
 * Why: KiCad's official 3D STEP bodies are exported pre-aligned to THEIR footprint's origin.
 * tscircuit's footprints for the same package can use a different origin/orientation (e.g. TO-220:
 * KiCad = pin-1 anchor, tscircuit = centered → body lands 2.54 mm off; PinHeader: KiCad = vertical,
 * tscircuit = horizontal → body faces the wrong way). injectModels() aligns bodies by matching pad
 * constellations — the reference constellation comes from KiCad's own .kicad_mod files via THIS
 * script. Data is harvested from the source of truth, never hand-tuned; re-run after bumping the
 * KiCad image.
 *
 * Run: node scripts/extract-kicad-anchors.mjs   (needs Docker + kicad/kicad:10.0-full)
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'packages', 'pcb-core', 'src', 'kicad-anchors.generated.ts');
const IMAGE = 'kicad/kicad:10.0-full';
const FP_ROOT = '/usr/share/kicad/footprints';

/** Model step basename -> footprint .kicad_mod path (inside the image). Covers every model
 *  models3d.ts can inject. PinHeader sizes 2..8 cover pinrowN growth. */
const TARGETS = {
    'TO-220-3_Vertical': 'Package_TO_SOT_THT.pretty/TO-220-3_Vertical.kicad_mod',
    'SOT-23': 'Package_TO_SOT_SMD.pretty/SOT-23.kicad_mod',
    'TO-92': 'Package_TO_SOT_THT.pretty/TO-92.kicad_mod',
    'D_SOD-123': 'Diode_SMD.pretty/D_SOD-123.kicad_mod',
    'LED_D5.0mm': 'LED_THT.pretty/LED_D5.0mm.kicad_mod',
    'SOIC-8_3.9x4.9mm_P1.27mm': 'Package_SO.pretty/SOIC-8_3.9x4.9mm_P1.27mm.kicad_mod',
    'SOIC-14_3.9x8.7mm_P1.27mm': 'Package_SO.pretty/SOIC-14_3.9x8.7mm_P1.27mm.kicad_mod',
    'SOIC-16_3.9x9.9mm_P1.27mm': 'Package_SO.pretty/SOIC-16_3.9x9.9mm_P1.27mm.kicad_mod',
};
for (let n = 2; n <= 8; n++) {
    const nn = String(n).padStart(2, '0');
    TARGETS[`PinHeader_1x${nn}_P2.54mm_Vertical`] =
        `Connector_PinHeader_2.54mm.pretty/PinHeader_1x${nn}_P2.54mm_Vertical.kicad_mod`;
}
for (const size of ['0402_1005', '0603_1608', '0805_2012', '1206_3216']) {
    const [imp, met] = size.split('_');
    TARGETS[`R_${imp}_${met}Metric`] = `Resistor_SMD.pretty/R_${imp}_${met}Metric.kicad_mod`;
    TARGETS[`C_${imp}_${met}Metric`] = `Capacitor_SMD.pretty/C_${imp}_${met}Metric.kicad_mod`;
    TARGETS[`L_${imp}_${met}Metric`] = `Inductor_SMD.pretty/L_${imp}_${met}Metric.kicad_mod`;
}

// ---------------------------------------------------------------- minimal s-expr parser

function parseSexpr(text) {
    let i = 0;
    function node() {
        const out = [];
        i++; // consume (
        while (i < text.length) {
            const ch = text[i];
            if (ch === '(') out.push(node());
            else if (ch === ')') {
                i++;
                return out;
            } else if (ch === '"') {
                let j = i + 1,
                    s = '';
                while (j < text.length && text[j] !== '"') {
                    s += text[j] === '\\' ? text[++j] : text[j];
                    j++;
                }
                out.push(s);
                i = j + 1;
            } else if (/\s/.test(ch)) i++;
            else {
                let j = i,
                    s = '';
                while (j < text.length && !/[\s()"]/.test(text[j])) {
                    s += text[j];
                    j++;
                }
                out.push(s);
                i = j;
            }
        }
        return out;
    }
    while (i < text.length && text[i] !== '(') i++;
    return node();
}
const kids = (n, tag) => n.filter((c) => Array.isArray(c) && c[0] === tag);
const kid = (n, tag) => kids(n, tag)[0];

function extract(modText, file) {
    const root = parseSexpr(modText);
    const pads = kids(root, 'pad')
        .map((p) => {
            const at = kid(p, 'at') ?? [];
            return { n: String(p[1]), x: Number(at[1] ?? 0), y: Number(at[2] ?? 0) };
        })
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    const model = kid(root, 'model');
    const xyzOf = (tag) => {
        const t = model ? kid(model, tag) : null;
        const v = t ? kid(t, 'xyz') : null;
        return v ? [Number(v[1]), Number(v[2]), Number(v[3])] : [0, 0, 0];
    };
    return { file, pads, nativeOffset: xyzOf('offset'), nativeRotate: xyzOf('rotate') };
}

// ---------------------------------------------------------------- run

const anchors = {};
const missing = [];
for (const [name, rel] of Object.entries(TARGETS)) {
    try {
        const txt = execFileSync('docker', ['run', '--rm', IMAGE, 'cat', `${FP_ROOT}/${rel}`], {
            encoding: 'utf8',
            timeout: 120000,
            maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, MSYS_NO_PATHCONV: '1' },
        });
        anchors[name] = extract(txt, rel);
        console.log(
            `✓ ${name}: ${anchors[name].pads.length} pads, nativeOffset=[${anchors[name].nativeOffset}], nativeRotate=[${anchors[name].nativeRotate}]`,
        );
    } catch {
        missing.push(name);
        console.warn(`✗ ${name}: ${rel} not found in image — skipped`);
    }
}

const banner = `/**
 * GENERATED by scripts/extract-kicad-anchors.mjs from ${IMAGE} — DO NOT EDIT BY HAND.
 * Pad constellations (footprint-local mm, KiCad y-down) + native model transforms for every KiCad
 * 3D body models3d.ts can inject. injectModels() aligns bodies by solving rotation+translation from
 * OUR pads onto these reference pads (proof-by-residual), instead of assuming matching origins.
 * Re-run the script after bumping the KiCad image.${missing.length ? `\n * MISSING IN IMAGE: ${missing.join(', ')}` : ''}
 */
export interface KicadAnchor {
    file: string;
    pads: Array<{ n: string; x: number; y: number }>;
    nativeOffset: [number, number, number];
    nativeRotate: [number, number, number];
}

export const KICAD_ANCHORS: Record<string, KicadAnchor> = `;

writeFileSync(
    OUT,
    banner + JSON.stringify(anchors, null, 4).replace(/"([A-Za-z_][A-Za-z0-9_]*)":/g, '$1:') + ' as const;\n',
);
console.log(
    `\nwrote ${OUT} (${Object.keys(anchors).length} anchors${missing.length ? `, ${missing.length} missing` : ''})`,
);
