/**
 * Make the printing on the board printable, and the labels readable.
 *
 * WHAT WAS MEASURED, 2 Aug 2026. The delivered front silkscreen of every gallery board draws 84 strokes at
 * 0.0333 mm and 65 at 0.0417 mm. Every fab's floor is far above that — JLCPCB and PCBWay 0.15 mm,
 * Eurocircuits 0.10 mm, OSH Park 0.127 mm — and a fab does not reject a board for it. It DELETES the
 * offending art and builds the rest, which Eurocircuits states outright: "Any legend line smaller than the
 * Minimum Line Width will be removed." So the board arrives looking fine and carrying nothing.
 *
 * And the strokes that thin are not decoration. They are the reference designators: `R1`, `R2`, `LED1`,
 * emitted at 0.267 mm tall because the converter scales a label to the part it belongs to, and a 0603
 * resistor is 1.6 mm long. That scaling is reasonable on a screen, where you can zoom, and wrong on
 * copper, where you cannot. A technician holding the board has no way to tell which resistor is R2.
 *
 * Hence BOTH clamps, because either alone produces something worse than the defect:
 *   • thickness alone → a 0.267 mm glyph drawn with a 0.15 mm pen is a solid blob of ink, printed and
 *     illegible rather than absent and illegible;
 *   • height alone → legible geometry the fab still erases.
 *
 * Nothing here is silent. Every clamp is counted and returned, because "we quietly enlarged your board's
 * lettering" is exactly the kind of unannounced change that makes a later silk-over-pad complaint
 * impossible to explain.
 *
 * WHY IN THE BOARD FILE, not as a KiCad design rule: KiCad has no rule for silkscreen LINE width. It
 * constrains text thickness and height (`min_text_thickness`, `min_text_height`) and our text already
 * satisfies those, so the notary can never enforce this. It has to be true of the geometry we hand over.
 */

/** Silk layer names as KiCad writes them, quoted or bare. */
const SILK = /\(layer\s+"?[FB]\.SilkS"?\)/;

/** The blocks that can put ink on a silkscreen layer. */
const DRAWABLE =
    /\((fp_text|gr_text|fp_line|fp_rect|fp_circle|fp_arc|fp_poly|gr_line|gr_rect|gr_circle|gr_arc|gr_poly)\b/g;

/**
 * Rendered glyph stroke = font size ÷ 8, MEASURED against the pinned KiCad 10 image (2 Aug 2026) rather
 * than assumed, because the assumption was wrong in the expensive direction.
 *
 *   size 0.8 → 0.1000    size 1.0 → 0.1250    size 1.2 → 0.1500    size 1.5 → 0.1875
 *
 * and the declared `(thickness ...)` makes NO difference: size 1.2 with thickness 0.2 still renders 0.15,
 * size 1.5 with thickness 0.15 renders 0.1875. So for footprint text the thickness field is inert and the
 * ONLY lever on printable stroke width is the character height. A first attempt clamped thickness to
 * 0.15 mm, exported, and measured 156 draws still at 0.1 mm — which is why this constant exists as a
 * measurement with its evidence attached instead of a plausible-looking ratio.
 *
 * Consequence worth stating: the fab's real constraint is the STROKE, and the height needed to reach it
 * is derived, not chosen. Asking for a 0.15 mm legend means asking for 1.2 mm characters.
 */
export const TEXT_STROKE_RATIO = 8;

export interface SilkLimits {
    /** Narrowest stroke the fab will print rather than discard. */
    minWidthMm: number;
    /** Shortest character height worth printing — below this a designator is ink, not information. */
    minTextHeightMm: number;
}

export interface SilkClampResult {
    kicadPcb: string;
    /** Strokes widened (lines, arcs, polygons and text pen widths). */
    widthsClamped: number;
    /** Text elements enlarged. */
    heightsClamped: number;
    /** The thinnest stroke found BEFORE clamping — evidence, so the report can state what was actually wrong. */
    thinnestFoundMm: number | null;
    /** The smallest text height found before clamping. */
    smallestTextMm: number | null;
}

/**
 * Extract the balanced-paren block starting at `start` (which must index a `(`).
 *
 * Regex cannot do this correctly — a `(fp_text)` contains `(effects (font (size ...)))`, and a
 * non-greedy match to the first `)` stops inside the font while a greedy one runs to the end of the file.
 * Both failure modes clamp the wrong numbers, which is worse than not clamping at all.
 */
function blockAt(src: string, start: number): { text: string; end: number } | null {
    let depth = 0;
    let inString = false;
    for (let i = start; i < src.length; i++) {
        const c = src[i]!;
        if (inString) {
            if (c === '\\') i++;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') inString = true;
        else if (c === '(') depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0) return { text: src.slice(start, i + 1), end: i + 1 };
        }
    }
    return null;
}

export function clampSilkscreen(kicadPcb: string, limits: SilkLimits): SilkClampResult {
    // The height that actually delivers the requested stroke, versus the height asked for as a legibility
    // floor — whichever is larger. Taking the caller's number alone would leave the art printable-looking
    // in the board file and still below the fab's floor once rendered, which is the exact failure measured
    // before TEXT_STROKE_RATIO was established.
    const minTextHeightMm = Math.max(limits.minTextHeightMm, limits.minWidthMm * TEXT_STROKE_RATIO);

    let widthsClamped = 0;
    let heightsClamped = 0;
    let thinnestFoundMm: number | null = null;
    let smallestTextMm: number | null = null;

    let out = '';
    let cursor = 0;
    DRAWABLE.lastIndex = 0;

    for (let m = DRAWABLE.exec(kicadPcb); m; m = DRAWABLE.exec(kicadPcb)) {
        // A match INSIDE a block already consumed (a nested fp_text, say) would rewrite text twice; skip
        // anything the previous block covered.
        if (m.index < cursor) continue;
        const block = blockAt(kicadPcb, m.index);
        if (!block) continue;
        if (!SILK.test(block.text)) continue;

        let text = block.text;

        // Stroke widths: `(width N)` inside `(stroke ...)` for graphics, and `(thickness N)` inside
        // `(font ...)` for text — the same physical pen, spelled two ways by the format.
        text = text.replace(/\((width|thickness)\s+([0-9.]+)\)/g, (whole, key: string, n: string) => {
            const v = Number(n);
            if (!Number.isFinite(v)) return whole;
            thinnestFoundMm = thinnestFoundMm === null ? v : Math.min(thinnestFoundMm, v);
            if (v >= limits.minWidthMm) return whole;
            widthsClamped++;
            return `(${key} ${limits.minWidthMm})`;
        });

        // Character size. Both axes are raised together: scaling one alone distorts the glyph, and a
        // stretched designator is a new kind of unreadable rather than a fix.
        text = text.replace(/\(size\s+([0-9.]+)\s+([0-9.]+)\)/g, (whole, w: string, h: string) => {
            const [wv, hv] = [Number(w), Number(h)];
            if (!Number.isFinite(wv) || !Number.isFinite(hv)) return whole;
            const smaller = Math.min(wv, hv);
            smallestTextMm = smallestTextMm === null ? smaller : Math.min(smallestTextMm, smaller);
            if (smaller >= minTextHeightMm) return whole;
            heightsClamped++;
            const scale = minTextHeightMm / smaller;
            return `(size ${round4(wv * scale)} ${round4(hv * scale)})`;
        });

        out += kicadPcb.slice(cursor, m.index) + text;
        cursor = block.end;
    }
    out += kicadPcb.slice(cursor);

    return { kicadPcb: out, widthsClamped, heightsClamped, thinnestFoundMm, smallestTextMm };
}

function round4(n: number): number {
    return Math.round(n * 10000) / 10000;
}
