/**
 * The supply marks, measured — because nothing measured them, and the drawing was wrong where nobody looked.
 *
 * A rail is the second-largest net in most designs and no schematic wires it: each terminal that reaches one
 * gets a supply port with the rail's NAME beside it. The name is the whole point — every ground symbol means
 * the same node and needs no label, while VCC and +3V3 are different nodes drawn with the same mark, so a
 * reader who cannot tell which rail a pin reaches is worse off than with a wire.
 *
 * Which makes the name's PLACE load-bearing, and it was not being checked. The anchor turned with the symbol,
 * text does not turn, and on every sideways terminal the name was drawn straight across the bar it labelled.
 */

import type { CircuitJson } from '@circuit-forge/eda-core';

import { placeParts, railGlyphs, type RailGlyph } from './layout';

/**
 * A deliberately rough text box, in the same units as the drawing.
 *
 * The exact width depends on a font this module has never seen, so it is OVERSTATED: 0.7em per character
 * against a canvas that draws at 8px in a proportional face where the average is nearer 0.5em. A test that
 * passes with the box too wide passes with the real one.
 *
 * A baseline is the BOTTOM of the letters, which is the trap the `bottom` case fell into: an anchor "past
 * the bar" is not past it if the letters hang back up over it.
 */
const FONT = 8;
const textBox = (g: RailGlyph) => {
    const w = g.label.length * FONT * 0.7;
    const { x, y } = g.symbol.labelAnchor;
    const minX = g.labelRuns === 'middle' ? x - w / 2 : g.labelRuns === 'end' ? x - w : x;
    return { minX, maxX: minX + w, minY: y - FONT, maxY: y + FONT * 0.25 };
};

/** Every segment the glyph actually draws, in the glyph's own frame. */
const segments = (g: RailGlyph) =>
    g.symbol.strokes.flatMap((s) =>
        s.points.slice(1).map((p, i) => ({ a: s.points[i]!, b: p }) as { a: [number, number]; b: [number, number] }),
    );

/** Does an axis-aligned segment pass through a box? Every stroke here is axis-aligned. */
const crosses = (seg: { a: [number, number]; b: [number, number] }, box: ReturnType<typeof textBox>) => {
    const [x1, y1] = seg.a;
    const [x2, y2] = seg.b;
    return (
        Math.min(x1, x2) < box.maxX &&
        box.minX < Math.max(x1, x2) &&
        Math.min(y1, y2) < box.maxY &&
        box.minY < Math.max(y1, y2)
    );
};

/** One part, its first pin on a rail, its pin forced onto a given side by the symbol library's own geometry. */
const sheetWith = (type: string, netOfFirstPin = 'vcc'): CircuitJson =>
    ({
        version: '1.0',
        components: [
            {
                id: 'p1',
                type,
                designator: type === 'resistor' ? 'R1' : 'U1',
                value: '1k',
                pins: [
                    { pinId: '1', netId: netOfFirstPin },
                    { pinId: '2', netId: 'out' },
                ],
            },
        ],
        nets: [
            { id: 'vcc', name: 'VCC', isPower: true },
            { id: 'out', name: 'OUT' },
        ],
    }) as unknown as CircuitJson;

describe('supply marks', () => {
    it('marks every terminal that reaches a rail, and nothing else', () => {
        const circuit = sheetWith('resistor');
        const glyphs = railGlyphs(circuit, placeParts(circuit));
        expect(glyphs).toHaveLength(1);
        expect(glyphs[0]!.label).toBe('VCC');
        expect(glyphs[0]!.annotates).toBe('p1.1');
    });

    it('marks nothing when no net is a rail', () => {
        const circuit = sheetWith('resistor', 'out');
        expect(railGlyphs(circuit, placeParts(circuit))).toEqual([]);
    });

    it('does not draw the rail NAME across the rail MARK', () => {
        // THE DEFECT, and the reason this file exists. The anchor was turned with the symbol; text is always
        // read horizontally and does not turn. On a sideways terminal that left "VCC" centred four units
        // from a vertical bar — and an 8pt "VCC" is wider than eight units, so the name was drawn straight
        // through the mark it was naming. Measured, not eyeballed: the bar sat at x=90, the name at x=86.
        //
        // Every side is covered by turning the mark directly, because which sides a real sheet produces
        // depends on the symbol library, and a defect that only shows on `left` must not wait for a part
        // whose pins happen to point that way.
        const circuit = sheetWith('resistor');
        const glyph = railGlyphs(circuit, placeParts(circuit))[0]!;

        for (const side of ['top', 'bottom', 'left', 'right'] as const) {
            const turned = railGlyphs(
                circuit,
                placeParts(circuit).map((p) => ({
                    ...p,
                    symbol: { ...p.symbol, pins: p.symbol.pins.map((q) => ({ ...q, side })) },
                })),
            )[0]!;
            const box = textBox(turned);
            for (const seg of segments(turned))
                expect({ side, hit: crosses(seg, box) }).toEqual({ side, hit: false });
        }
        expect(glyph.label).toBe('VCC');
    });

    it('holds for a LONG rail name, which is where a centred label runs out of room', () => {
        // "+12V_ANALOG" is four times the width of "VCC". Anchoring the name at the end that touches the bar
        // and running it outward is what makes the width irrelevant — which is the point, since this module
        // cannot know the font the canvas will draw with.
        const circuit = {
            ...sheetWith('resistor'),
            nets: [
                { id: 'vcc', name: '+12V_ANALOG', isPower: true },
                { id: 'out', name: 'OUT' },
            ],
        } as unknown as CircuitJson;
        for (const side of ['top', 'bottom', 'left', 'right'] as const) {
            const turned = railGlyphs(
                circuit,
                placeParts(circuit).map((p) => ({
                    ...p,
                    symbol: { ...p.symbol, pins: p.symbol.pins.map((q) => ({ ...q, side })) },
                })),
            )[0]!;
            const box = textBox(turned);
            for (const seg of segments(turned))
                expect({ side, hit: crosses(seg, box) }).toEqual({ side, hit: false });
        }
    });

    it('puts the mark ON the terminal it marks, not near it', () => {
        // The same rule ground had to learn: a mark parked twenty units below its pin interpenetrates the
        // symbol and joins nothing. The glyph's own terminal has to COINCIDE with the pin it annotates.
        const circuit = sheetWith('resistor');
        const placed = placeParts(circuit);
        const glyph = railGlyphs(circuit, placed)[0]!;
        const part = placed[0]!;
        const pin = part.symbol.pins.find((q) => q.pinId === '1')!;
        const own = glyph.symbol.pins[0]!;
        expect([glyph.x + own.x, glyph.y + own.y]).toEqual([part.x + pin.x, part.y + pin.y]);
    });

    it('leaves no two marks overlapping on a sheet nobody has arranged', () => {
        // Every part on the same rail, auto-placed. Marks that collide would read as one bar across two
        // parts — which is a wire, and the whole argument for marking rails is that they are NOT wired.
        const circuit = {
            version: '1.0',
            components: Array.from({ length: 8 }, (_, i) => ({
                id: `r${i}`,
                type: 'resistor',
                designator: `R${i + 1}`,
                value: '1k',
                pins: [
                    { pinId: '1', netId: 'vcc' },
                    { pinId: '2', netId: `o${i}` },
                ],
            })),
            nets: [
                { id: 'vcc', name: 'VCC', isPower: true },
                ...Array.from({ length: 8 }, (_, i) => ({ id: `o${i}` })),
            ],
        } as unknown as CircuitJson;

        const glyphs = railGlyphs(circuit, placeParts(circuit));
        expect(glyphs).toHaveLength(8);
        const box = (g: RailGlyph) => ({
            minX: g.x + g.symbol.bounds.minX,
            maxX: g.x + g.symbol.bounds.maxX,
            minY: g.y + g.symbol.bounds.minY,
            maxY: g.y + g.symbol.bounds.maxY,
        });
        for (let i = 0; i < glyphs.length; i++)
            for (let j = i + 1; j < glyphs.length; j++) {
                const a = box(glyphs[i]!);
                const b = box(glyphs[j]!);
                const overlaps = a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
                expect({ pair: [glyphs[i]!.id, glyphs[j]!.id], overlaps }).toEqual({
                    pair: [glyphs[i]!.id, glyphs[j]!.id],
                    overlaps: false,
                });
            }
    });

    it('is notation, not a part: it carries no designator', () => {
        // A rail mark that entered the tree as a part would land on the BOM as something to buy.
        const circuit = sheetWith('resistor');
        expect(railGlyphs(circuit, placeParts(circuit))[0]!.designator).toBe('');
    });
});
