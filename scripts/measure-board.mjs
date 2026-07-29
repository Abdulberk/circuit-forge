/**
 * Measure a generated board the way a customer would experience it, from the FILES rather than from the
 * pipeline's own account of itself.
 *
 * WHY SEPARATE FROM THE PIPELINE. Every number the layout pipeline reports is computed by the same code
 * that produced the board, so a mistake in that code produces a matching mistake in its report and the two
 * agree perfectly. This reads the artifacts instead: the .kicad_pcb outline, the DRC report, the GLB. It
 * exists because a claim about a board that was never measured on the board is not a measurement — a
 * lesson this repo learned by shipping one.
 *
 * Usage: node scripts/measure-board.mjs <dir> [name]     → one JSON object on stdout
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const dir = process.argv[2];
if (!dir || !existsSync(dir)) {
    console.error('usage: measure-board.mjs <dir containing board.kicad_pcb>');
    process.exit(2);
}
const name = process.argv[3] ?? basename(dir);
const pcbPath = join(dir, 'board.kicad_pcb');
const pcb = existsSync(pcbPath) ? readFileSync(pcbPath, 'utf8') : null;

/** Edge.Cuts bounding box in mm — the outline the fab routes to, i.e. the board the customer pays for. */
function outline(src) {
    const xs = [];
    const ys = [];
    for (const m of src.matchAll(
        /\(gr_line\s+\(start ([-\d.]+) ([-\d.]+)\)\s+\(end ([-\d.]+) ([-\d.]+)\)[\s\S]{0,200}?Edge\.Cuts/g,
    )) {
        xs.push(+m[1], +m[3]);
        ys.push(+m[2], +m[4]);
    }
    if (!xs.length) return null;
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    return { widthMm: +w.toFixed(2), heightMm: +h.toFixed(2), areaMm2: Math.round(w * h) };
}

/** Copper/courtyard extent — what the board actually needs, so "empty laminate" is a measured quantity. */
function contentExtent(src) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const add = (x, y, hw = 0, hh = 0) => {
        minX = Math.min(minX, x - hw);
        maxX = Math.max(maxX, x + hw);
        minY = Math.min(minY, y - hh);
        maxY = Math.max(maxY, y + hh);
    };
    for (const m of src.matchAll(
        /\(segment\s*\(start ([-\d.]+) ([-\d.]+)\)\s*\(end ([-\d.]+) ([-\d.]+)\)\s*\(width ([\d.]+)\)/g,
    )) {
        const w = +m[5] / 2;
        add(+m[1], +m[2], w, w);
        add(+m[3], +m[4], w, w);
    }
    for (const m of src.matchAll(/\(via\s*\(at ([-\d.]+) ([-\d.]+)\)\s*\(size ([\d.]+)\)/g))
        add(+m[1], +m[2], +m[3] / 2, +m[3] / 2);
    for (const fp of blocks(src, 'footprint')) {
        const at = /\(at ([-\d.]+) ([-\d.]+)/.exec(fp);
        if (at) add(+at[1], +at[2]);
    }
    if (!Number.isFinite(minX)) return null;
    return { widthMm: +(maxX - minX).toFixed(2), heightMm: +(maxY - minY).toFixed(2) };
}

/** Visible designators, counting BOTH spellings the converter emits (see outputs.ts hasVisibleDesignators). */
function designators(src) {
    let visible = 0;
    let hidden = 0;
    for (const kind of ['fp_text', 'property']) {
        for (const b of blocks(src, kind)) {
            if (kind === 'property' && !/^\(property\s+"Reference"/.test(b)) continue;
            if (kind === 'fp_text' && !/^\(fp_text\s+reference\b/.test(b)) continue;
            if (!/\(layer "?[FB]\.SilkS/.test(b)) continue;
            if (/\(hide yes\)/.test(b)) hidden++;
            else visible++;
        }
    }
    return { visible, hidden };
}

/**
 * Every `(<tag> …)` s-expression in the file, balanced-paren scanned.
 *
 * Regex with a fixed `\n {4}\)` terminator looked fine and was wrong: the boards this tool compares are
 * serialized by two different writers — circuit-json-to-kicad indents with four spaces, and any board that
 * has passed through pcbnew (the zone fill does) comes back tab-indented. The regex silently matched zero
 * blocks on the second kind, so a board with nine labelled parts measured as having none. Counting by
 * structure rather than by whitespace is the only version of this that can be trusted across both.
 */
function blocks(src, tag) {
    const out = [];
    const open = new RegExp(`\\(${tag}[\\s)]`, 'g');
    let m;
    while ((m = open.exec(src))) {
        let depth = 0;
        let i = m.index;
        for (; i < src.length; i++) {
            // Quoted strings can contain parens (a footprint library name, a description) — skip them whole.
            if (src[i] === '"') {
                i++;
                while (i < src.length && (src[i] !== '"' || src[i - 1] === '\\')) i++;
                continue;
            }
            if (src[i] === '(') depth++;
            else if (src[i] === ')' && --depth === 0) break;
        }
        out.push(src.slice(m.index, i + 1));
        open.lastIndex = m.index + 1; // nested same-tag blocks stay reachable
    }
    return out;
}

/** The DRC report the board was judged by, if one was written next to it. */
function drc(d) {
    const f = join(d, 'drc.json');
    if (!existsSync(f)) return null;
    try {
        const r = JSON.parse(readFileSync(f, 'utf8'));
        const byType = {};
        for (const v of r.violations ?? []) byType[v.type] = (byType[v.type] ?? 0) + 1;
        return {
            violations: (r.violations ?? []).length,
            unconnected: (r.unconnected_items ?? []).length,
            clean: (r.violations ?? []).length === 0 && (r.unconnected_items ?? []).length === 0,
            byType,
        };
    } catch {
        return null;
    }
}

const glb = readdirSync(dir).find((f) => f.endsWith('.glb'));
const renders = readdirSync(dir).filter((f) => /^render-.*\.png$/.test(f));

const box = pcb ? outline(pcb) : null;
const content = pcb ? contentExtent(pcb) : null;
const wasteRatio =
    box && content && box.areaMm2 > 0
        ? +(1 - (content.widthMm * content.heightMm) / (box.widthMm * box.heightMm)).toFixed(3)
        : null;

console.log(
    JSON.stringify(
        {
            name,
            dir,
            outline: box,
            content,
            /** Share of the delivered board that carries nothing. Fabs price on area, so this is money. */
            emptyAreaFraction: wasteRatio,
            designators: pcb ? designators(pcb) : null,
            zones: pcb ? (pcb.match(/\(zone/g) ?? []).length : null,
            /** 0 means the copper pour exists in the file but has never been poured — invisible in 3D. */
            filledPolygons: pcb ? (pcb.match(/filled_polygon/g) ?? []).length : null,
            traces: pcb ? (pcb.match(/\(segment/g) ?? []).length : null,
            vias: pcb ? (pcb.match(/\(via\s/g) ?? []).length : null,
            footprints: pcb ? (pcb.match(/\(footprint\s/g) ?? []).length : null,
            drc: drc(dir),
            glb: glb ? { file: glb, bytes: statSync(join(dir, glb)).size } : null,
            renders,
        },
        null,
        2,
    ),
);
