/**
 * Schematic symbols — for the parts we know, and for every part we do not.
 *
 * THE GENERALITY PROBLEM, WHICH IS THE WHOLE DESIGN. A catalogue has hundreds of thousands of parts. Any
 * symbol system built as a lookup from component type to a hand-drawn shape answers correctly for the dozen
 * someone drew and then has to do something for everything else. The tempting something — fall back to the
 * nearest-looking symbol, or draw a resistor because most things are two-pin — is the failure mode that
 * matters: a symbol is a CLAIM about what a part is, and a wrong one is read as fact by every engineer who
 * looks at the sheet. An unfamiliar op-amp drawn as a resistor is worse than an unfamiliar op-amp drawn as a
 * box labelled with its designator and its real pins.
 *
 * So there are two kinds of symbol and the difference is declared, never hidden:
 *
 *   DRAWN — the handful of parts with a universal schematic convention an engineer reads at a glance. A
 *   resistor is a rectangle, a capacitor is two plates, a ground is three shrinking bars. These are worth
 *   hand-drawing because the convention carries meaning that a box cannot.
 *
 *   DERIVED — everything else, and it is not a fallback in the apologetic sense. A rectangle whose pins are
 *   laid out from the part's OWN pin list, labelled with the part's OWN pin names, is exactly as truthful as
 *   a drawn symbol and considerably more truthful than a guess. It works for a part invented tomorrow.
 *
 * `basis` says which one you got, so a UI can show it and a test can assert it. Silence about which is which
 * is how a guess becomes indistinguishable from knowledge.
 *
 * PURE GEOMETRY. Millimetre-free, unitless local coordinates with the origin at the symbol's centre; the
 * renderer scales. No DOM, no SVG strings — a consumer that wants canvas instead should not have to parse
 * anything.
 */
import type { Component } from '@circuit-forge/eda-core';

/** Where a pin attaches, in the symbol's local frame, and which way its wire leaves. */
export interface SymbolPin {
    /** The design's own name for the terminal: '1', '+', 'anode', 'base'. Never renamed here. */
    pinId: string;
    x: number;
    y: number;
    /** The direction a wire should leave in, so the router does not cross the body. */
    side: 'left' | 'right' | 'top' | 'bottom';
}

/** A line, in local coordinates. The body is drawn from these, so any renderer can consume it. */
export interface SymbolStroke {
    points: Array<[number, number]>;
    /** True for the outline of a filled body (an IC box); false for bare conductor strokes. */
    closed?: boolean;
}

export interface SymbolGeometry {
    /** `drawn` = a conventional symbol; `derived` = a labelled box built from the part's own pins. */
    basis: 'drawn' | 'derived';
    /** Half-extents of the body, so a placer can space parts without re-deriving the shape. */
    width: number;
    height: number;
    strokes: SymbolStroke[];
    pins: SymbolPin[];
    /** Where the designator wants to sit relative to the centre. */
    labelAnchor: { x: number; y: number };
}

/**
 * The lattice every pin sits on.
 *
 * WHY A LATTICE AT ALL. Two symbols placed side by side must have pins at commensurable heights, or a wire
 * between them can never be a straight line and orthogonal routing has nothing to aim at. Before this, pin
 * coordinates across the library were 0, 11, 15 and 20 — greatest common divisor 1, which is to say no grid
 * at all, which is to say every wire was a diagonal waiting to happen.
 *
 * TEN, and it is FROZEN. Changing it is a data migration, not a preference: stored drawings hold
 * coordinates in these units, and `pcb-core`'s adapter seeds board placement from the same numbers. A test
 * pins the value so that cost is visible to whoever reaches for it.
 */
export const PIN_GRID = 10;

/**
 * The shortest lead worth drawing, before the pin is snapped outward to the lattice.
 *
 * A lead is what a wire visibly attaches to; too short and the wire appears to touch the body itself. This
 * is a FLOOR, not a length — the actual lead is however far it is from the body edge to the next lattice
 * point, so it varies per symbol. Equal leads are not a property worth having; pins on a grid is.
 */
const MIN_LEAD = 6;

/** Snap a coordinate AWAY from the origin to the next lattice point. */
const snapOut = (v: number): number => (v >= 0 ? Math.ceil(v / PIN_GRID) : Math.floor(v / PIN_GRID)) * PIN_GRID;

/** The bounding box of a set of strokes — the authority on how big a body actually is. */
function boundsOf(strokes: SymbolStroke[]): { minX: number; maxX: number; minY: number; maxY: number } {
    const xs = strokes.flatMap((s) => s.points.map((p) => p[0]));
    const ys = strokes.flatMap((s) => s.points.map((p) => p[1]));
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/**
 * Attach pins to a body, and DRAW THE LEADS THAT REACH THEM.
 *
 * This is the whole fix for a defect that had nothing to do with any one symbol. Previously a symbol wrote
 * its pin coordinates and its lead strokes as two separate hand-authored facts, so the two could disagree
 * — and did: the diode's shared two-terminal frame put its pins at ±15 from a body half-width of 7, while
 * the diode overrode the strokes and drew its right lead from the cathode bar at x=5 to x=13. The pin sat
 * two units past the end of its own conductor, and a wire drawn to it met empty space. Nothing detected
 * that, because nothing related the two numbers.
 *
 * Here the pin position is the ONLY authored fact and the lead is derived from it. A lead that fails to
 * reach its pin is not a bug that can be fixed; it is a shape this function cannot express.
 */
function withLeads(body: SymbolStroke[], pins: SymbolPin[]): SymbolStroke[] {
    const b = boundsOf(body);
    const edge = (pin: SymbolPin): [number, number] => {
        switch (pin.side) {
            case 'left':
                return [b.minX, pin.y];
            case 'right':
                return [b.maxX, pin.y];
            case 'top':
                return [pin.x, b.minY];
            case 'bottom':
                return [pin.x, b.maxY];
        }
    };
    return [...body, ...pins.map((pin) => ({ points: [[pin.x, pin.y], edge(pin)] as Array<[number, number]> }))];
}

/** Place a pin on the lattice, clear of the body by at least `MIN_LEAD`. */
const pinOut = (bodyEdge: number): number => snapOut(bodyEdge + Math.sign(bodyEdge || 1) * MIN_LEAD);

/**
 * Order a POLARISED part's terminals by NAME, not by array position.
 *
 * The bug this closes: `twoTerminal` put `pins[0]` on the left and `pins[1]` on the right, so a diode drew
 * its anode wherever the author happened to list it first. Everything else in this system binds by `pinId` —
 * the netlist generator, the layout adapter, `LayoutPad.sourcePin` — and a design that authors
 * `[{pinId:'cathode'}, {pinId:'anode'}]` is perfectly legal and simulates identically. It would have drawn
 * backwards, and a reversed diode on a schematic is read as fact.
 *
 * Returns null when the names are not the ones we know, and the caller then DERIVES a box instead. Drawing a
 * polarised symbol whose polarity we cannot establish is the same unbacked claim as putting an arrow on a
 * transistor whose type we cannot read — see UNDRAWN_BY_DESIGN.
 */
function orderedByName(pins: string[], first: readonly string[], second: readonly string[]): [string, string] | null {
    const a = pins.find((p) => first.includes(p.toLowerCase()));
    const b = pins.find((p) => second.includes(p.toLowerCase()));
    return a !== undefined && b !== undefined && a !== b ? [a, b] : null;
}

/**
 * A two-terminal part: one pin left, one right, body between. The shared frame for R, C, L, D, V.
 *
 * The body is the ONLY thing a caller supplies. Its extent is scanned rather than declared, the pins are
 * placed from that extent onto the lattice, and the leads are drawn to the pins — so a caller cannot
 * describe a shape whose pins miss its conductors, and cannot declare a size its drawing does not have.
 * Both were real defects, and both are now unsayable rather than merely fixed.
 */
function twoTerminal(pins: string[], body: SymbolStroke[]): SymbolGeometry {
    const b = boundsOf(body);
    const placed: SymbolPin[] = [
        { pinId: pins[0] ?? '1', x: pinOut(b.minX), y: 0, side: 'left' },
        { pinId: pins[1] ?? '2', x: pinOut(b.maxX), y: 0, side: 'right' },
    ];
    return {
        basis: 'drawn',
        ...measured(withLeads(body, placed), placed),
        pins: placed,
        labelAnchor: { x: 0, y: b.minY - 5 },
    };
}

/**
 * The size of a symbol, scanned from the symbol.
 *
 * `width`/`height` used to be hand-typed beside the shape, which made them a second description of
 * something that already describes itself — and the two disagreed the moment either was edited.
 * `voltage_source` declared 40×24 for a shape that is 24×40, because the horizontal formula was copied
 * onto a vertical symbol; `inductor` declared a height of 10 for a body that never leaves the top half.
 * Deriving them does not fix those two so much as delete the whole class: there is nothing left to get
 * wrong.
 *
 * FULL extents, including the pins, because that is what the quantity is for — a placer spacing parts so
 * they do not overlap has to account for the leads a wire attaches to. The old docstring said half-extents
 * while every producer returned full ones, and the one consumer read it BOTH ways in the same file.
 */
function measured(
    strokes: SymbolStroke[],
    pins: SymbolPin[],
): { width: number; height: number; strokes: SymbolStroke[] } {
    const all = [...strokes, { points: pins.map((p) => [p.x, p.y] as [number, number]) }];
    const b = boundsOf(all);
    return { width: b.maxX - b.minX, height: b.maxY - b.minY, strokes };
}

/**
 * The conventional symbols.
 *
 * Deliberately short. A part earns a hand-drawn symbol when the convention says something a labelled box
 * cannot — a capacitor's two plates say "no DC path", a ground's bars say "reference" — and not merely
 * because the part is common. Everything absent from here is DERIVED, which is a correct answer, not a
 * degraded one.
 */
const DRAWN: Record<string, (pins: string[]) => SymbolGeometry | null> = {
    resistor: (p) =>
        twoTerminal(p, [
            {
                points: [
                    [-10, -4],
                    [10, -4],
                    [10, 4],
                    [-10, 4],
                ],
                closed: true,
            },
        ]),

    // Two plates and the gap between them: the convention that says "no DC path", which a labelled box
    // cannot say. The leads are NOT written here — they are drawn to wherever the pins land.
    capacitor: (p) =>
        twoTerminal(p, [
            {
                points: [
                    [-3, -8],
                    [-3, 8],
                ],
            },
            {
                points: [
                    [3, -8],
                    [3, 8],
                ],
            },
        ]),

    inductor: (p) =>
        twoTerminal(p, [
            // Four arcs approximated as a polyline: a renderer that wants true arcs can draw them instead,
            // but the shape reads. It sits entirely on or above the axis, which is why a hand-typed height
            // of 10 was wrong for it — the scan says 5, and now the scan is the only thing that says it.
            {
                points: [
                    [-12, 0],
                    [-10, -5],
                    [-6, -5],
                    [-4, 0],
                    [-2, -5],
                    [2, -5],
                    [4, 0],
                    [6, -5],
                    [10, -5],
                    [12, 0],
                ],
            },
        ]),

    diode: (raw) => {
        // Anode LEFT, cathode RIGHT — by name. Taking them in array order drew the diode backwards for
        // any design that listed cathode first, which is legal everywhere else in this system.
        const p = orderedByName(raw, ['anode', 'a', '+'], ['cathode', 'k', 'c', '-']);
        if (!p) return null;
        // The body is ASYMMETRIC — the triangle's back sits at −7, the cathode bar at +5 — and that
        // asymmetry is exactly what broke the old version: the shared frame placed both pins from a single
        // half-width of 7, so the right pin landed at 15 while the hand-written lead stopped at 13. Two
        // units of nothing, masked only by the renderer's pin dot happening to be exactly that radius.
        // Here each pin is placed from the edge it actually belongs to, and the leads follow.
        return twoTerminal(p, [
            {
                points: [
                    [-7, -7],
                    [-7, 7],
                    [5, 0],
                ],
                closed: true,
            }, // anode triangle
            {
                points: [
                    [5, -7],
                    [5, 7],
                ],
            }, // cathode bar
        ]);
    },

    voltage_source: (raw) => {
        // + on TOP, - on the bottom — by name, for the same reason the diode is. A source drawn upside
        // down inverts every polarity an engineer reads off the sheet.
        const p = orderedByName(raw, ['+', 'p', 'pos', 'plus'], ['-', 'n', 'neg', 'minus']);
        if (!p) return null;
        // VERTICAL, and that is what the old hand-typed size got wrong: it declared 40×24 by reusing the
        // horizontal frame's formula, for a shape that is 24 wide and 40 tall. A placer spacing parts by
        // those numbers reserved the wrong axis. Scanned now, so the shape and its stated size cannot part
        // company again.
        const body: SymbolStroke[] = [
            // A circle, as a polygon — the renderer needs no arc support to draw a source.
            {
                points: Array.from({ length: 24 }, (_, i) => {
                    const a = (i / 24) * Math.PI * 2;
                    return [Math.cos(a) * 12, Math.sin(a) * 12] as [number, number];
                }),
                closed: true,
            },
            {
                points: [
                    [-4, -5],
                    [4, -5],
                ],
            }, // + bar
            {
                points: [
                    [0, -9],
                    [0, -1],
                ],
            }, // + stem
            {
                points: [
                    [-4, 5],
                    [4, 5],
                ],
            }, // −
        ];
        const b = boundsOf(body);
        const placed: SymbolPin[] = [
            { pinId: p[0] ?? '+', x: 0, y: pinOut(b.minY), side: 'top' },
            { pinId: p[1] ?? '-', x: 0, y: pinOut(b.maxY), side: 'bottom' },
        ];
        return {
            basis: 'drawn',
            ...measured(withLeads(body, placed), placed),
            pins: placed,
            labelAnchor: { x: b.maxX + 4, y: 0 },
        };
    },

    // Three shrinking bars — the convention that says REFERENCE, which a box cannot. One terminal, entering
    // from above; the vertical stem is the lead and is therefore not written here, it is drawn to the pin.
    ground: (p) => {
        const body: SymbolStroke[] = [
            {
                points: [
                    [-8, 0],
                    [8, 0],
                ],
            },
            {
                points: [
                    [-5, 3],
                    [5, 3],
                ],
            },
            {
                points: [
                    [-2, 6],
                    [2, 6],
                ],
            },
        ];
        const placed: SymbolPin[] = [{ pinId: p[0] ?? '1', x: 0, y: pinOut(boundsOf(body).minY), side: 'top' }];
        return {
            basis: 'drawn',
            ...measured(withLeads(body, placed), placed),
            pins: placed,
            labelAnchor: { x: 0, y: 12 },
        };
    },
};

/**
 * A rectangle with the part's real pins on it.
 *
 * Pins are split down the middle of the declared order — first half left, second half right — which is the
 * convention for an IC whose pinout is not otherwise known, and which keeps a part's pins in the order its
 * datasheet lists them. The box grows with the pin count rather than clipping: a 40-pin part draws as a tall
 * box, not as a 4-pin box with 36 pins on top of each other.
 */
function derive(pins: string[]): SymbolGeometry {
    const perSide = Math.max(1, Math.ceil(pins.length / 2));
    // Pin pitch IS the lattice. It used to be 12, which put every pin off-grid and therefore made a
    // straight wire between two derived parts impossible — on the path 26 of the 32 component types take.
    const halfHeight = Math.max(2 * PIN_GRID, (perSide * PIN_GRID) / 2 + 4);
    const halfWidth = Math.max(2 * PIN_GRID, 6 + Math.max(...pins.map((p) => p.length), 1) * 4);

    const placed: SymbolPin[] = pins.map((pinId, i) => {
        const left = i < perSide;
        const indexOnSide = left ? i : i - perSide;
        const countOnSide = left ? Math.min(perSide, pins.length) : pins.length - perSide;
        // Centred on the side, so a 3-pin part is not top-heavy — but centred to the nearest LATTICE step
        // rather than exactly. An exact centring puts an even pin count on half-steps (±5, ±15), which is
        // off-grid by construction, and being half a step from centre is invisible where being off-grid is
        // a wire that cannot be straight.
        const y = (indexOnSide - Math.round((countOnSide - 1) / 2)) * PIN_GRID;
        return {
            pinId,
            x: left ? -snapOut(halfWidth + MIN_LEAD) : snapOut(halfWidth + MIN_LEAD),
            y,
            side: left ? 'left' : 'right',
        };
    });

    const body: SymbolStroke[] = [
        {
            points: [
                [-halfWidth, -halfHeight],
                [halfWidth, -halfHeight],
                [halfWidth, halfHeight],
                [-halfWidth, halfHeight],
            ],
            closed: true,
        },
    ];

    return {
        basis: 'derived',
        ...measured(withLeads(body, placed), placed),
        pins: placed,
        labelAnchor: { x: 0, y: -halfHeight - 5 },
    };
}

/**
 * The symbol for a component.
 *
 * Never throws and never returns nothing: a part with no pins at all still draws as a small box, because a
 * design containing it should show it rather than silently have one fewer part than it has.
 */
export function symbolFor(component: Pick<Component, 'type' | 'pins'>): SymbolGeometry {
    const pinIds = (component.pins ?? []).map((p, i) => p.pinId || String(i + 1));
    const drawn = DRAWN[component.type as string];
    if (!drawn) return derive(pinIds.length > 0 ? pinIds : ['1']);

    const geometry = drawn(pinIds);
    // A drawn symbol can DECLINE — a polarised part whose terminals are not named recognisably cannot be
    // oriented, and drawing it anyway would be a claim about polarity we cannot back.
    if (!geometry) return derive(pinIds.length > 0 ? pinIds : ['1']);

    // A drawn symbol also assumes a pin count. A "resistor" that arrives with four pins is not the
    // two-terminal part this shape describes, and forcing it would silently drop two connections — so it
    // derives instead. Better an unfamiliar box that shows every pin than a familiar picture that hides two.
    return geometry.pins.length === pinIds.length ? geometry : derive(pinIds);
}

/** Every component type that has a hand-drawn symbol. Exported so a test can assert the split explicitly. */
export const DRAWN_TYPES: readonly string[] = Object.keys(DRAWN);

/**
 * WHY BJT AND MOSFET ARE NOT DRAWN, even though both are common and both have famous symbols.
 *
 * Their symbols are not decoration: the emitter arrow says NPN or PNP, and the MOSFET body diode and gate
 * gap say n-channel or p-channel. Draw the wrong one and an engineer reads the wrong device off the sheet —
 * a symbol is taken as fact.
 *
 * And we cannot tell. Polarity is not a structured field on `Component`; it lives inside the referenced
 * SPICE model's free-text body (`.model QGENNPN NPN(...)`), which this package neither parses nor should.
 * A box labelled `c` `b` `e` is a smaller claim than an arrow pointing the wrong way, so it is the one made.
 *
 * The fix is upstream and cheap when someone wants it: a `polarity` / `channelType` field on the component,
 * authored where the part is chosen. Until that exists, drawing these would be inventing information.
 */
export const UNDRAWN_BY_DESIGN: readonly string[] = ['bjt', 'mosfet', 'jfet'];
