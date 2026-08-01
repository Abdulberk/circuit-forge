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

const PIN_LEN = 8;

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

/** A two-terminal part: one pin left, one right, body between. The shared frame for R, C, L, D, V. */
function twoTerminal(pins: string[], body: SymbolStroke[], halfWidth: number, halfHeight: number): SymbolGeometry {
    return {
        basis: 'drawn',
        width: (halfWidth + PIN_LEN) * 2,
        height: halfHeight * 2,
        strokes: [
            {
                points: [
                    [-halfWidth - PIN_LEN, 0],
                    [-halfWidth, 0],
                ],
            },
            ...body,
            {
                points: [
                    [halfWidth, 0],
                    [halfWidth + PIN_LEN, 0],
                ],
            },
        ],
        pins: [
            { pinId: pins[0] ?? '1', x: -halfWidth - PIN_LEN, y: 0, side: 'left' },
            { pinId: pins[1] ?? '2', x: halfWidth + PIN_LEN, y: 0, side: 'right' },
        ],
        labelAnchor: { x: 0, y: -halfHeight - 5 },
    };
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
        twoTerminal(
            p,
            [
                {
                    points: [
                        [-10, -4],
                        [10, -4],
                        [10, 4],
                        [-10, 4],
                    ],
                    closed: true,
                },
            ],
            10,
            4,
        ),

    capacitor: (p) => ({
        ...twoTerminal(p, [], 3, 8),
        strokes: [
            {
                points: [
                    [-3 - PIN_LEN, 0],
                    [-3, 0],
                ],
            },
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
            {
                points: [
                    [3, 0],
                    [3 + PIN_LEN, 0],
                ],
            },
        ],
    }),

    inductor: (p) => ({
        ...twoTerminal(p, [], 12, 5),
        strokes: [
            {
                points: [
                    [-12 - PIN_LEN, 0],
                    [-12, 0],
                ],
            },
            // Four arcs approximated as a polyline: a renderer that wants true arcs can draw them instead, but the shape reads.
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
            {
                points: [
                    [12, 0],
                    [12 + PIN_LEN, 0],
                ],
            },
        ],
    }),

    diode: (raw) => {
        // Anode LEFT, cathode RIGHT — by name. Taking them in array order drew the diode backwards for
        // any design that listed cathode first, which is legal everywhere else in this system.
        const p = orderedByName(raw, ['anode', 'a', '+'], ['cathode', 'k', 'c', '-']);
        if (!p) return null;
        return {
            ...twoTerminal(p, [], 7, 7),
            strokes: [
                {
                    points: [
                        [-7 - PIN_LEN, 0],
                        [-7, 0],
                    ],
                },
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
                {
                    points: [
                        [5, 0],
                        [5 + PIN_LEN, 0],
                    ],
                },
            ],
        };
    },

    voltage_source: (raw) => {
        // + on TOP, - on the bottom — by name, for the same reason the diode is. A source drawn upside
        // down inverts every polarity an engineer reads off the sheet.
        const p = orderedByName(raw, ['+', 'p', 'pos', 'plus'], ['-', 'n', 'neg', 'minus']);
        if (!p) return null;
        return {
            basis: 'drawn',
            width: (12 + PIN_LEN) * 2,
            height: 24,
            strokes: [
                {
                    points: [
                        [0, -12 - PIN_LEN],
                        [0, -12],
                    ],
                },
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
                {
                    points: [
                        [0, 12],
                        [0, 12 + PIN_LEN],
                    ],
                },
            ],
            pins: [
                { pinId: p[0] ?? '+', x: 0, y: -12 - PIN_LEN, side: 'top' },
                { pinId: p[1] ?? '-', x: 0, y: 12 + PIN_LEN, side: 'bottom' },
            ],
            labelAnchor: { x: 16, y: 0 },
        };
    },

    ground: (p) => ({
        basis: 'drawn',
        width: 16,
        height: 14,
        strokes: [
            {
                points: [
                    [0, -7],
                    [0, 0],
                ],
            },
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
        ],
        pins: [{ pinId: p[0] ?? '1', x: 0, y: -7, side: 'top' }],
        labelAnchor: { x: 0, y: 12 },
    }),
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
    const spacing = 12;
    const halfHeight = Math.max(14, (perSide * spacing) / 2 + 4);
    const halfWidth = Math.max(18, 6 + Math.max(...pins.map((p) => p.length), 1) * 4);

    const placed: SymbolPin[] = pins.map((pinId, i) => {
        const left = i < perSide;
        const indexOnSide = left ? i : i - perSide;
        const countOnSide = left ? Math.min(perSide, pins.length) : pins.length - perSide;
        // Centred on the side, so a 3-pin part is not top-heavy.
        const y = (indexOnSide - (countOnSide - 1) / 2) * spacing;
        return {
            pinId,
            x: left ? -halfWidth - PIN_LEN : halfWidth + PIN_LEN,
            y,
            side: left ? 'left' : 'right',
        };
    });

    return {
        basis: 'derived',
        width: (halfWidth + PIN_LEN) * 2,
        height: halfHeight * 2,
        strokes: [
            {
                points: [
                    [-halfWidth, -halfHeight],
                    [halfWidth, -halfHeight],
                    [halfWidth, halfHeight],
                    [-halfWidth, halfHeight],
                ],
                closed: true,
            },
            ...placed.map((p) => ({
                points: [
                    [p.x, p.y],
                    [p.side === 'left' ? -halfWidth : halfWidth, p.y],
                ] as Array<[number, number]>,
            })),
        ],
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
