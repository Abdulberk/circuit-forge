/**
 * How the reference is drawn, and the one rule that keeps it honest: ONE ground symbol per terminal.
 *
 * A ground net is not wired — it is marked at each pin that reaches it, which is what every schematic does
 * and which took between a third and a half of all the wire off the sheet. That change had a hole in it:
 * a design's OWN ground component was still being parked a fixed drop below a terminal, an arrangement that
 * only makes sense when a wire is going to be drawn from one to the other. Once the wire stopped existing,
 * the author's symbol dangled twenty units from a pin that had grown a second ground symbol of its own — the
 * two drawn through each other, the marker's terminal landing on the middle of the glyph's widest bar, and
 * nothing at all joining it to the circuit.
 *
 * A marker IS a ground symbol. So it sits ON its pin like any other, and that pin does not get a second one.
 */

import type { CircuitJson, Position } from '@circuit-forge/eda-core';

import { bodiesOf, groundGlyphs, netsOf, placeParts } from './layout';

const R = (id: string, a: string, b: string) => ({
    id,
    type: 'resistor',
    designator: id.toUpperCase(),
    value: '1k',
    pins: [
        { pinId: '1', netId: a },
        { pinId: '2', netId: b },
    ],
});
const V = (id: string, a: string, b: string) => ({
    id,
    type: 'voltage_source',
    designator: id.toUpperCase(),
    value: 'DC 5',
    pins: [
        { pinId: '+', netId: a },
        { pinId: '-', netId: b },
    ],
});
const GND = (id: string, net: string) => ({
    id,
    type: 'ground',
    designator: id.toUpperCase(),
    pins: [{ pinId: '1', netId: net }],
});

/** The product's own divider, the circuit its regression suite routes. */
const DIVIDER: CircuitJson = {
    version: '1.0',
    components: [V('v1', 'vin', 'gnd'), R('r1', 'vin', 'mid'), R('r2', 'mid', 'gnd'), GND('g1', 'gnd')] as never,
    nets: [
        { id: 'vin', name: 'VIN' },
        { id: 'mid', name: 'MID' },
        { id: 'gnd', name: 'GND', isGround: true },
    ],
};

/**
 * The same circuit with NO marker of its own, so every ground terminal gets a symbol the drawing adds.
 *
 * Needed because the divider's own marker takes its lowest ground terminal — a right-facing resistor pin —
 * and leaves the glyph to a bottom-facing one, where an unturned symbol happens to be right. A rule that is
 * only exercised on the case it cannot get wrong is not exercised.
 */
const NO_MARKER: CircuitJson = {
    ...DIVIDER,
    components: (DIVIDER.components ?? []).filter((c) => c.type !== 'ground'),
};

const overlaps = (a: { minX: number; minY: number; maxX: number; maxY: number }, b: typeof a): boolean =>
    a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

/** Every ground symbol on the sheet — the author's markers and the ones the drawing adds. */
function marksOf(circuit: CircuitJson, positions?: Parameters<typeof placeParts>[1]) {
    const placed = placeParts(circuit, positions);
    const glyphs = groundGlyphs(circuit, placed);
    const byId = new Map((circuit.components ?? []).map((c) => [c.id, c]));
    const markers = placed.filter((p) => byId.get(p.id)?.type === 'ground');
    return { placed, glyphs, markers, boxes: bodiesOf([...markers, ...glyphs]) };
}

describe('one ground symbol per terminal', () => {
    it('puts the author’s marker ON the pin it annotates, not a drop below it', () => {
        const { markers, placed } = marksOf(DIVIDER);
        const marker = markers[0]!;
        expect(marker.annotates).toBeTruthy();

        // Its own terminal lands exactly on the pin it names. That is what makes it a ground symbol rather
        // than a part waiting for a wire — and a ground net is not wired, so no wire was ever coming.
        const [partId, pinId] = marker.annotates!.split('.');
        const part = placed.find((p) => p.id === partId)!;
        const pin = part.symbol.pins.find((q) => q.pinId === pinId)!;
        const own = marker.symbol.pins[0]!;
        expect([marker.x + own.x, marker.y + own.y]).toEqual([part.x + pin.x, part.y + pin.y]);
    });

    it('does not draw a second symbol on a pin the marker already claims', () => {
        const { glyphs, markers } = marksOf(DIVIDER);
        const claimed = markers.map((m) => m.annotates);
        expect(claimed.filter(Boolean)).toHaveLength(1);
        // No glyph names the claimed terminal, and the terminals that ARE covered are the other ground pins.
        expect(glyphs.map((g) => g.id.replace('#gnd', ''))).not.toContain(claimed[0]);
        expect(glyphs.length).toBeGreaterThan(0);
    });

    it('draws no two ground symbols through each other, however the parts are arranged', () => {
        // The failure this file exists for, and it was reachable in one ordinary gesture: dragging the source
        // down, or one press of R on a resistor, put the marker's terminal on the middle of a glyph's widest
        // bar. The four regression circuits escaped only because their lowest ground terminal happened to be
        // a right-facing pin, which turns the symbol sideways.
        const arrangements: Array<Record<string, Position> | undefined> = [
            undefined,
            { v1: { x: 140, y: 400 } },
            { r2: { x: 140, y: 280, rotation: '90' as const } },
            { v1: { x: 300, y: 120 }, r2: { x: 120, y: 300 } },
        ];
        const collisions = arrangements.flatMap((positions, i) => {
            const { boxes } = marksOf(DIVIDER, positions);
            return boxes.flatMap((a, x) =>
                boxes.slice(x + 1).flatMap((b) => (overlaps(a, b) ? [{ arrangement: i, a, b }] : [])),
            );
        });
        expect(collisions).toEqual([]);
    });

    it('hangs every ground symbol AWAY from the part it marks', () => {
        // Sitting on the pin is not enough — the symbol has to point somewhere sensible. A ground symbol is
        // drawn with its bars below its terminal, so a part whose ground pin faces RIGHT needs it turned, or
        // the bars are laid across the body of the part they belong to. Measured by overlap rather than by
        // rotation, because the rotation is a means and this is the end.
        const cases: Array<[CircuitJson, Record<string, Position> | undefined]> = [
            [DIVIDER, undefined],
            [DIVIDER, { r2: { x: 140, y: 280, rotation: '90' } }],
            // No marker at all, so the glyphs cover every ground terminal — including the right-facing one,
            // where a symbol drawn unturned lays its bars straight across the resistor.
            [NO_MARKER, undefined],
            [NO_MARKER, { r2: { x: 140, y: 280, rotation: '90' } }],
        ];
        for (const [circuit, positions] of cases) {
            const { placed, markers, glyphs } = marksOf(circuit, positions);
            const parts = bodiesOf(placed.filter((p) => !markers.some((m) => m.id === p.id)));
            const marks = bodiesOf([...markers, ...glyphs]);
            const across = marks.flatMap((m, i) =>
                parts.flatMap((body) => (overlaps(m, body) ? [{ mark: [...markers, ...glyphs][i]!.id }] : [])),
            );
            expect(across).toEqual([]);
        }
    });

    it('leaves no ground symbol joined to nothing', () => {
        // A marker sitting a drop below its pin, on a net that is no longer wired, is a symbol with a
        // terminal that touches no conductor at all. Every ground symbol's terminal must coincide with a
        // terminal of the circuit — that IS the connection, drawn.
        const { markers, glyphs, placed } = marksOf(DIVIDER);
        const terminals = new Set(
            placed.flatMap((p) =>
                (DIVIDER.components ?? [])
                    .find((c) => c.id === p.id)!
                    .pins.map((pin) => {
                        const sp = p.symbol.pins.find((q) => q.pinId === pin.pinId);
                        return sp ? `${p.x + sp.x},${p.y + sp.y}` : '';
                    }),
            ),
        );
        const dangling = [...markers, ...glyphs].filter((m) => {
            const own = m.symbol.pins[0]!;
            return !terminals.has(`${m.x + own.x},${m.y + own.y}`);
        });
        expect(dangling.map((m) => m.id)).toEqual([]);
    });

    it('still leaves the ground net unrouted, because it is marked instead', () => {
        expect(netsOf(DIVIDER, placeParts(DIVIDER)).map((n) => n.id)).not.toContain('gnd');
    });
});
