/**
 * The geometry contract, checked against EVERY symbol this library can produce.
 *
 * WHY A CONTRACT AND NOT A LIST OF CASES. A schematic is read, not computed from. Its whole job is that a
 * person can look at it and be right about the circuit. That makes a geometry defect a different kind of
 * bug from a wrong number: nothing throws, no test fails by accident, and the person acts on what they saw.
 * So the invariants below are asserted over every type the system can author — not over the handful someone
 * remembered to write a case for — because the symbol that breaks them will be the one nobody drew a test
 * for.
 *
 * THREE INVARIANTS, each of them a specific lie the sheet could tell:
 *
 *   ON THE GRID. Every pin sits on a fixed lattice. Without it two symbols placed side by side have pins at
 *   incommensurable heights, so a wire between them can never be a straight line and orthogonal routing has
 *   nothing to route to. Measured before this existed: pin coordinates across the library were 0, 11, 15,
 *   20 — GCD 1, nothing on any grid at all.
 *
 *   PINS TOUCH THEIR OWN CONDUCTOR. A pin is where a wire attaches; if it does not coincide with the end of
 *   a drawn stroke, the wire meets empty space a few units from the symbol. Measured: the diode's cathode
 *   pin sat at x=15 while its lead stroke ended at x=13, because `twoTerminal` computes the pin from the
 *   body half-width and the diode then overrode the strokes with a different shape. Nothing connected the
 *   two, so the shape and its attachment points could drift apart silently.
 *
 *   DECLARED EXTENT IS THE REAL EXTENT. `width`/`height` are what a placer spaces parts by. Hand-typing
 *   them means they are a second description of a shape that already describes itself — and the two
 *   disagreed: `voltage_source` declared 40×24 for a shape that is 24×40 (the horizontal formula copied
 *   onto a vertical symbol), and `inductor` declared a height of 10 for a 5-unit body.
 *
 * These are RED against the library as it stands. That is the point of writing them first: a fix that makes
 * them green is a fix, and a fix that cannot is a fix that was not needed.
 */
import { COMPONENT_PINS, type Component, type ComponentType } from '@circuit-forge/eda-core';

import { PIN_GRID, symbolFor, type SymbolGeometry } from './symbols';

/**
 * One component per type the system can author, built from the CANONICAL pin list.
 *
 * From `COMPONENT_PINS` rather than a hand-written fixture, so a type added later is covered the day it is
 * added instead of the day someone remembers this file. Variable-arity types (a subcircuit, a logic gate)
 * declare no canonical pins — their pin list is authored — so they are exercised separately below with a
 * spread of realistic counts.
 */
const FIXED_ARITY = (Object.entries(COMPONENT_PINS) as Array<[ComponentType, readonly string[]]>).filter(
    ([, pins]) => pins.length > 0,
);

const componentOf = (type: ComponentType, pins: readonly string[]): Pick<Component, 'type' | 'pins'> => ({
    type,
    pins: pins.map((pinId) => ({ pinId, netId: 'n1' })),
});

/** Every point any stroke passes through, as a lookup a pin can be checked against. */
const strokeEndpoints = (g: SymbolGeometry): Array<[number, number]> =>
    g.strokes.flatMap((s) => {
        const pts = s.points;
        // A CLOSED stroke has no free ends — its last point joins its first — so every vertex is an
        // endpoint for this purpose. An open stroke attaches only at the two ends; a pin sitting on an
        // interior vertex of a lead would still leave the lead running past it.
        return s.closed ? pts : [pts[0]!, pts[pts.length - 1]!];
    });

const onGrid = (v: number): boolean => Number.isInteger(v / PIN_GRID);

/** The bounding box of everything drawn, pins included — the extent a placer must not overlap. */
function actualExtent(g: SymbolGeometry): { width: number; height: number } {
    const xs = [...g.strokes.flatMap((s) => s.points.map((p) => p[0])), ...g.pins.map((p) => p.x)];
    const ys = [...g.strokes.flatMap((s) => s.points.map((p) => p[1])), ...g.pins.map((p) => p.y)];
    return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/** Runs an assertion over every symbol, naming the type in the failure so one line identifies the culprit. */
function forEverySymbol(assert: (name: string, g: SymbolGeometry) => void): void {
    for (const [type, pins] of FIXED_ARITY) {
        assert(type, symbolFor(componentOf(type, pins)));
    }
    // The authored-arity shapes: a subcircuit or a gate whose pin count is whatever the design says.
    for (const count of [1, 2, 3, 5, 8, 14, 40]) {
        const pins = Array.from({ length: count }, (_, i) => `p${i + 1}`);
        assert(`subckt(${count} pins)`, symbolFor(componentOf('subckt' as ComponentType, pins)));
    }
}

describe('every pin sits on the lattice', () => {
    it('holds for every component type the system can author', () => {
        forEverySymbol((name, g) => {
            const off = g.pins.filter((p) => !onGrid(p.x) || !onGrid(p.y));
            expect({ name, offGrid: off.map((p) => `${p.pinId}@(${p.x},${p.y})`) }).toEqual({ name, offGrid: [] });
        });
    });

    it('PIN_GRID is a frozen value, not a tuning knob', () => {
        // Changing it is a DATA MIGRATION, not a preference: every stored drawing holds coordinates in
        // these units, and pcb-core's adapter seeds board placement from the same numbers. A test that
        // pins the value is what makes that cost visible to whoever reaches for it.
        expect(PIN_GRID).toBe(10);
    });
});

describe('every pin touches the conductor it belongs to', () => {
    it('coincides with an endpoint of some stroke, for every symbol', () => {
        // Not "near" — coincident. A gap of two units is invisible at a glance and is exactly the gap that
        // makes a wire appear to reach a symbol it does not reach.
        forEverySymbol((name, g) => {
            const floating = g.pins.filter(
                (p) => !strokeEndpoints(g).some(([x, y]) => x === p.x && y === p.y),
            );
            expect({ name, floating: floating.map((p) => `${p.pinId}@(${p.x},${p.y})`) }).toEqual({
                name,
                floating: [],
            });
        });
    });
});

describe('the declared extent is the drawn extent', () => {
    it('width and height equal the real bounding box, for every symbol', () => {
        // Derived by scanning rather than hand-typed. A hand-typed extent is a second description of a
        // shape that already describes itself, and the two are only equal until someone edits one of them.
        forEverySymbol((name, g) => {
            const actual = actualExtent(g);
            expect({ name, declared: { width: g.width, height: g.height } }).toEqual({ name, declared: actual });
        });
    });
});

describe('a symbol says which kind it is', () => {
    it('never silently drops a pin: every authored pin appears in the geometry', () => {
        // The property that makes `basis` trustworthy. A drawn shape assumes a pin count; when the part
        // disagrees the library must DERIVE rather than force the familiar picture and hide connections.
        forEverySymbol((name, g) => {
            expect({ name, pinCount: g.pins.length > 0 }).toEqual({ name, pinCount: true });
        });
        for (const [type, pins] of FIXED_ARITY) {
            const g = symbolFor(componentOf(type, pins));
            expect({ type, pins: g.pins.map((p) => p.pinId).sort() }).toEqual({ type, pins: [...pins].sort() });
        }
    });

    it('a part with the WRONG pin count for its drawn shape derives instead of forcing it', () => {
        const fourPinResistor = symbolFor(componentOf('resistor' as ComponentType, ['1', '2', '3', '4']));
        expect(fourPinResistor.basis).toBe('derived');
        expect(fourPinResistor.pins).toHaveLength(4);
    });
});
