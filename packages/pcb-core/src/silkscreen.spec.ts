/**
 * The clamp that decides whether a board arrives with its part labels on it.
 *
 * The numbers in these tests are the ones measured off our own delivered gerbers on 2 Aug 2026 — 0.267 mm
 * designators drawn with a 0.033 mm pen — rather than invented small values, so a regression reproduces
 * the real defect rather than a plausible-looking stand-in.
 */
import { clampSilkscreen, TEXT_STROKE_RATIO } from './silkscreen';

const LIMITS = { minWidthMm: 0.15, minTextHeightMm: 0.8 };

/** A designator exactly as the converter emits one for an 0603 part. */
const designator = (size: number, thickness: number): string =>
    `  (fp_text user "R1"
    (at 0 0 0)
    (layer "F.SilkS")
    (effects
      (font
        (size ${size} ${size})
        (thickness ${thickness})
      )
    )
  )`;

const silkLine = (width: number): string =>
    `  (fp_line
    (start -0.2 -0.5)
    (end 0.2 -0.5)
    (stroke
      (width ${width})
      (type solid)
    )
    (layer "F.SilkS")
  )`;

const copperLine = (width: number): string =>
    `  (fp_line
    (start -0.2 -0.5)
    (end 0.2 -0.5)
    (stroke
      (width ${width})
      (type solid)
    )
    (layer "F.Cu")
  )`;

describe('bringing the legend up to what a fab will print', () => {
    it('raises a designator that would have been deleted, and says how many', () => {
        const r = clampSilkscreen(designator(0.267, 0.05), LIMITS);
        expect(r.heightsClamped).toBe(1);
        expect(r.widthsClamped).toBe(1);
        expect(r.smallestTextMm).toBeCloseTo(0.267, 3);
        expect(r.thinnestFoundMm).toBeCloseTo(0.05, 3);
    });

    it('sizes text so the RENDERED stroke reaches the floor, not merely the declared one', () => {
        // The measured trap: KiCad draws footprint glyphs at size ÷ 8 and ignores `(thickness)` entirely,
        // so 0.8 mm text renders a 0.1 mm pen — under the 0.15 mm floor, and still silently deleted. The
        // height therefore has to be DERIVED from the width, and a caller's smaller legibility floor must
        // not be able to undercut it.
        const r = clampSilkscreen(designator(0.267, 0.05), LIMITS);
        const size = /\(size ([\d.]+) ([\d.]+)\)/.exec(r.kicadPcb)!;
        expect(Number(size[1])).toBeGreaterThanOrEqual(LIMITS.minWidthMm * TEXT_STROKE_RATIO);
        expect(Number(size[1])).toBeCloseTo(1.2, 6);
        expect(Number(size[1])).toBe(Number(size[2])); // square glyph stays square
    });

    it('honours a LARGER legibility floor when the caller asks for one', () => {
        const r = clampSilkscreen(designator(0.267, 0.05), { minWidthMm: 0.1, minTextHeightMm: 2 });
        expect(Number(/\(size ([\d.]+)/.exec(r.kicadPcb)![1])).toBeCloseTo(2, 6);
    });

    it('leaves art that is already printable exactly as it was', () => {
        const already = designator(1.27, 0.15) + '\n' + silkLine(0.2);
        const r = clampSilkscreen(already, LIMITS);
        expect(r.widthsClamped).toBe(0);
        expect(r.heightsClamped).toBe(0);
        expect(r.kicadPcb).toBe(already);
    });

    it('NEVER touches copper — a clamp that widened a trace would be a catastrophe, not a cosmetic bug', () => {
        const board = copperLine(0.05) + '\n' + silkLine(0.05);
        const r = clampSilkscreen(board, LIMITS);
        expect(r.widthsClamped).toBe(1); // the silk line only
        expect(r.kicadPcb).toContain(copperLine(0.05)); // copper byte-identical
    });

    it('reads the nested block correctly — the size lives three levels inside the text element', () => {
        // The reason this is a paren-balancing scan and not a regex: a non-greedy match to the first `)`
        // stops inside `(font`, a greedy one swallows the rest of the file, and both clamp wrong numbers
        // while reporting a confident count.
        const two = designator(0.267, 0.05) + '\n' + designator(0.333, 0.05);
        const r = clampSilkscreen(two, LIMITS);
        expect(r.heightsClamped).toBe(2);
        expect([...r.kicadPcb.matchAll(/\(size ([\d.]+)/g)].map((m) => Number(m[1]))).toEqual([1.2, 1.2]);
    });

    it('scales both axes by the SAME factor, so a non-square glyph is not distorted', () => {
        const tall = designator(0.4, 0.15).replace('(size 0.4 0.4)', '(size 0.4 0.8)');
        const r = clampSilkscreen(tall, LIMITS);
        const m = /\(size ([\d.]+) ([\d.]+)\)/.exec(r.kicadPcb)!;
        expect(Number(m[2]) / Number(m[1])).toBeCloseTo(2, 6);
        expect(Number(m[1])).toBeCloseTo(1.2, 6); // the SMALLER axis is what has to clear the floor
    });

    it('reports nothing to clamp on a board with no silkscreen at all', () => {
        const r = clampSilkscreen(copperLine(0.05), LIMITS);
        expect(r).toMatchObject({ widthsClamped: 0, heightsClamped: 0, thinnestFoundMm: null, smallestTextMm: null });
    });
});
