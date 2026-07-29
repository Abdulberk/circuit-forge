/**
 * Prove the 3D viewer can still tell a circuit board from a component.
 *
 * WHY THIS EXISTS. The viewer decides every material from a mesh's NAME: `board_soldermask` gets the
 * semi-gloss dielectric, `board_pad` gets ENIG gold, everything else is a component body. It read that
 * name off `Object3D.name` — and three.js's GLTFLoader overwrites that field with the glTF NODE name.
 * KiCad names its board-layer nodes `=>[0:1:1:16]`, so every board layer classified as a component, no
 * layer material was ever applied, and the soldermask rendered through the component path, which keeps
 * glTF's default `metalness: 1`. The board shipped as a slab of green metal and nothing said a word:
 * there is no error, no warning, and no assertion anywhere that a render "looks like a PCB".
 *
 * So this is the assertion. It loads the REAL GLBs the pipeline produced, through the REAL loader, and
 * checks that all six board layers are recovered and classified — headless, no GPU, no browser. A loader
 * upgrade that changes the naming rules, or a KiCad version that renames its layers, turns this red
 * instead of quietly turning our boards back into metal.
 *
 * Usage: node scripts/verify-3d-materials.mjs [glb-dir]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GLTFLoader } from '../apps/pcb-viewer/node_modules/three/examples/jsm/loaders/GLTFLoader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GLB_DIR = process.argv[2] ?? join(HERE, '..', 'apps', 'pcb-viewer', 'public');

/**
 * The board's own layers. Five are unconditional — every board has a substrate, copper, pads, mask and
 * silkscreen. `via` is not: a two-layer board a router finished on one side has no vias to model, and
 * KiCad then emits no via mesh (measured: 5 of our 8 gallery boards route via-free). Demanding it would
 * fail correct boards, so it is reported rather than required.
 */
const BOARD_LAYERS = ['copper', 'pad', 'silkscreen', 'soldermask', 'pcb'];

/** Kept byte-identical to the viewer's own `layerOf` — if they drift, this check stops meaning anything. */
const layerOf = (name) => {
    const m = /^board_(copper|pad|via|silkscreen|soldermask|pcb)$/i.exec(name.trim());
    return m ? m[1].toLowerCase() : 'part';
};

/** The viewer's name recovery: the glTF MESH name via the loader's association map, not `Object3D.name`. */
const meshNameOf = (parser, object) => {
    const idx = parser.associations?.get(object)?.meshes;
    return (idx === undefined ? undefined : parser.json?.meshes?.[idx]?.name) ?? object.name;
};

const loadGlb = (file) =>
    new Promise((resolve, reject) => {
        const buf = readFileSync(file);
        // `parse` takes the bytes directly — no FileLoader, so no XHR/fetch and no DOM.
        new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', resolve, reject);
    });

const files = readdirSync(GLB_DIR)
    .filter((f) => f.endsWith('.glb'))
    .sort();
if (files.length === 0) {
    console.error(`No .glb files in ${GLB_DIR} — nothing to verify.`);
    process.exit(1);
}

let failures = 0;
for (const file of files) {
    const gltf = await loadGlb(join(GLB_DIR, file));
    const found = new Set();
    let parts = 0;
    let pathTokens = 0;
    gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const name = meshNameOf(gltf.parser, o);
        // `=>[0:1:1:16]` is the node path token the loader used to leak through. Seeing one here means the
        // recovery itself broke, which is the exact regression this file exists to catch.
        if (name.startsWith('=>[')) pathTokens++;
        const layer = layerOf(name);
        if (layer === 'part') parts++;
        else found.add(layer);
    });

    const missing = BOARD_LAYERS.filter((l) => !found.has(l));
    const ok = missing.length === 0 && parts > 0 && pathTokens === 0;
    if (!ok) failures++;
    const detail = [
        missing.length ? `MISSING ${missing.join(',')}` : `${BOARD_LAYERS.length}/${BOARD_LAYERS.length} layers`,
        found.has('via') ? '+via' : 'no vias (via-free route)',
        `${parts} component mesh(es)`,
        pathTokens ? `${pathTokens} UNRESOLVED node path token(s)` : null,
    ]
        .filter(Boolean)
        .join(' · ');
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${file.padEnd(24)} ${detail}`);
}

console.log(`\n${files.length - failures}/${files.length} board(s) classify correctly.`);
process.exit(failures === 0 ? 0 : 1);
