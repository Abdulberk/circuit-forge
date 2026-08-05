/**
 * A turned symbol is still the same symbol.
 *
 * Rotation is a transform, so the interesting properties are the ones that must SURVIVE it. A symbol that
 * comes back subtly different after four quarter turns is a symbol whose coordinates drift every time a
 * user presses a key — and drift on a schematic is not visible until a wire fails to meet a pin.
 *
 * Checked over every symbol the library can produce rather than a chosen few, for the same reason the
 * geometry contract is: the shape that breaks under rotation will be the one nobody wrote a case for.
 *
 * These tests have already earned that. Turning a symbol is what exposed a defect three green invariants
 * could not see — the ground symbol's pin was placed BELOW its bars while declaring itself on top, because
 * the placer inferred "outward" from the sign of a body edge that happens to be zero. Upright, everything
 * about it checked out: the pin sat on its own lead, the lead reached the body, the extents matched the
 * drawing. Only the question "does this pin face the way it claims" found it.
 */
import { COMPONENT_PINS, type Component, type ComponentType } from '@circuit-forge/eda-core';

import { orientSymbol } from './orient';
import { PIN_GRID, symbolFor, type SymbolGeometry } from './symbols';

const componentOf = (type: ComponentType, pins: readonly string[]): Pick<Component, 'type' | 'pins'> => ({
    type,
    pins: pins.map((pinId) => ({ pinId, netId: 'n1' })),
});

const EVERY_SYMBOL: Array<[string, SymbolGeometry]> = [
    ...(Object.entries(COMPONENT_PINS) as Array<[ComponentType, readonly string[]]>)
        .filter(([, pins]) => pins.length > 0)
        .map(([type, pins]) => [type, symbolFor(componentOf(type, pins))] as [string, SymbolGeometry]),
    ...[1, 3, 8, 14].map(
        (n) =>
            [
                `subckt(${n})`,
                symbolFor(
                    componentOf(
                        'subckt' as ComponentType,
                        Array.from({ length: n }, (_, i) => `p${i + 1}`),
                    ),
                ),
            ] as [string, SymbolGeometry],
    ),
];

const shapeOf = (g: SymbolGeometry) => ({
    strokes: g.strokes.map((s) => s.points),
    pins: g.pins.map((p) => [p.pinId, p.x, p.y, p.side]),
    width: g.width,
    height: g.height,
    labelAnchor: g.labelAnchor,
});

describe('turning a symbol four times returns it exactly', () => {
    it('holds for every symbol, bit for bit', () => {
        // BIT for bit, not "close enough". A matrix built from Math.cos(π/2) carries 6.1e-17 where it should
        // carry zero, so four turns land 3.6e-15 away — a coordinate-shaped number rather than a coordinate,
        // and enough to take a pin off the lattice that every straight wire depends on.
        for (const [name, base] of EVERY_SYMBOL) {
            let turned = base;
            for (const r of ['90', '180', '270', '0'] as const) turned = orientSymbol(base, { rotation: r });
            // Each turn from the ORIGINAL, then the composed route: both must land on the original.
            let composed = base;
            for (let i = 0; i < 4; i++) composed = orientSymbol(composed, { rotation: '90' });
            expect({ name, shape: shapeOf(composed) }).toEqual({ name, shape: shapeOf(base) });
            expect({ name, zero: shapeOf(turned) }).toEqual({ name, zero: shapeOf(base) });
        }
    });
});

describe('what a turn must preserve', () => {
    it('keeps every pin on the lattice', () => {
        // The property the whole grid exists for. A rotation that lands a pin on a half-step makes a
        // straight wire to it impossible, and nothing would report that — the symbol still looks fine.
        for (const [name, base] of EVERY_SYMBOL) {
            for (const rotation of ['90', '180', '270'] as const) {
                const off = orientSymbol(base, { rotation }).pins.filter(
                    (p) => !Number.isInteger(p.x / PIN_GRID) || !Number.isInteger(p.y / PIN_GRID),
                );
                expect({ name, rotation, offGrid: off.map((p) => `${p.pinId}@(${p.x},${p.y})`) }).toEqual({
                    name,
                    rotation,
                    offGrid: [],
                });
            }
        }
    });

    it('keeps every pin touching its own conductor', () => {
        // Rotating the strokes and the pins by different rules would separate them — the exact defect the
        // library was just repaired for, reintroduced by a transform instead of by a hand-typed number.
        for (const [name, base] of EVERY_SYMBOL) {
            for (const rotation of ['90', '180', '270'] as const) {
                const g = orientSymbol(base, { rotation });
                const ends = new Set(
                    g.strokes
                        .flatMap((s) => (s.closed ? s.points : [s.points[0]!, s.points[s.points.length - 1]!]))
                        .map(([x, y]) => `${x},${y}`),
                );
                const floating = g.pins.filter((p) => !ends.has(`${p.x},${p.y}`));
                expect({ name, rotation, floating: floating.map((p) => p.pinId) }).toEqual({
                    name,
                    rotation,
                    floating: [],
                });
            }
        }
    });

    it('is EQUIVALENT to swapping width and height — recorded, because I claimed otherwise', () => {
        // Rotation re-scans the extent, and the code originally justified that by saying the cheaper rule —
        // swap the two numbers at 90°/270° — breaks for shapes not centred on their own origin.
        //
        // That is false, and a mutation test is what showed it: replacing the scan with the swap turned NO
        // test red. An axis-aligned bounding box's dimensions depend on orientation and not on position, so
        // the two rules agree for every shape, including a deliberately off-centre synthetic one.
        //
        // Written down as an equivalence rather than deleted, because the next person to read `orientSymbol`
        // will have the same idea and deserves to find the answer instead of re-deriving it. The scan is
        // kept for a different reason: `symbolFor` already derives extents by scanning, and one rule that
        // reads the shape beats two that happen to agree.
        const offCentre: SymbolGeometry = {
            basis: 'drawn',
            width: 40,
            height: 10,
            // Deliberately NOT centred on its origin — which is the whole point of this fixture, and is
            // now stated rather than left for a consumer to reconstruct from the extent.
            bounds: { minX: 0, minY: 0, maxX: 40, maxY: 10 },
            strokes: [
                {
                    points: [
                        [0, 0],
                        [40, 0],
                        [40, 10],
                        [0, 10],
                    ],
                    closed: true,
                },
            ],
            pins: [{ pinId: '1', x: 0, y: 0, side: 'left' }],
            labelAnchor: { x: 0, y: 0 },
        };

        for (const [rotation, swapped] of [
            ['90', [10, 40]],
            ['180', [40, 10]],
            ['270', [10, 40]],
        ] as Array<['90' | '180' | '270', [number, number]]>) {
            const g = orientSymbol(offCentre, { rotation });
            expect({ rotation, scanned: [g.width, g.height] }).toEqual({ rotation, scanned: swapped });
        }
    });

    it('keeps the declared extent equal to the drawn extent', () => {
        for (const [name, base] of EVERY_SYMBOL) {
            for (const rotation of ['90', '180', '270'] as const) {
                const g = orientSymbol(base, { rotation });
                const xs = [...g.strokes.flatMap((s) => s.points.map((p) => p[0])), ...g.pins.map((p) => p.x)];
                const ys = [...g.strokes.flatMap((s) => s.points.map((p) => p[1])), ...g.pins.map((p) => p.y)];
                expect({ name, rotation, declared: [g.width, g.height] }).toEqual({
                    name,
                    rotation,
                    declared: [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)],
                });
            }
        }
    });

    it('keeps every pin, by name — a turn is not a place to lose a connection', () => {
        for (const [name, base] of EVERY_SYMBOL) {
            const before = base.pins.map((p) => p.pinId).sort();
            for (const rotation of ['90', '180', '270'] as const) {
                const after = orientSymbol(base, { rotation })
                    .pins.map((p) => p.pinId)
                    .sort();
                expect({ name, rotation, after }).toEqual({ name, rotation, after: before });
            }
        }
    });
});

describe('a pin faces the way the symbol was turned', () => {
    it('carries the SIDE around with the coordinates', () => {
        // The failure this exists for is invisible in a picture: the pin lands correctly and the router
        // then leaves its wire in the old direction, straight back across the body of the part.
        const resistor = symbolFor(componentOf('resistor' as ComponentType, ['1', '2']));
        const sideOf = (rotation: '0' | '90' | '180' | '270', pinId: string) =>
            orientSymbol(resistor, { rotation }).pins.find((p) => p.pinId === pinId)!.side;

        // Clockwise on screen: a pin on the right of an upright symbol is at the bottom of one turned 90°.
        expect([sideOf('0', '2'), sideOf('90', '2'), sideOf('180', '2'), sideOf('270', '2')]).toEqual([
            'right',
            'bottom',
            'left',
            'top',
        ]);
    });

    it('agrees with the direction its own LEAD runs', () => {
        // The two halves are computed separately — coordinates by matrix, side by index — so they can
        // disagree, and nothing else would notice. This already caught one: the ground symbol's pin was
        // placed below its bars while claiming `top`, because the placer inferred "outward" from the sign
        // of a body edge that happens to be zero.
        //
        // The oracle is the LEAD, not the octant. A first version compared each pin against the octant it
        // sat in relative to the centre, which is ambiguous exactly at the diagonal — and a tall derived box
        // puts its extreme pins on that diagonal, so the test failed on a symbol that was correct. The lead
        // is unambiguous by construction: `withLeads` draws it from the pin to the body edge on the pin's
        // own side, so the vector from the lead's far end to the pin points the way the pin faces.
        for (const [name, base] of EVERY_SYMBOL) {
            for (const rotation of ['90', '180', '270'] as const) {
                const g = orientSymbol(base, { rotation });
                for (const p of g.pins) {
                    const lead = g.strokes.find(
                        (s) => s.points.length === 2 && s.points.some(([x, y]) => x === p.x && y === p.y),
                    );
                    expect({ name, rotation, pin: p.pinId, hasLead: Boolean(lead) }).toEqual({
                        name,
                        rotation,
                        pin: p.pinId,
                        hasLead: true,
                    });
                    const far = lead!.points.find(([x, y]) => x !== p.x || y !== p.y) ?? lead!.points[0]!;
                    const dx = p.x - far[0];
                    const dy = p.y - far[1];
                    const faces = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top';
                    expect({ name, rotation, pin: p.pinId, side: p.side }).toEqual({
                        name,
                        rotation,
                        pin: p.pinId,
                        side: faces,
                    });
                }
            }
        }
    });
});

describe('mirroring', () => {
    it('flips the shape about the named axis and takes the sides with it', () => {
        const resistor = symbolFor(componentOf('resistor' as ComponentType, ['1', '2']));
        const flipped = orientSymbol(resistor, { mirror: 'x' });
        const before = resistor.pins.find((p) => p.pinId === '1')!;
        const after = flipped.pins.find((p) => p.pinId === '1')!;
        expect({ x: after.x, y: after.y, side: after.side }).toEqual({ x: -before.x, y: before.y, side: 'right' });
    });

    it('is NOT interchangeable with a half turn — the board reads only one of them', () => {
        // The tempting normalisation: mirror:'x' ≡ (rotation+180, mirror:'y') as a picture. It is a picture
        // identity and not a data one — `mirror` is invisible to the board by contract and `rotation` is the
        // one field the board consumes, so rewriting one as the other places a polarised part a half turn
        // wrong. Pinned here because the two really do look the same on screen, which is what makes the
        // substitution attractive.
        const diode = symbolFor(componentOf('diode' as ComponentType, ['anode', 'cathode']));
        const mirrored = orientSymbol(diode, { mirror: 'x' });
        const halfTurned = orientSymbol(diode, { rotation: '180' });
        expect(shapeOf(mirrored)).not.toEqual(shapeOf(halfTurned));
    });
});

describe('an upright part costs nothing', () => {
    it('returns the SAME object, so a caller can skip work by identity', () => {
        // Every design a machine wrote is entirely upright. Rebuilding each symbol on every render to
        // express "nothing happened" would be a cost with no corresponding fact.
        const g = symbolFor(componentOf('resistor' as ComponentType, ['1', '2']));
        expect(orientSymbol(g, undefined)).toBe(g);
        expect(orientSymbol(g, {})).toBe(g);
        expect(orientSymbol(g, { rotation: '0' })).toBe(g);
    });
});
