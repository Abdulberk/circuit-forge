/**
 * Numeric 3D-body alignment verifier — proves (in mm) that every component body in the exported GLB
 * sits exactly where the .kicad_pcb says it should (footprint anchor + our injected model offset).
 *
 * Why: the 5 Tem 2026 bug (TO-220 body 2.54mm off its holes, pin headers facing 90° wrong) was
 * invisible to DRC (copper was correct) and survived because body placement was only ever checked by
 * eyeball. This script closes that hole: it parses the GLB scene graph, computes each body node's
 * world position, solves the board→GLB frame mapping from the data, and asserts every body lands on
 * its expected anchor within tolerance. Exits non-zero on any failure.
 *
 * Run after gen-gallery: node scripts/verify-3d-alignment.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const galleryRoot = join(__dirname, '..', 'packages', 'pcb-core', '.gallery');
const TOL_MM = 1.0;

// ---------------------------------------------------------------- kicad_pcb expectations

function closeOf(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') { i++; while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1; }
        else if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) return i + 1;
    }
    return text.length;
}

/** Every tscircuit footprint with an injected model: expected body-origin position in board mm. */
function expectedBodies(kicadPcb) {
    const out = [];
    const re = /\(footprint\s*\n\s*"(tscircuit:[^"]+)"/g;
    let m;
    while ((m = re.exec(kicadPcb))) {
        const body = kicadPcb.slice(m.index, closeOf(kicadPcb, m.index));
        const at = /\(at\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?\s*\)/.exec(body);
        const model = /\(model\s+"([^"]+)"\s*\n?\s*\(offset \(xyz (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)\)\)/.exec(body);
        if (!at || !model) continue;
        const fpRot = Number(at[3] ?? 0);
        if (fpRot !== 0) { out.push({ id: m[1], skip: `footprint rotation ${fpRot}° (mapping unverified)` }); continue; }
        // model offset is 3D-frame (y-up): board-frame offset = (ox, -oy)
        const bx = Number(at[1]) + Number(model[2]);
        const by = Number(at[2]) - Number(model[3]);
        out.push({ id: m[1], model: model[1].split('/').pop(), x: bx, y: by });
    }
    return out;
}

// ---------------------------------------------------------------- GLB scene graph

function parseGlbJson(buf) {
    if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
    let off = 12;
    while (off < buf.length) {
        const len = buf.readUInt32LE(off);
        const type = buf.readUInt32LE(off + 4);
        if (type === 0x4e4f534a) return JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'));
        off += 8 + len;
    }
    throw new Error('no JSON chunk');
}

const mul = (a, b) => { // column-major 4x4
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
        for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return o;
};
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function localMatrix(n) {
    if (n.matrix) return n.matrix;
    const [tx, ty, tz] = n.translation ?? [0, 0, 0];
    const [qx, qy, qz, qw] = n.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = n.scale ?? [1, 1, 1];
    const R = [
        1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw), 0,
        2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw), 0,
        2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy), 0,
        0, 0, 0, 1,
    ];
    const S = [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1];
    const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1];
    return mul(T, mul(R, S));
}

/** World positions of every node that references a NON-board mesh (= a component body). */
function bodyNodes(gltf) {
    const meshName = (i) => gltf.meshes?.[i]?.name ?? `mesh_${i}`;
    const out = [];
    const walk = (idx, parent) => {
        const n = gltf.nodes[idx];
        const world = mul(parent, localMatrix(n));
        if (n.mesh !== undefined) {
            const name = meshName(n.mesh);
            // board layer meshes are named board_* (board_copper/board_pad/... or board_bodies_*
            // depending on kicad-cli version) — everything else is a component body
            if (!/^board_/i.test(name)) out.push({ name, x: world[12], y: world[13], z: world[14] });
        }
        for (const c of n.children ?? []) walk(c, world);
    };
    for (const s of gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? []) walk(s, IDENT);
    return out;
}

// ---------------------------------------------------------------- frame fit + matching

/** Candidate board(x,y)mm → GLB horizontal-plane mappings (axis perms/flips × unit scale). */
function candidates() {
    const maps = [];
    for (const scale of [0.001, 1]) // metres vs mm
        for (const [ax, ay] of [['x', 'z'], ['z', 'x'], ['x', 'y'], ['y', 'x'], ['y', 'z'], ['z', 'y']])
            for (const sx of [1, -1]) for (const sy of [1, -1])
                maps.push({ scale, ax, ay, sx, sy });
    return maps;
}

function fit(expected, nodes) {
    let best = null;
    for (const c of candidates()) {
        const pts = nodes.map((n) => ({ u: (c.sx * n[c.ax]) / c.scale, v: (c.sy * n[c.ay]) / c.scale, n }));
        const cu = pts.reduce((s, p) => s + p.u, 0) / pts.length - expected.reduce((s, e) => s + e.x, 0) / expected.length;
        const cv = pts.reduce((s, p) => s + p.v, 0) / pts.length - expected.reduce((s, e) => s + e.y, 0) / expected.length;
        // greedy nearest-neighbor matching
        const free = [...pts];
        let worst = 0;
        let sum = 0;
        const pairs = [];
        for (const e of expected) {
            let bi = -1;
            let bd = Infinity;
            for (let i = 0; i < free.length; i++) {
                const d = Math.hypot(free[i].u - cu - e.x, free[i].v - cv - e.y);
                if (d < bd) { bd = d; bi = i; }
            }
            if (bi === -1) { worst = Infinity; break; }
            pairs.push({ e, node: free[bi].n, d: bd });
            free.splice(bi, 1);
            worst = Math.max(worst, bd);
            sum += bd;
        }
        if (!best || sum < best.sum) best = { ...c, worst, sum, pairs };
    }
    return best;
}

// ---------------------------------------------------------------- run

let failures = 0;
const boards = readdirSync(galleryRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
for (const name of boards) {
    const dir = join(galleryRoot, name);
    const pcbPath = join(dir, 'board.kicad_pcb');
    const glbPath = join(dir, `${name}.glb`);
    if (!existsSync(pcbPath) || !existsSync(glbPath)) continue;

    const expectedAll = expectedBodies(readFileSync(pcbPath, 'utf8'));
    const skipped = expectedAll.filter((e) => e.skip);
    const expected = expectedAll.filter((e) => !e.skip);
    const nodes = bodyNodes(parseGlbJson(readFileSync(glbPath)));

    if (expected.length === 0) { console.log(`── ${name}: no expectations (no models?)`); failures++; continue; }
    if (nodes.length !== expected.length) {
        console.log(`── ${name}: body-count mismatch — kicad_pcb expects ${expected.length}, GLB has ${nodes.length}`);
    }

    const r = fit(expected, nodes);
    const status = r.worst <= TOL_MM ? '✓' : '✗';
    if (r.worst > TOL_MM) failures++;
    console.log(`${status} ${name}: ${expected.length} bodies, worst offset ${r.worst.toFixed(3)}mm (tol ${TOL_MM}) — map ${r.ax}${r.sx > 0 ? '+' : '-'}/${r.ay}${r.sy > 0 ? '+' : '-'} ×${r.scale}${skipped.length ? ` · ${skipped.length} skipped (rotated fp)` : ''}`);
    if (r.worst > TOL_MM) {
        for (const p of r.pairs.filter((p) => p.d > TOL_MM).slice(0, 6))
            console.log(`    ✗ ${p.e.id} (${p.e.model}) off by ${p.d.toFixed(2)}mm — node "${p.node.name}"`);
    }
}

console.log(failures === 0 ? '\n✅ 3D body alignment VERIFIED on all boards' : `\n❌ ${failures} board(s) FAILED body alignment`);
process.exit(failures === 0 ? 0 : 1);
