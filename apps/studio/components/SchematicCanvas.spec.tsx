/**
 * @jest-environment jsdom
 */
/**
 * The first surface that draws the design — and the properties that make a drawing trustworthy.
 *
 * A picture of a circuit is read as a claim about the circuit, so the failures that matter are not "it
 * looks wrong": they are a wire drawn where there is no connection, a part missing from the picture that is
 * present in the netlist, and a layout that shuffles between renders so a user cannot point at anything.
 */
import type { CircuitJson, Component, UiJson } from '@circuit-forge/eda-core';
import { isDrawnOnSheet, isPlaceablePart, type TreeNode } from '@circuit-forge/editor-core';
import { render, screen, fireEvent } from '@testing-library/react';

import { SchematicCanvas } from './SchematicCanvas';

const CIRCUIT: CircuitJson = {
    version: '1.0',
    components: [
        {
            id: 'v1',
            type: 'voltage_source',
            designator: 'V1',
            value: 'DC 5',
            pins: [
                { pinId: '+', netId: 'vin' },
                { pinId: '-', netId: 'gnd' },
            ],
        },
        {
            id: 'r1',
            type: 'resistor',
            designator: 'R1',
            value: '1k',
            pins: [
                { pinId: '1', netId: 'vin' },
                { pinId: '2', netId: 'mid' },
            ],
        },
        {
            id: 'r2',
            type: 'resistor',
            designator: 'R2',
            value: '2k',
            pins: [
                { pinId: '1', netId: 'mid' },
                { pinId: '2', netId: 'gnd' },
            ],
        },
        // A ground MARKER, not a part: it annotates a net and nothing places or buys it.
        { id: 'g1', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [
        { id: 'vin', name: 'VIN' },
        { id: 'mid', name: 'MID' },
        { id: 'gnd', name: 'GND', isGround: true },
    ],
};

// Selected by what a wire IS, not by which SVG element happens to draw one. These were `line` elements
// until the router started emitting right angles, and every assertion about wires went quietly green-on-zero
// the moment they became `polyline` — a selector that finds nothing passes a "no wire here" test perfectly.
const wires = (c: HTMLElement) => [...c.querySelectorAll('[data-net]')];

describe('what the canvas draws', () => {
    it('draws every placeable part, and labels it with its designator', () => {
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} />);
        for (const id of ['v1', 'r1', 'r2']) expect(screen.getByTestId(`symbol-${id}`)).toBeTruthy();
        expect(container.textContent).toContain('R1');
        expect(container.textContent).toContain('V1');
    });

    it('DRAWS the ground symbol, because a schematic draws one', () => {
        // Two different questions used to share one answer. Nobody buys a ground symbol or places it on a
        // board — and every schematic in the world draws one. Deciding what goes on the SHEET with the
        // board-and-BOM predicate meant it was never drawn, so the commonest connection in any circuit had no
        // terminal on screen and no gesture could make it; the ground net was instead drawn as long wires
        // reaching across the sheet to everything that touches it, which is what the symbol exists to avoid.
        //
        // RENDERED HERE, and that matters: the test this replaces asserted `queryByTestId(...)` was null
        // WITHOUT rendering anything, which an empty document satisfies. It could not have failed.
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} />);
        expect(container.querySelector('[data-testid="symbol-g1"]')).not.toBeNull();
    });

    it('still counts it as a net annotation rather than a part', () => {
        // The other question keeps its own answer: the tree and the BOM must not gain a component.
        expect(isPlaceablePart({ type: 'ground' })).toBe(false);
        expect(isDrawnOnSheet({ type: 'ground' })).toBe(true);
    });

    it('draws a wire for every CONNECTION and none where there is no net', () => {
        // Three nets: VIN (2 pins), MID (2 pins), GND (3 pins — but the marker is not drawn, so 2 drawn).
        // A star from the first pin means one segment fewer than pins on each net.
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} />);
        const nets = wires(container).map((l) => l.getAttribute('data-net'));
        expect(nets.filter((n) => n === 'VIN')).toHaveLength(1);
        expect(nets.filter((n) => n === 'MID')).toHaveLength(1);
        // NO WIRE FOR GND AT ALL. The reference is marked at each pin that reaches it rather than wired
        // between them, which is what every schematic does and what the measurement argues for: ground was
        // between a third and a half of all the wire on the sheet, crossing everything else. There is a
        // symbol on each of its terminals instead.
        expect(nets.filter((n) => n === 'GND')).toHaveLength(0);
        expect(container.querySelectorAll('[data-testid="ground-glyph"]').length).toBeGreaterThan(0);
    });

    it('draws NO wire for a net with a single pin — an unconnected pin must look unconnected', () => {
        // The one visual lie that would matter: a pin that appears joined to something when it is not.
        const lonely: CircuitJson = {
            version: '1.0',
            components: [
                {
                    id: 'r1',
                    type: 'resistor',
                    designator: 'R1',
                    value: '1k',
                    pins: [
                        { pinId: '1', netId: 'a' },
                        { pinId: '2', netId: 'b' },
                    ],
                },
            ],
            nets: [
                { id: 'a', name: 'A' },
                { id: 'b', name: 'B' },
            ],
        };
        const { container } = render(<SchematicCanvas circuit={lonely} />);
        expect(wires(container)).toHaveLength(0);
    });

    it('CLOSES the shapes that are closed — a box is not a box with one side missing', () => {
        // Measured before this was fixed: `<polyline>` auto-closes when FILLING but never strokes the
        // closing edge, so every closed body in the library rendered short of one side. On a derived box
        // that side is the LEFT one — and 26 of the 32 component types derive — so every IC, transistor,
        // gate and subcircuit drew open, with its left-hand pin stubs floating 10–14 units from anything
        // drawn. The resistor drew as a bracket; the diode had no triangle at all.
        //
        // Asserted structurally (which ELEMENT was emitted) rather than visually, because the difference is
        // invisible in a DOM snapshot: both elements accept the same `points` and differ only in whether
        // the renderer joins the last point to the first.
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} />);
        const closedShapes = container.querySelectorAll('polygon');
        expect(closedShapes.length).toBeGreaterThan(0);

        // …and every one of them is FILLED with a colour that exists. The previous fill named
        // `--surface-2`, which is defined nowhere in the app's stylesheet, so it fell through to
        // transparent and left the missing edges with nothing behind them.
        for (const shape of Array.from(closedShapes)) {
            const fill = shape.getAttribute('fill') ?? '';
            expect({ fill, transparent: /transparent|^none$/.test(fill) }).toEqual({ fill, transparent: false });
        }
    });

    it('keeps a part at NEGATIVE coordinates on screen', () => {
        // Stored positions make negative coordinates ordinary — the origin is the middle of the sheet, not
        // its corner. The viewBox used to be anchored at 0,0 and sized from the maximum, so anything above
        // or left of the origin was simply not drawn, with nothing to say the sheet had been cropped.
        const { container } = render(
            <SchematicCanvas circuit={CIRCUIT} ui={{ positions: { r1: { x: -300, y: -200 } } }} />,
        );
        const [vx, vy, vw, vh] = container.querySelector('svg')!.getAttribute('viewBox')!.split(' ').map(Number);

        expect({ leftOfPart: vx! < -300, abovePart: vy! < -200 }).toEqual({ leftOfPart: true, abovePart: true });
        // …and the far side still reaches whatever else is on the sheet.
        expect({ w: vw! > 0, h: vh! > 0 }).toEqual({ w: true, h: true });
    });

    it('actually TURNS a part the document says is turned', () => {
        // Measured before this was wired: the same symbol rendered with `rotation:'90'` produced SVG
        // byte-identical to the upright one, because the layout read only x and y. The field has been in
        // the schema since it was written and the sheet silently discarded it.
        //
        // Which is worse than a missing feature, because pcb-core's adapter does NOT discard it — it emits
        // `pcbRotation={90}` from the same number. So the board honoured an instruction the drawing ignored,
        // and nothing anywhere compares a schematic against its own board.
        const upright = render(
            <SchematicCanvas circuit={CIRCUIT} ui={{ positions: { r1: { x: 200, y: 100 } } }} />,
        ).container.querySelector('[data-testid="symbol-r1"]')!.innerHTML;

        const turned = render(
            <SchematicCanvas circuit={CIRCUIT} ui={{ positions: { r1: { x: 200, y: 100, rotation: '90' } } }} />,
        ).container.querySelector('[data-testid="symbol-r1"]')!.innerHTML;

        expect(turned).not.toBe(upright);
    });

    it('returns a turned part to itself after four quarter turns', () => {
        // The property that makes the rotate key safe to hold down. Exact integer matrices, so this is
        // identity rather than approximation — a symbol that drifts a fraction per turn eventually has pins
        // off the lattice, and nothing reports that; the wire simply stops meeting the pin.
        const at = (rotation?: '0' | '90' | '180' | '270') =>
            render(
                <SchematicCanvas circuit={CIRCUIT} ui={{ positions: { r1: { x: 200, y: 100, rotation } } }} />,
            ).container.querySelector('[data-testid="symbol-r1"]')!.innerHTML;

        expect(at('0')).toBe(at(undefined));
        expect(at('90')).not.toBe(at('0'));
        expect(at('180')).not.toBe(at('0'));
        expect(at('270')).not.toBe(at('90'));
    });

    it('moves the WIRES with the pins when a part turns', () => {
        // The half that would be easy to miss: a symbol that turns while its wires stay put is a picture of
        // a different circuit. Wire endpoints come from the pin coordinates, so this is really asserting
        // that one source of truth feeds both.
        const ends = (rotation?: '90') =>
            wires(
                render(<SchematicCanvas circuit={CIRCUIT} ui={{ positions: { r1: { x: 200, y: 100, rotation } } }} />)
                    .container,
            )
                .map((l) => l.getAttribute('points'))
                .sort()
                .join(' ');

        expect(ends('90')).not.toBe(ends(undefined));
    });

    it('places the same document the same way every time', () => {
        // (kept adjacent to the drag tests below: a layout that shuffled would make every one of them lie)
        // A layout that shuffled between renders would make it impossible to point at anything, and would
        // make every visual assertion here meaningless.
        const a = render(<SchematicCanvas circuit={CIRCUIT} />).container.innerHTML;
        const b = render(<SchematicCanvas circuit={CIRCUIT} />).container.innerHTML;
        expect(a).toBe(b);
    });

    it('honours stored positions over the fallback grid', () => {
        const { container } = render(
            <SchematicCanvas circuit={CIRCUIT} ui={{ positions: { r1: { x: 300, y: 120 } } }} />,
        );
        expect(container.querySelector('[data-testid="symbol-r1"]')?.getAttribute('transform')).toBe(
            'translate(300 120)',
        );
    });

    it('says so plainly when there is nothing to draw', () => {
        const empty: CircuitJson = { version: '1.0', components: [], nets: [] };
        render(<SchematicCanvas circuit={empty} />);
        expect(screen.getByText(/no placeable parts/i)).toBeTruthy();
    });
});

describe('selection is shared with the tree, not invented here', () => {
    it('selects the SAME object a tree row would', () => {
        const picked: Array<string | undefined> = [];
        render(<SchematicCanvas circuit={CIRCUIT} onSelect={(n) => picked.push(n?.ref.path.join('/'))} />);

        fireEvent.click(screen.getByTestId('symbol-r1'));

        // Resolved through the real object tree, so clicking a symbol and clicking its row are the same act.
        expect(picked).toEqual(['root/components/r1']);
    });

    it('marks the selected part differently from the rest', () => {
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} selectedPaths={['root/components/r1']} />);
        const selected = container.querySelector('[data-testid="symbol-r1"] polyline');
        const other = container.querySelector('[data-testid="symbol-r2"] polyline');
        expect(selected?.getAttribute('stroke')).not.toBe(other?.getAttribute('stroke'));
    });
});

/**
 * DRAGGING — and the two properties that are about data loss rather than about feel.
 *
 * The document is not touched while the pointer is down. That is not a preference: measured against the
 * real kernel, routing sixty pointer-moves through `commitUi` overflows a fifty-deep history and EVICTS
 * every earlier revision, so Ctrl+Z walks the symbol back a pixel at a time and the edit the user actually
 * wanted to undo is gone permanently. Each call also resets the local-persist timer, so nothing reaches the
 * device for as long as the gesture lasts — the window in which a crash costs the most.
 */
describe('dragging a part', () => {
    /** jsdom gives every element a zero-size box; the canvas needs one to convert pixels to sheet units. */
    const withBox = (container: HTMLElement, w = 800, h = 600) => {
        const svg = container.querySelector('svg')!;
        svg.getBoundingClientRect = () =>
            ({ width: w, height: h, x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, toJSON: () => ({}) }) as DOMRect;
        return svg;
    };

    const dragBy = (container: HTMLElement, id: string, dx: number, dy: number) => {
        const svg = withBox(container);
        const part = container.querySelector(`[data-testid="symbol-${id}"]`)!;
        fireEvent.pointerDown(part, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
        fireEvent.pointerMove(svg, { pointerId: 1, clientX: dx, clientY: dy });
        fireEvent.pointerUp(svg, { pointerId: 1, clientX: dx, clientY: dy });
    };

    it('commits ONE revision, on release', () => {
        const calls: Array<[string, unknown]> = [];
        const { container } = render(
            <SchematicCanvas
                circuit={CIRCUIT}
                ui={{ positions: { r1: { x: 100, y: 100 } } }}
                onArrange={(label, next) => calls.push([label, next])}
            />,
        );
        dragBy(container, 'r1', 40, 30);
        expect(calls).toHaveLength(1);
        expect(calls[0]![0]).toBe('Move R1');
    });

    it('writes NOTHING while the pointer is down', () => {
        // The measured failure: sixty per-frame commits overflow a fifty-deep history and destroy the undo
        // stack. Asserted by counting commits DURING the gesture rather than by inspecting the kernel.
        const calls: unknown[] = [];
        const { container } = render(
            <SchematicCanvas
                circuit={CIRCUIT}
                ui={{ positions: { r1: { x: 100, y: 100 } } }}
                onArrange={(...a) => calls.push(a)}
            />,
        );
        const svg = withBox(container);
        const part = container.querySelector('[data-testid="symbol-r1"]')!;
        fireEvent.pointerDown(part, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
        for (let i = 1; i <= 60; i++) fireEvent.pointerMove(svg, { pointerId: 1, clientX: i, clientY: i });
        expect(calls).toHaveLength(0); // …sixty frames, nothing committed
        fireEvent.pointerUp(svg, { pointerId: 1, clientX: 60, clientY: 60 });
        expect(calls).toHaveLength(1); // …and exactly one on release
    });

    it('SNAPS the dropped position onto the pin lattice', () => {
        // A part dropped off-grid has pins off-grid, and a wire to an off-grid pin cannot be a straight
        // line — which is the whole reason the lattice exists.
        let next: UiJson | undefined;
        const { container } = render(
            <SchematicCanvas
                circuit={CIRCUIT}
                ui={{ positions: { r1: { x: 100, y: 100 } } }}
                onArrange={(_l, n) => (next = n)}
            />,
        );
        dragBy(container, 'r1', 37, 23);
        const p = next!.positions!.r1!;
        expect({ onGrid: p.x % 10 === 0 && p.y % 10 === 0 }).toEqual({ onGrid: true });
    });

    it('a plain CLICK writes no geometry at all', () => {
        // Selecting a part in a design nobody has arranged must not materialise its fallback position. That
        // position is not neutral: pcb-core's adapter seeds BOARD placement from `positions` as soon as
        // every part has one, so a click could silently re-lay-out the board — measured elsewhere as parts
        // moving from 10 mm apart to 15 mm apart.
        const calls: unknown[] = [];
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} onArrange={(...a) => calls.push(a)} />);
        const svg = withBox(container);
        const part = container.querySelector('[data-testid="symbol-r1"]')!;
        fireEvent.pointerDown(part, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
        fireEvent.pointerUp(svg, { pointerId: 1 });
        expect(calls).toHaveLength(0);
    });

    it('moves ONLY the part under the pointer', () => {
        let next: UiJson | undefined;
        const { container } = render(
            <SchematicCanvas
                circuit={CIRCUIT}
                ui={{ positions: { r1: { x: 100, y: 100 }, r2: { x: 300, y: 100 } } }}
                onArrange={(_l, n) => (next = n)}
            />,
        );
        dragBy(container, 'r1', 50, 0);
        expect(next!.positions!.r2).toEqual({ x: 300, y: 100 }); // untouched
        expect(next!.positions!.r1!.x).not.toBe(100);
    });

    it('KEEPS a part’s rotation when it is moved', () => {
        // Position carries more than x and y. A move that dropped the rotation would silently straighten a
        // part the user had turned — and pcb-core reads that field, so the board would change too.
        let next: UiJson | undefined;
        const { container } = render(
            <SchematicCanvas
                circuit={CIRCUIT}
                ui={{ positions: { r1: { x: 100, y: 100, rotation: '90' } } }}
                onArrange={(_l, n) => (next = n)}
            />,
        );
        dragBy(container, 'r1', 40, 0);
        expect(next!.positions!.r1!.rotation).toBe('90');
    });

    it('is READ-ONLY when no handler is given', () => {
        // Every screen that only displays a schematic gets the old behaviour, with no way to modify a
        // document by accident.
        const { container } = render(
            <SchematicCanvas circuit={CIRCUIT} ui={{ positions: { r1: { x: 100, y: 100 } } }} />,
        );
        const before = container.querySelector('[data-testid="symbol-r1"]')!.getAttribute('transform');
        dragBy(container, 'r1', 60, 60);
        expect(container.querySelector('[data-testid="symbol-r1"]')!.getAttribute('transform')).toBe(before);
    });
});

/**
 * ROTATING with the keyboard — the step that makes rotation a feature rather than a schema field.
 *
 * It was storable, then renderable, and until this there was no way for a person to produce one. That is
 * the defect shape this codebase keeps finding: a capability built end to end, green, and unreachable.
 */
describe('rotating the selected part', () => {
    const R1 = 'root/components/r1';

    it('turns it a quarter, and commits ONE revision', () => {
        const calls: Array<[string, UiJson]> = [];
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                ui={{ positions: { r1: { x: 100, y: 100 } } }}
                selectedPaths={[R1]}
                onArrange={(l, n) => calls.push([l, n])}
            />,
        );
        fireEvent.keyDown(window, { key: 'r' });
        expect(calls).toHaveLength(1);
        expect(calls[0]![0]).toBe('Rotate R1');
        expect(calls[0]![1].positions!.r1).toEqual({ x: 100, y: 100, rotation: '90' });
    });

    it('comes back UPRIGHT on the fourth press, with no rotation left behind', () => {
        // `rotationField` omits a zero, so the fourth press produces a drawing structurally equal to the one
        // before the first — and the commit kernel compares by value, so it mints nothing. Writing
        // `rotation: '0'` explicitly would leave a revision and a save for a part that visibly did not move.
        let ui: UiJson = { positions: { r1: { x: 100, y: 100 } } };
        const { rerender } = render(
            <SchematicCanvas circuit={CIRCUIT} ui={ui} selectedPaths={[R1]} onArrange={(_l, n) => (ui = n)} />,
        );
        for (const expected of ['90', '180', '270', undefined]) {
            fireEvent.keyDown(window, { key: 'r' });
            rerender(
                <SchematicCanvas circuit={CIRCUIT} ui={ui} selectedPaths={[R1]} onArrange={(_l, n) => (ui = n)} />,
            );
            expect(ui.positions!.r1!.rotation).toBe(expected);
        }
    });

    it('does NOT fire while the user is typing', () => {
        // `R` is a letter. Typing a resistance of `4R7` in the Inspector must not turn the part behind the
        // panel — and the guard is the SAME one the undo shortcut uses, not a second copy of it.
        const calls: unknown[] = [];
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                ui={{ positions: { r1: { x: 100, y: 100 } } }}
                selectedPaths={[R1]}
                onArrange={(...a) => calls.push(a)}
            />,
        );
        const input = document.createElement('input');
        document.body.appendChild(input);
        fireEvent.keyDown(input, { key: 'r' });
        expect(calls).toHaveLength(0);
        input.remove();
    });

    it('ignores the CHORDED versions, which belong to the browser', () => {
        const calls: unknown[] = [];
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                ui={{ positions: { r1: { x: 100, y: 100 } } }}
                selectedPaths={[R1]}
                onArrange={(...a) => calls.push(a)}
            />,
        );
        fireEvent.keyDown(window, { key: 'r', ctrlKey: true }); // reload
        fireEvent.keyDown(window, { key: 'r', metaKey: true });
        fireEvent.keyDown(window, { key: 'r', altKey: true });
        expect(calls).toHaveLength(0);
    });

    it('does nothing when the selection is not a part', () => {
        const calls: unknown[] = [];
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                ui={{ positions: { r1: { x: 100, y: 100 } } }}
                selectedPaths={['root/nets/VIN']}
                onArrange={(...a) => calls.push(a)}
            />,
        );
        fireEvent.keyDown(window, { key: 'r' });
        expect(calls).toHaveLength(0);
    });

    it('turns a part nobody has arranged, placing it where it already appears', () => {
        // `Position` requires x and y, so a rotation cannot be written without them — turning an un-arranged
        // part necessarily places it, exactly as dragging one does. The coordinates come from where the part
        // is ON SCREEN, so nothing moves.
        let next: UiJson | undefined;
        const { container } = render(
            <SchematicCanvas circuit={CIRCUIT} selectedPaths={[R1]} onArrange={(_l, n) => (next = n)} />,
        );
        const before = container.querySelector('[data-testid="symbol-r1"]')!.getAttribute('transform');
        fireEvent.keyDown(window, { key: 'r' });
        const p = next!.positions!.r1!;
        expect({ rotation: p.rotation, placedWhereItWas: `translate(${p.x} ${p.y})` }).toEqual({
            rotation: '90',
            placedWhereItWas: before,
        });
    });
});

/**
 * THE LATTICE, in the frame that actually matters.
 *
 * `symbolFor` guarantees every pin sits on the PIN_GRID lattice in the symbol's OWN frame, and
 * `geometry.spec.ts` in editor-core proves it there. That guarantee is worth nothing if the canvas then
 * places the symbol at an off-grid origin — and it did: the fallback layout put part centres at 68, 156 and
 * 244, so pins landed on residues 4, 6 and 8 mod 10 and no lattice contained them.
 *
 * Two parts side by side then had pins at heights that could not be joined by a straight line, which is the
 * one thing the grid exists to make possible. The local contract was green throughout; the property it was
 * protecting was false where wires are drawn.
 */
describe('every pin lands on the lattice in ABSOLUTE coordinates', () => {
    const PIN_GRID = 10;

    /** Where each symbol was actually translated to, read off the rendered SVG. */
    const originsOf = (container: HTMLElement) =>
        [...container.querySelectorAll('[data-testid^="symbol-"]')].map((g) => {
            const [x, y] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(g.getAttribute('transform')!)!.slice(1).map(Number);
            return { x: x!, y: y! };
        });

    it('holds for the FALLBACK layout, which is what every AI-generated design gets', () => {
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} />);
        const off = originsOf(container).filter((o) => o.x % PIN_GRID !== 0 || o.y % PIN_GRID !== 0);
        expect({ offLattice: off }).toEqual({ offLattice: [] });
    });

    it('holds for a STORED position that is off-grid', () => {
        // A drawing written by an older build, or by hand, can carry anything. The sheet still has to draw
        // parts whose pins can be joined.
        const { container } = render(
            <SchematicCanvas circuit={CIRCUIT} ui={{ positions: { r1: { x: 137, y: 92 } } }} />,
        );
        const off = originsOf(container).filter((o) => o.x % PIN_GRID !== 0 || o.y % PIN_GRID !== 0);
        expect({ offLattice: off }).toEqual({ offLattice: [] });
    });

    it('a part moves exactly as far as the pointer did, on its FIRST drag', () => {
        // The honest form of "does it jump". A zero-distance gesture commits nothing BY DESIGN — a click
        // must not write geometry — so asserting on one proves only that nothing happened. My first version
        // of this test did exactly that and stayed green against the very defect it was written for.
        //
        // So: move the pointer a whole number of grid steps and require the part to move the same amount.
        // Off the lattice that fails by construction — a part at 68 dragged 10 lands at 78, snaps to 80, and
        // has travelled 12. The hand said one square; the part went one and a fifth.
        let next: UiJson | undefined;
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} onArrange={(_l, n) => (next = n)} />);
        const svg = container.querySelector('svg')!;
        // One sheet unit per pixel, so the numbers below mean what they say.
        const box = svg.getAttribute('viewBox')!.split(' ').map(Number);
        const [w, h] = [box[2]!, box[3]!];
        svg.getBoundingClientRect = () =>
            ({ width: w, height: h, x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, toJSON: () => ({}) }) as DOMRect;
        const before = originsOf(container)[1]!; // r1, which no one has arranged

        const part = container.querySelector('[data-testid="symbol-r1"]')!;
        fireEvent.pointerDown(part, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
        for (const ev of [fireEvent.pointerMove, fireEvent.pointerUp])
            ev(svg, { pointerId: 1, clientX: 200 + PIN_GRID, clientY: 200 + 2 * PIN_GRID });

        expect(next?.positions?.r1).toEqual(
            expect.objectContaining({ x: before.x + PIN_GRID, y: before.y + 2 * PIN_GRID }),
        );
    });
});

describe('the wires read as a schematic', () => {
    it('draws right angles, not diagonals', () => {
        // The visible half of the routing work. A schematic reader follows right angles; a star of diagonals
        // is a topology diagram wearing a schematic's clothes. The kernel proves no wire LIES; this proves
        // the drawing that reaches the screen is the routed one and not a straight line from pin to pin.
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} />);
        const diagonal = wires(container).flatMap((w) => {
            const pts = w
                .getAttribute('points')!
                .split(' ')
                .map((p) => p.split(',').map(Number));
            return pts
                .slice(1)
                .map((p, i) => ({ from: pts[i]!, to: p }))
                .filter((s) => s.from[0] !== s.to[0] && s.from[1] !== s.to[1]);
        });
        expect({ diagonalSegments: diagonal }).toEqual({ diagonalSegments: [] });
    });

    it('marks a branch with a dot, so a fork is not read as a crossing', () => {
        // COUNTED BY WHAT THEY ARE, not by the element that draws them. The first version of this asserted
        // that the sheet contained at least one <circle> — and the canvas draws a <circle> for every pin, so
        // parts alone satisfied it. Measured: deleting every junction dot from the kernel left all 32 tests
        // in this file green, on a sheet with ten circles of which eight were pins.
        const withFork: CircuitJson = {
            ...CIRCUIT,
            components: [
                ...CIRCUIT.components!,
                {
                    id: 'r3',
                    type: 'resistor',
                    designator: 'R3',
                    value: '3k',
                    pins: [
                        { pinId: '1', netId: 'mid' },
                        { pinId: '2', netId: 'gnd' },
                    ],
                },
            ],
        };
        const { container } = render(<SchematicCanvas circuit={withFork} />);
        expect(container.querySelectorAll('[data-testid="junction"]').length).toBeGreaterThan(0);
    });

    it('marks a wire the router says is not trustworthy, so the warning reaches the screen', () => {
        // The kernel reports a wire whose every possible line states something the netlist does not, and
        // calls that report "the only reason this case is not a silent bug". Nothing read it: the lying wire
        // was drawn as an ordinary grey diagonal, identical to an honest one, so on screen the report did
        // not exist. Here a foreign terminal sits exactly on the only terminal a wire can reach.
        const trapped: CircuitJson = {
            version: '1.0',
            components: [
                {
                    id: 'r1',
                    type: 'resistor',
                    designator: 'R1',
                    value: '1k',
                    pins: [
                        { pinId: '1', netId: 'a' },
                        { pinId: '2', netId: 'b' },
                    ],
                },
                {
                    id: 'r2',
                    type: 'resistor',
                    designator: 'R2',
                    value: '1k',
                    pins: [
                        { pinId: '1', netId: 'a' },
                        { pinId: '2', netId: 'b' },
                    ],
                },
                {
                    id: 'r3',
                    type: 'resistor',
                    designator: 'R3',
                    value: '1k',
                    pins: [
                        { pinId: '1', netId: 'c' },
                        { pinId: '2', netId: 'd' },
                    ],
                },
                {
                    id: 'r4',
                    type: 'resistor',
                    designator: 'R4',
                    value: '1k',
                    pins: [
                        { pinId: '1', netId: 'c' },
                        { pinId: '2', netId: 'd' },
                    ],
                },
            ],
            nets: [
                { id: 'a', name: 'A' },
                { id: 'b', name: 'B' },
                { id: 'c', name: 'C' },
                { id: 'd', name: 'D' },
            ],
        };
        // R4 is placed so that its terminals land exactly on R3's, which are a different node. No line from
        // R4 to anywhere states only what the netlist says, and the router reports both of its wires.
        const { container } = render(
            <SchematicCanvas
                circuit={trapped}
                ui={{
                    schemaVersion: 1,
                    positions: {
                        r1: { x: 100, y: 100 },
                        r2: { x: 100, y: 140 },
                        r3: { x: 100, y: 120 },
                        r4: { x: 140, y: 120 },
                    },
                }}
            />,
        );
        expect(container.querySelectorAll('[data-trust="unverified"]').length).toBeGreaterThan(0);
    });
});

/**
 * Looking at a sheet, which is the difference between a picture and an editor.
 *
 * A viewBox pinned to the content means a four-hundred-part design is drawn at a size where nothing can be
 * read and nothing can be pointed at. These are the properties that make zooming usable rather than present:
 * the point under the cursor does not move, the sheet can be found again, and — the one that actually breaks
 * — a part dropped while zoomed lands where it was dropped.
 */
describe('the view can be moved and the drawing still lands where it is dropped', () => {
    const PIN_GRID = 10;

    const sized = (container: HTMLElement, w = 800, h = 600): SVGSVGElement => {
        const svg = container.querySelector('svg')!;
        svg.getBoundingClientRect = () =>
            ({ width: w, height: h, x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, toJSON: () => ({}) }) as DOMRect;
        return svg;
    };
    const viewBox = (svg: SVGSVGElement): number[] => svg.getAttribute('viewBox')!.split(' ').map(Number);

    it('zooms about the pointer: what is under the cursor stays under the cursor', () => {
        // The whole specification of a wheel zoom. Scaling about the view's CENTRE instead passes any test
        // that only checks "the box got smaller", and feels broken in the way people describe as "it runs
        // away from me" — you point at the part you want and it slides off the screen.
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} />);
        const svg = sized(container);
        const [x0, y0, w0, h0] = viewBox(svg) as [number, number, number, number];

        // The mapping the browser performs: uniform scale, centred, letterboxed on one axis.
        const perPixel = 1 / Math.min(800 / w0, 600 / h0);
        const left = (800 - w0 / perPixel) / 2;
        const top = (600 - h0 / perPixel) / 2;
        const [cx, cy] = [520, 190];
        const under = [x0 + (cx - left) * perPixel, y0 + (cy - top) * perPixel];

        fireEvent.wheel(svg, { deltaY: -100, clientX: cx, clientY: cy });

        const [x1, y1, w1, h1] = viewBox(svg) as [number, number, number, number];
        expect(w1).toBeLessThan(w0); // it did zoom IN
        const perPixel2 = 1 / Math.min(800 / w1, 600 / h1);
        const left2 = (800 - w1 / perPixel2) / 2;
        const top2 = (600 - h1 / perPixel2) / 2;
        const stillUnder = [x1 + (cx - left2) * perPixel2, y1 + (cy - top2) * perPixel2];
        expect(stillUnder[0]).toBeCloseTo(under[0]!, 6);
        expect(stillUnder[1]).toBeCloseTo(under[1]!, 6);
    });

    it('cannot be zoomed past the point of showing anything', () => {
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} />);
        const svg = sized(container);
        for (let i = 0; i < 200; i++) fireEvent.wheel(svg, { deltaY: -100, clientX: 400, clientY: 300 });
        expect(viewBox(svg)[2]).toBeGreaterThanOrEqual(40); // four grid steps: one symbol, filling the screen
        for (let i = 0; i < 400; i++) fireEvent.wheel(svg, { deltaY: 100, clientX: 400, clientY: 300 });
        expect(viewBox(svg)[2]).toBeLessThan(1e5); // and not lost in empty space either
    });

    it('pans by exactly what the pointer travelled, and F brings the drawing back', () => {
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} />);
        const svg = sized(container);
        const before = viewBox(svg);
        const perPixel = 1 / Math.min(800 / before[2]!, 600 / before[3]!);

        fireEvent.pointerDown(svg, { pointerId: 9, button: 0, clientX: 400, clientY: 300 });
        fireEvent.pointerMove(svg, { pointerId: 9, clientX: 460, clientY: 340 });
        fireEvent.pointerUp(svg, { pointerId: 9, clientX: 460, clientY: 340 });

        const after = viewBox(svg);
        // Dragging the sheet right moves the WINDOW left, by the sheet-distance the hand covered.
        expect(after[0]).toBeCloseTo(before[0]! - 60 * perPixel, 6);
        expect(after[1]).toBeCloseTo(before[1]! - 40 * perPixel, 6);

        fireEvent.keyDown(window, { key: 'f' });
        expect(viewBox(svg)).toEqual(before);
    });

    it('drops a dragged part where it was dropped, at ANY zoom', () => {
        // The property the whole mapping exists for, and the one that breaks when there are two of them: the
        // pointer delta is in pixels and the document is in sheet units, so a wrong conversion moves the part
        // by the zoom factor. At fit it is invisible, because the factor is near one.
        let next: UiJson | undefined;
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} onArrange={(_l, n) => (next = n)} />);
        const svg = sized(container);
        // Far enough in that a wrong conversion is a wrong ANSWER. Two notches leaves the scale within about
        // twenty percent of one, and at twenty units of travel a twenty percent error snaps straight back to
        // the right lattice point — so a test built that way passes against a mapping that ignores the zoom
        // entirely. Measured: it did.
        for (let i = 0; i < 12; i++) fireEvent.wheel(svg, { deltaY: -100, clientX: 400, clientY: 300 });

        const [, , w] = viewBox(svg) as [number, number, number, number];
        const perPixel = 1 / Math.min(800 / w, 600 / viewBox(svg)[3]!);
        const before = /translate\(([-\d.]+) ([-\d.]+)\)/
            .exec(container.querySelector('[data-testid="symbol-r1"]')!.getAttribute('transform')!)!
            .slice(1)
            .map(Number);

        // Travel a whole number of grid steps ON THE SHEET, expressed in the pixels that now means — and far
        // enough that snapping cannot round a wrong answer back onto the right one.
        const travel = 10 * PIN_GRID;
        const pixels = travel / perPixel;
        const part = container.querySelector('[data-testid="symbol-r1"]')!;
        fireEvent.pointerDown(part, { pointerId: 3, button: 0, clientX: 300, clientY: 300 });
        for (const ev of [fireEvent.pointerMove, fireEvent.pointerUp])
            ev(svg, { pointerId: 3, clientX: 300 + pixels, clientY: 300 });

        expect(next?.positions?.r1).toEqual(expect.objectContaining({ x: before[0]! + travel, y: before[1]! }));
    });
});

/**
 * Drawing a wire, which is the act that makes this an editor.
 *
 * Connecting two terminals was possible before this — through a dropdown in the Inspector, one pin at a
 * time. That is a form for describing a connection, not a way of making one. `connectPins` had been in the
 * kernel, tested, with no gesture that could reach it.
 */
describe('a wire can be drawn from one terminal to another', () => {
    const sized = (container: HTMLElement): SVGSVGElement => {
        const svg = container.querySelector('svg')!;
        svg.getBoundingClientRect = () =>
            ({
                width: 800,
                height: 600,
                x: 0,
                y: 0,
                top: 0,
                left: 0,
                right: 800,
                bottom: 600,
                toJSON: () => ({}),
            }) as DOMRect;
        return svg;
    };

    /** Where a terminal actually is on the sheet, read off the drawing rather than assumed. */
    const pinAt = (container: HTMLElement, part: string, pin: string): [number, number] => {
        const circle = container.querySelector(`[data-testid="pin-${part}-${pin}"]`)!;
        const [tx, ty] = /translate\(([-\d.]+) ([-\d.]+)\)/
            .exec(circle.closest('g[data-testid^="symbol-"]')!.getAttribute('transform')!)!
            .slice(1)
            .map(Number);
        return [tx! + Number(circle.getAttribute('cx')), ty! + Number(circle.getAttribute('cy'))];
    };

    /** The same mapping the browser performs, inverted: a point on the sheet as a point on the screen. */
    const clientAt = (svg: SVGSVGElement, x: number, y: number): { clientX: number; clientY: number } => {
        const [bx, by, bw, bh] = svg.getAttribute('viewBox')!.split(' ').map(Number) as [
            number,
            number,
            number,
            number,
        ];
        const perUnit = Math.min(800 / bw, 600 / bh);
        return {
            clientX: (800 - bw * perUnit) / 2 + (x - bx) * perUnit,
            clientY: (600 - bh * perUnit) / 2 + (y - by) * perUnit,
        };
    };

    it('reports the two terminals the hand joined, and nothing more', () => {
        // The canvas decides NOTHING about what a connection means. It says which two terminals; the kernel
        // says whether that is a change, a no-op, or a refusal — including the ground-to-rail short, which is
        // refused with the remedy named. A canvas that judged it would be the second authority this codebase
        // keeps paying for.
        const joined: unknown[] = [];
        const { container } = render(
            <SchematicCanvas circuit={CIRCUIT} onConnect={(from, to) => joined.push({ from, to })} />,
        );
        const svg = sized(container);

        fireEvent.pointerDown(container.querySelector('[data-testid="pin-r1-2"]')!, {
            pointerId: 5,
            button: 0,
            ...clientAt(svg, ...pinAt(container, 'r1', '2')),
        });
        fireEvent.pointerUp(svg, { pointerId: 5, ...clientAt(svg, ...pinAt(container, 'r2', '1')) });

        expect(joined).toEqual([{ from: { componentId: 'r1', pinId: '2' }, to: { componentId: 'r2', pinId: '1' } }]);
    });

    it('shows the wire while it is being drawn, and only while', () => {
        // The line has to be visibly NOT a wire yet: drawn straight to the pointer, dashed, in the accent
        // colour. Routing it would state that the connection exists, and it does not until the pointer is up.
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} onConnect={() => {}} />);
        const svg = sized(container);
        expect(container.querySelector('[data-testid="wire-in-flight"]')).toBeNull();

        fireEvent.pointerDown(container.querySelector('[data-testid="pin-r1-2"]')!, {
            pointerId: 6,
            button: 0,
            ...clientAt(svg, ...pinAt(container, 'r1', '2')),
        });
        fireEvent.pointerMove(svg, { pointerId: 6, clientX: 250, clientY: 180 });
        expect(container.querySelector('[data-testid="wire-in-flight"]')).not.toBeNull();

        fireEvent.pointerUp(svg, { pointerId: 6, clientX: 250, clientY: 180 });
        expect(container.querySelector('[data-testid="wire-in-flight"]')).toBeNull();
    });

    it('dropped on empty sheet, joins nothing — changing your mind is not an error', () => {
        const joined: unknown[] = [];
        const { container } = render(
            <SchematicCanvas circuit={CIRCUIT} onConnect={(from, to) => joined.push({ from, to })} />,
        );
        const svg = sized(container);
        const [px, py] = pinAt(container, 'r1', '2');
        fireEvent.pointerDown(container.querySelector('[data-testid="pin-r1-2"]')!, {
            pointerId: 7,
            button: 0,
            ...clientAt(svg, px, py),
        });
        // A long way from any terminal, on the empty sheet below the drawing.
        fireEvent.pointerUp(svg, { pointerId: 7, ...clientAt(svg, px + 37, py + 41) });
        expect(joined).toEqual([]);
    });

    it('starting a wire does not drag the part, and does not pan the sheet', () => {
        // Three gestures share one pointer press and each has to refuse the other two. A terminal that also
        // dragged its symbol would move the part every time somebody tried to wire it.
        let arranged = 0;
        const { container } = render(
            <SchematicCanvas circuit={CIRCUIT} onConnect={() => {}} onArrange={() => (arranged += 1)} />,
        );
        const svg = sized(container);
        const before = svg.getAttribute('viewBox');

        fireEvent.pointerDown(container.querySelector('[data-testid="pin-r1-2"]')!, {
            pointerId: 8,
            button: 0,
            ...clientAt(svg, ...pinAt(container, 'r1', '2')),
        });
        fireEvent.pointerMove(svg, { pointerId: 8, clientX: 400, clientY: 300 });
        fireEvent.pointerUp(svg, { pointerId: 8, clientX: 400, clientY: 300 });

        // AND NOTHING IS LEFT RUNNING. If the press had also started a part drag, the wire gesture would end
        // and the drag would still be in flight — so the next time the pointer moved anywhere, the part would
        // follow it, with no button held. Asserting only "nothing was committed during the gesture" misses
        // that entirely: measured, deleting the guard that stops the press reaching the symbol left every
        // assertion here green.
        const at = pinAt(container, 'r1', '2');
        fireEvent.pointerMove(svg, { pointerId: 8, clientX: 600, clientY: 500 });
        fireEvent.pointerUp(svg, { pointerId: 8, clientX: 600, clientY: 500 });

        expect({ arranged, view: svg.getAttribute('viewBox'), pin: pinAt(container, 'r1', '2') }).toEqual({
            arranged: 0,
            view: before,
            pin: at,
        });
    });

    it('can be drawn TO GROUND, which is the commonest connection there is', () => {
        // The whole point of putting the ground symbol on the sheet. Before it, this gesture did not exist:
        // the symbol was not drawn, so it had no terminal, so the connection every circuit needs most could
        // only be made through a dropdown in a side panel.
        const joined: unknown[] = [];
        const { container } = render(
            <SchematicCanvas circuit={CIRCUIT} onConnect={(from, to) => joined.push({ from, to })} />,
        );
        const svg = sized(container);

        fireEvent.pointerDown(container.querySelector('[data-testid="pin-r1-2"]')!, {
            pointerId: 21,
            button: 0,
            ...clientAt(svg, ...pinAt(container, 'r1', '2')),
        });
        fireEvent.pointerUp(svg, { pointerId: 21, ...clientAt(svg, ...pinAt(container, 'g1', '1')) });

        expect(joined).toEqual([{ from: { componentId: 'r1', pinId: '2' }, to: { componentId: 'g1', pinId: '1' } }]);
    });

    it('is not offered at all when the canvas cannot change the design', () => {
        // A viewer of somebody else's design should not be handed a gesture that goes nowhere — and the grab
        // targets are not free either: one invisible circle per terminal is half again as many DOM nodes as
        // the drawing itself, on a sheet where nothing can be connected anyway.
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} />);
        expect(container.querySelectorAll('[data-testid^="pin-"]')).toHaveLength(0);
        // And with wiring on, every terminal has one.
        const wired = render(<SchematicCanvas circuit={CIRCUIT} onConnect={() => {}} />);
        expect(wired.container.querySelectorAll('[data-testid^="pin-"]').length).toBeGreaterThan(0);
    });
});

/**
 * The properties an audit found were claimed and not checked.
 *
 * Every test above passed while each of these was broken. They are here because a suite that cannot tell the
 * difference between working and not is a slower way of shipping the same defect.
 */
describe('the view and the gestures, at the edges where they actually broke', () => {
    const PIN_GRID = 10;
    const sized = (container: HTMLElement, w = 800, h = 600): SVGSVGElement => {
        const svg = container.querySelector('svg')!;
        svg.getBoundingClientRect = () =>
            ({ width: w, height: h, x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, toJSON: () => ({}) }) as DOMRect;
        return svg;
    };
    const viewBox = (svg: SVGSVGElement): number[] => svg.getAttribute('viewBox')!.split(' ').map(Number);
    const translateOf = (el: Element): number[] =>
        /translate\(([-\d.]+) ([-\d.]+)\)/.exec(el.getAttribute('transform')!)!.slice(1).map(Number);

    it('five notches zoom five times as far as one', () => {
        // Notches compound rather than replacing one another.
        //
        // WHAT THIS DOES NOT PROVE, said plainly: the failure it was written for is a burst of wheel events
        // arriving before React paints, where computing each from the RENDERED box makes them all start from
        // the same place. Testing-library flushes state between synthetic events, so the burst cannot be
        // produced here at all. The guarantee rests on the update being written against the PREVIOUS view
        // rather than the rendered one, which this cannot see — what it can see is that the arithmetic
        // compounds, which is the half that is checkable.
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} />);
        const svg = sized(container);
        const w0 = viewBox(svg)[2]!;
        for (let i = 0; i < 5; i++) fireEvent.wheel(svg, { deltaY: -100, clientX: 400, clientY: 300 });
        expect(viewBox(svg)[2]).toBeCloseTo(w0 * Math.pow(1 / 1.1, 5), 6);
    });

    it('a horizontal swipe changes nothing, and does not end fit-to-content', () => {
        // A trackpad sends deltaY exactly zero for a sideways swipe. Math.sign(0) is 0, so the factor was 1:
        // nothing moved on screen, and yet the fit view was replaced by a fixed rectangle — so the drawing
        // silently stopped following the design as it grew.
        const { container, rerender } = render(<SchematicCanvas circuit={CIRCUIT} />);
        const svg = sized(container);
        const before = viewBox(svg);
        fireEvent.wheel(svg, { deltaY: 0, deltaX: -120, clientX: 400, clientY: 300 });
        expect(viewBox(svg)).toEqual(before);

        // Still fitting: a bigger design re-fits rather than staying on the old rectangle.
        const bigger: CircuitJson = {
            ...CIRCUIT,
            components: [
                ...CIRCUIT.components!,
                ...Array.from(
                    { length: 6 },
                    (_, i): Component => ({
                        id: `x${i}`,
                        type: 'resistor',
                        designator: `X${i}`,
                        value: '1k',
                        pins: [
                            { pinId: '1', netId: 'mid' },
                            { pinId: '2', netId: 'gnd' },
                        ],
                    }),
                ),
            ],
        };
        rerender(<SchematicCanvas circuit={bigger} />);
        expect(viewBox(sized(container))[2]).toBeGreaterThan(before[2]!);
    });

    it('a zoom-OUT notch never zooms in, whatever the drawing did since', () => {
        // The limits used to clamp a VALUE rather than a direction. When the design shrank, the current view
        // could already be wider than the new limit, and a zoom-out then snapped it back inside — zooming IN
        // by up to eighteen times on a gesture asking for the opposite.
        const { container, rerender } = render(<SchematicCanvas circuit={CIRCUIT} />);
        const svg = sized(container);
        for (let i = 0; i < 30; i++) fireEvent.wheel(svg, { deltaY: 100, clientX: 400, clientY: 300 });
        const wide = viewBox(svg)[2]!;

        // The design shrinks to a single part, so "the widest allowed" collapses under the current view.
        rerender(<SchematicCanvas circuit={{ ...CIRCUIT, components: [CIRCUIT.components![1]!] }} />);
        const svg2 = sized(container);
        fireEvent.wheel(svg2, { deltaY: 100, clientX: 400, clientY: 300 });
        expect(viewBox(svg2)[2]).toBeGreaterThanOrEqual(wide);
    });

    it('bounds BOTH sides of the view, not just its width', () => {
        // Clamping the width alone left a tall sheet's height unbounded in both directions.
        const { container } = render(
            <SchematicCanvas
                circuit={CIRCUIT}
                ui={{
                    schemaVersion: 1,
                    positions: { v1: { x: 60, y: 40 }, r1: { x: 60, y: 900 }, r2: { x: 60, y: 1800 } },
                }}
            />,
        );
        const svg = sized(container);
        for (let i = 0; i < 300; i++) fireEvent.wheel(svg, { deltaY: -100, clientX: 400, clientY: 300 });
        const [, , wIn, hIn] = viewBox(svg) as [number, number, number, number];
        expect(Math.min(wIn, hIn)).toBeGreaterThanOrEqual(PIN_GRID * 4 - 1e-6);

        for (let i = 0; i < 600; i++) fireEvent.wheel(svg, { deltaY: 100, clientX: 400, clientY: 300 });
        const [, , wOut, hOut] = viewBox(svg) as [number, number, number, number];
        // The drawing is about eighteen hundred units tall; eight times that is as lost as anyone needs to be.
        expect(Math.max(wOut, hOut)).toBeLessThanOrEqual(1900 * 8);
    });

    it('pans by the pointer for the whole gesture, not just the first frame', () => {
        // One pointermove cannot see a pan that accumulates: the delta is measured from where the gesture
        // began, so a second move that ADDS to the first instead of replacing it doubles the travel.
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} />);
        const svg = sized(container);
        const before = viewBox(svg);
        const perPixel = 1 / Math.min(800 / before[2]!, 600 / before[3]!);

        fireEvent.pointerDown(svg, { pointerId: 11, button: 0, clientX: 400, clientY: 300 });
        for (const [x, y] of [
            [420, 310],
            [450, 330],
            [480, 360],
        ])
            fireEvent.pointerMove(svg, { pointerId: 11, clientX: x, clientY: y });
        fireEvent.pointerUp(svg, { pointerId: 11, clientX: 480, clientY: 360 });

        expect(viewBox(svg)[0]).toBeCloseTo(before[0]! - 80 * perPixel, 6);
        expect(viewBox(svg)[1]).toBeCloseTo(before[1]! - 60 * perPixel, 6);
    });

    it('the grab target is bounded at both ends: never missed, never swallowing a symbol', () => {
        // Nine pixels' worth of sheet, floored so the first paint cannot make it invisible and CAPPED at half
        // a grid step so it can never reach a neighbouring terminal or cover a body. Unbounded it did both:
        // under two pixels on the first paint of a large sheet, and tens of units zoomed out, where the
        // invisible circles sat on top of the symbols and dragging stopped working.
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} onConnect={() => {}} />);
        const svg = sized(container);
        const radius = (): number => Number(container.querySelector('[data-testid="pin-r1-2"]')!.getAttribute('r'));
        expect(radius()).toBeLessThanOrEqual(PIN_GRID / 2);
        expect(radius()).toBeGreaterThanOrEqual(2);

        for (let i = 0; i < 60; i++) fireEvent.wheel(svg, { deltaY: 100, clientX: 400, clientY: 300 });
        expect(radius()).toBeLessThanOrEqual(PIN_GRID / 2);
        for (let i = 0; i < 120; i++) fireEvent.wheel(svg, { deltaY: -100, clientX: 400, clientY: 300 });
        expect(radius()).toBeGreaterThanOrEqual(2);
    });

    it('a cancelled gesture writes nothing', () => {
        // pointercancel is the browser saying the gesture is over and did not happen — a device removed, an
        // OS interruption, a touch becoming a two-finger gesture. It used to run the same code as a release,
        // so it committed geometry, minted a revision and scheduled a save.
        const committed: unknown[] = [];
        const { container } = render(
            <SchematicCanvas circuit={CIRCUIT} onArrange={(l, n) => committed.push([l, n])} />,
        );
        const svg = sized(container);
        fireEvent.pointerDown(container.querySelector('[data-testid="symbol-r1"]')!, {
            pointerId: 12,
            button: 0,
            clientX: 300,
            clientY: 300,
        });
        fireEvent.pointerMove(svg, { pointerId: 12, clientX: 380, clientY: 340 });
        fireEvent.pointerCancel(svg, { pointerId: 12 });
        expect(committed).toEqual([]);
    });

    it('a stray pointer does not destroy the gesture another one is performing', () => {
        // The ownership check ran AFTER the state was cleared, so a release by any pointer aborted the
        // gesture in flight — two fingers on a tablet produced two real drags and nothing committed at all.
        const committed: unknown[] = [];
        const { container } = render(
            <SchematicCanvas circuit={CIRCUIT} onArrange={(l, n) => committed.push([l, n])} />,
        );
        const svg = sized(container);
        fireEvent.pointerDown(container.querySelector('[data-testid="symbol-r1"]')!, {
            pointerId: 13,
            button: 0,
            clientX: 300,
            clientY: 300,
        });
        fireEvent.pointerMove(svg, { pointerId: 13, clientX: 400, clientY: 300 });
        fireEvent.pointerUp(svg, { pointerId: 99, clientX: 400, clientY: 300 }); // somebody else's finger
        fireEvent.pointerMove(svg, { pointerId: 13, clientX: 400, clientY: 300 });
        fireEvent.pointerUp(svg, { pointerId: 13, clientX: 400, clientY: 300 });

        expect(committed).toHaveLength(1);
    });

    it('a view change during a drag does not move the part', () => {
        // The drag origin used to be stored in client PIXELS and reconverted through the current mapping on
        // every move, so zooming mid-gesture rescaled a distance the hand had already travelled: twelve wheel
        // notches moved a stationary part seven and a half grid steps, and the release committed that.
        let committed: UiJson | undefined;
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} onArrange={(_l, n) => (committed = n)} />);
        const svg = sized(container);
        fireEvent.pointerDown(container.querySelector('[data-testid="symbol-r1"]')!, {
            pointerId: 14,
            button: 0,
            clientX: 300,
            clientY: 300,
        });
        fireEvent.pointerMove(svg, { pointerId: 14, clientX: 400, clientY: 300 });
        const moved = translateOf(container.querySelector('[data-testid="symbol-r1"]')!);

        for (let i = 0; i < 12; i++) fireEvent.wheel(svg, { deltaY: -100, clientX: 400, clientY: 300 });
        fireEvent.pointerMove(svg, { pointerId: 14, clientX: 400, clientY: 300 }); // the hand has not moved
        // To a millionth of a grid step. Converting a point through a changed scale leaves a residue in the
        // last bits of a double — three parts in a hundred thousand billion, which is not movement, and the
        // committed value snaps to the lattice regardless. Demanding bit-equality here would be demanding
        // something arithmetic cannot give, and would fail for a reason that has nothing to do with the part.
        const now = translateOf(container.querySelector('[data-testid="symbol-r1"]')!);
        expect(now[0]).toBeCloseTo(moved[0]!, 6);
        expect(now[1]).toBeCloseTo(moved[1]!, 6);

        fireEvent.pointerUp(svg, { pointerId: 14, clientX: 400, clientY: 300 });
        expect(committed?.positions?.r1).toEqual(
            expect.objectContaining({ x: Math.round(moved[0]! / PIN_GRID) * PIN_GRID }),
        );
    });

    it('a click on a terminal is not a connection', () => {
        // Pressing and releasing on one terminal reported it joined to ITSELF, which the kernel refuses — so
        // selecting a pin, or thinking better of a wire before moving, put an error banner on screen for an
        // action nobody took.
        const joined: unknown[] = [];
        const { container } = render(
            <SchematicCanvas circuit={CIRCUIT} onConnect={(from, to) => joined.push({ from, to })} />,
        );
        const svg = sized(container);
        const pin = container.querySelector('[data-testid="pin-r1-2"]')!;
        const [bx, by, bw, bh] = viewBox(svg) as [number, number, number, number];
        const perUnit = Math.min(800 / bw, 600 / bh);
        const [tx, ty] = translateOf(pin.closest('g[data-testid^="symbol-"]')!);
        const at = {
            clientX: (800 - bw * perUnit) / 2 + (tx! + Number(pin.getAttribute('cx')) - bx) * perUnit,
            clientY: (600 - bh * perUnit) / 2 + (ty! + Number(pin.getAttribute('cy')) - by) * perUnit,
        };

        fireEvent.pointerDown(pin, { pointerId: 15, button: 0, ...at });
        fireEvent.pointerUp(svg, { pointerId: 15, ...at });
        expect(joined).toEqual([]);
    });

    it('the right mouse button starts nothing', () => {
        const joined: unknown[] = [];
        const { container } = render(
            <SchematicCanvas
                circuit={CIRCUIT}
                onConnect={(from, to) => joined.push({ from, to })}
                onArrange={() => {}}
            />,
        );
        const svg = sized(container);
        const before = svg.getAttribute('viewBox');
        fireEvent.pointerDown(container.querySelector('[data-testid="pin-r1-2"]')!, {
            pointerId: 16,
            button: 2,
            clientX: 300,
            clientY: 300,
        });
        fireEvent.pointerDown(svg, { pointerId: 17, button: 2, clientX: 300, clientY: 300 });
        fireEvent.pointerMove(svg, { pointerId: 17, clientX: 500, clientY: 400 });
        expect({
            joined,
            inFlight: container.querySelector('[data-testid="wire-in-flight"]'),
            view: svg.getAttribute('viewBox'),
        }).toEqual({ joined: [], inFlight: null, view: before });
    });
});

/**
 * Taking a connection back, which is the half of wiring that was missing.
 *
 * You could join two terminals by dragging and could only part them through a dropdown in a side panel.
 * `disconnectPin` had been in the kernel with its own tests and nothing on the drawing could reach it.
 */
describe('a connection can be taken back from the drawing', () => {
    const pinPath = (part: string, pin: string): string => `root/components/${part}/pins/${pin}`;

    it('selects the TERMINAL when a terminal is clicked, not the part it belongs to', () => {
        // "Delete what is selected" is ambiguous unless a terminal is its own object. Clicking one used to
        // select the symbol, which is the wrong answer at exactly the moment it matters.
        let selected: TreeNode | null = null;
        const { container } = render(
            <SchematicCanvas circuit={CIRCUIT} onConnect={() => {}} onSelect={(n) => (selected = n)} />,
        );
        fireEvent.click(container.querySelector('[data-testid="pin-r1-2"]')!);
        expect(selected).toEqual(expect.objectContaining({ ref: expect.objectContaining({ kind: 'pin', id: '2' }) }));
    });

    it('Delete takes the selected terminal off its net', () => {
        const parted: unknown[] = [];
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={[pinPath('r1', '2')]}
                onDisconnect={(pin) => parted.push(pin)}
            />,
        );
        fireEvent.keyDown(window, { key: 'Delete' });
        expect(parted).toEqual([{ componentId: 'r1', pinId: '2' }]);
    });

    it('Backspace does the same, and neither fires while the user is typing', () => {
        // Backspace is browser-back on some setups and a text edit everywhere else, so a field that owns the
        // keystroke keeps it — the same guard the undo shortcut uses.
        const parted: unknown[] = [];
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={[pinPath('r2', '1')]}
                onDisconnect={(pin) => parted.push(pin)}
            />,
        );
        const field = document.createElement('input');
        document.body.appendChild(field);
        fireEvent.keyDown(field, { key: 'Backspace' });
        expect(parted).toEqual([]);

        fireEvent.keyDown(window, { key: 'Backspace' });
        expect(parted).toEqual([{ componentId: 'r2', pinId: '1' }]);
        field.remove();
    });

    it('does nothing when the selection is not a terminal', () => {
        // A part is selected: this verb has no meaning for it yet, and doing something surprising instead of
        // nothing is worse than doing nothing.
        const parted: unknown[] = [];
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/components/r1']}
                onDisconnect={(pin) => parted.push(pin)}
            />,
        );
        fireEvent.keyDown(window, { key: 'Delete' });
        expect(parted).toEqual([]);
    });

    it('ignores the chorded versions, which belong to the browser', () => {
        const parted: unknown[] = [];
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={[pinPath('r1', '2')]}
                onDisconnect={(pin) => parted.push(pin)}
            />,
        );
        for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }])
            fireEvent.keyDown(window, { key: 'Delete', ...mod });
        expect(parted).toEqual([]);
    });

    it('is not offered when the canvas cannot change the design', () => {
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} selectedPaths={[pinPath('r1', '2')]} />);
        // No handler, so nothing to fire — and the assertion that matters is that the keystroke does not
        // throw on the way to doing nothing.
        expect(() => fireEvent.keyDown(window, { key: 'Delete' })).not.toThrow();
        expect(container.querySelector('svg')).not.toBeNull();
    });
});

/**
 * The two verbs the canvas was missing, and the field that had nowhere to be written from.
 */
describe('mirroring, which was built and unreachable', () => {
    const mirrorOf = (next: UiJson | undefined): string | undefined => next?.positions?.r1?.mirror;

    it('X mirrors the selected part, and X again returns it', () => {
        // `Position.mirror` has been in the schema since it was written, `orientSymbol` applies it and
        // `pcb-core` reads it — and nothing anywhere could WRITE one. The same gap rotation had: a field, a
        // renderer that honours it, and no key.
        let next: UiJson | undefined;
        const { rerender } = render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/components/r1']}
                onArrange={(_l, n) => (next = n)}
            />,
        );
        fireEvent.keyDown(window, { key: 'x' });
        expect(mirrorOf(next)).toBe('x');

        rerender(
            <SchematicCanvas
                circuit={CIRCUIT}
                ui={next}
                selectedPaths={['root/components/r1']}
                onArrange={(_l, n) => (next = n)}
            />,
        );
        fireEvent.keyDown(window, { key: 'x' });
        // DROPPED, not set to anything. A part mirrored twice is the part, and leaving the field behind would
        // make the drawing structurally different from the one before the first press — so the commit kernel
        // would mint a revision and a save for a part that visibly did not move.
        expect(next?.positions?.r1).not.toHaveProperty('mirror');
    });

    it('Y mirrors the other way, and replaces an X rather than stacking on it', () => {
        let next: UiJson | undefined;
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                ui={{ schemaVersion: 1, positions: { r1: { x: 100, y: 100, mirror: 'x' } } }}
                selectedPaths={['root/components/r1']}
                onArrange={(_l, n) => (next = n)}
            />,
        );
        fireEvent.keyDown(window, { key: 'y' });
        expect(mirrorOf(next)).toBe('y');
    });

    it('KEEPS the rotation it already had', () => {
        // Two independent fields. Mirroring a part that is turned must not straighten it — the drawing and
        // the board both read `rotation`, and losing it here would make the sheet disagree with the layout.
        let next: UiJson | undefined;
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                ui={{ schemaVersion: 1, positions: { r1: { x: 100, y: 100, rotation: '90' } } }}
                selectedPaths={['root/components/r1']}
                onArrange={(_l, n) => (next = n)}
            />,
        );
        fireEvent.keyDown(window, { key: 'x' });
        expect(next?.positions?.r1).toEqual(expect.objectContaining({ rotation: '90', mirror: 'x' }));
    });

    it('does NOT fire while the user is typing', () => {
        // `x` and `y` are letters, and the Inspector is full of text fields — a part number with an x in it
        // would otherwise flip the part behind the panel.
        let fired = 0;
        render(
            <SchematicCanvas circuit={CIRCUIT} selectedPaths={['root/components/r1']} onArrange={() => (fired += 1)} />,
        );
        const field = document.createElement('input');
        document.body.appendChild(field);
        for (const key of ['x', 'y', 'r']) fireEvent.keyDown(field, { key });
        expect(fired).toBe(0);
        field.remove();
    });
});

describe('deleting a part from the drawing', () => {
    it('Delete removes the selected PART, not just a terminal', () => {
        // The other half of one verb: a terminal comes off its net, a part comes off the design. Both were in
        // the kernel with tests, and only the terminal could be reached from the sheet.
        const removed: string[] = [];
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/components/r1']}
                onDelete={(ids) => removed.push(...ids)}
            />,
        );
        fireEvent.keyDown(window, { key: 'Delete' });
        expect(removed).toEqual(['r1']);
    });

    it('leaves a terminal selection to the disconnect verb', () => {
        // One key, two objects, and they must not both answer.
        const removed: string[] = [];
        const parted: unknown[] = [];
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/components/r1/pins/2']}
                onDelete={(ids) => removed.push(...ids)}
                onDisconnect={(pin) => parted.push(pin)}
            />,
        );
        fireEvent.keyDown(window, { key: 'Delete' });
        expect({ removed, parted }).toEqual({ removed: [], parted: [{ componentId: 'r1', pinId: '2' }] });
    });

    it('does nothing when the selection is a net', () => {
        const removed: string[] = [];
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/nets/gnd']}
                onDelete={(ids) => removed.push(...ids)}
            />,
        );
        fireEvent.keyDown(window, { key: 'Delete' });
        expect(removed).toEqual([]);
    });
});

/**
 * Selecting more than one thing, which is what turns twenty gestures back into one.
 */
describe('more than one object can be selected', () => {
    const sized = (container: HTMLElement): SVGSVGElement => {
        const svg = container.querySelector('svg')!;
        svg.getBoundingClientRect = () =>
            ({
                width: 800,
                height: 600,
                x: 0,
                y: 0,
                top: 0,
                left: 0,
                right: 800,
                bottom: 600,
                toJSON: () => ({}),
            }) as DOMRect;
        return svg;
    };
    const translateOf = (el: Element): number[] =>
        /translate\(([-\d.]+) ([-\d.]+)\)/.exec(el.getAttribute('transform')!)!.slice(1).map(Number);

    it('reports whether Shift was held, and decides nothing itself', () => {
        // The canvas says WHICH object and WHETHER the key was down. What that means — add, remove, replace
        // — is one decision, made once, above both surfaces. Two surfaces each interpreting the key is the
        // defect this codebase already paid for: one told the Inspector and the other painted a different row.
        const seen: Array<{ id: string | undefined; additive: boolean | undefined }> = [];
        const { container } = render(
            <SchematicCanvas circuit={CIRCUIT} onSelect={(n, a) => seen.push({ id: n?.ref.id, additive: a })} />,
        );
        fireEvent.click(container.querySelector('[data-testid="symbol-r1"]')!);
        fireEvent.click(container.querySelector('[data-testid="symbol-r2"]')!, { shiftKey: true });
        expect(seen).toEqual([
            { id: 'r1', additive: false },
            { id: 'r2', additive: true },
        ]);
    });

    it('marks every selected part, not just the last one', () => {
        const { container } = render(
            <SchematicCanvas circuit={CIRCUIT} selectedPaths={['root/components/r1', 'root/components/r2']} />,
        );
        const strokeOf = (id: string) =>
            container
                .querySelector(`[data-testid="symbol-${id}"] polyline, [data-testid="symbol-${id}"] polygon`)!
                .getAttribute('stroke');
        expect(strokeOf('r1')).toBe(strokeOf('r2'));
        expect(strokeOf('r1')).not.toBe(strokeOf('v1'));
    });

    it('drags the WHOLE selection when one of it is grabbed', () => {
        // The behaviour that makes selecting things worth doing. Dragging one of two selected parts and
        // having the other stay put is how people learn not to bother selecting.
        let next: UiJson | undefined;
        const { container } = render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/components/r1', 'root/components/r2']}
                onArrange={(_l, n) => (next = n)}
            />,
        );
        const svg = sized(container);
        const before = {
            r1: translateOf(container.querySelector('[data-testid="symbol-r1"]')!),
            r2: translateOf(container.querySelector('[data-testid="symbol-r2"]')!),
        };

        fireEvent.pointerDown(container.querySelector('[data-testid="symbol-r1"]')!, {
            pointerId: 31,
            button: 0,
            clientX: 300,
            clientY: 300,
        });
        for (const ev of [fireEvent.pointerMove, fireEvent.pointerUp])
            ev(svg, { pointerId: 31, clientX: 380, clientY: 300 });

        // Both moved, by the same amount, in one revision.
        const moved = {
            r1: next?.positions?.r1,
            r2: next?.positions?.r2,
        };
        expect(moved.r1!.x - before.r1[0]!).toBe(moved.r2!.x - before.r2[0]!);
        expect(moved.r1!.x).not.toBe(before.r1[0]);
    });

    it('drags a part that is NOT in the selection alone', () => {
        // Grabbing something outside the selection plainly means that thing, and moving four other parts
        // because they happened to be selected would be the editor doing something nobody asked for.
        let next: UiJson | undefined;
        const { container } = render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/components/r2', 'root/components/v1']}
                onArrange={(_l, n) => (next = n)}
            />,
        );
        const svg = sized(container);
        fireEvent.pointerDown(container.querySelector('[data-testid="symbol-r1"]')!, {
            pointerId: 32,
            button: 0,
            clientX: 300,
            clientY: 300,
        });
        for (const ev of [fireEvent.pointerMove, fireEvent.pointerUp])
            ev(svg, { pointerId: 32, clientX: 380, clientY: 300 });

        expect(Object.keys(next?.positions ?? {})).toEqual(['r1']);
    });

    it('Delete removes every selected part, in ONE action', () => {
        // Five parts deleted one call at a time would be five undo steps for one gesture, and every
        // intermediate document is one nobody asked for.
        const removed: string[][] = [];
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/components/r1', 'root/components/r2']}
                onDelete={(ids) => removed.push([...ids])}
            />,
        );
        fireEvent.keyDown(window, { key: 'Delete' });
        expect(removed).toEqual([['r1', 'r2']]);
    });

    it('clicking the bare sheet selects nothing', () => {
        // The way OUT of a selection. Without it a selection can be replaced and never dropped, and with a
        // key that acts on all of them that is a question a user should not answer with a lucky click.
        const seen: Array<string | null> = [];
        const { container } = render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/components/r1']}
                onSelect={(n) => seen.push(n?.ref.id ?? null)}
            />,
        );
        fireEvent.click(container.querySelector('svg')!);
        expect(seen).toEqual([null]);
    });
});

/**
 * What an audit found the multi-select work getting wrong, every one of which the suite passed.
 *
 * These are not edge cases. Four of them fire on the second gesture a user makes.
 */
describe('a gesture is not a click, and a selection is not a click order', () => {
    const sized = (container: HTMLElement): SVGSVGElement => {
        const svg = container.querySelector('svg')!;
        svg.getBoundingClientRect = () =>
            ({
                width: 800,
                height: 600,
                x: 0,
                y: 0,
                top: 0,
                left: 0,
                right: 800,
                bottom: 600,
                toJSON: () => ({}),
            }) as DOMRect;
        return svg;
    };

    it('panning the sheet does NOT clear the selection', () => {
        // A browser fires `click` after a press and release on the same element however far the pointer
        // travelled between them. A pan starts and ends on the svg, so every pan destroyed the selection the
        // user had just assembled — and the click-away is the only way to clear one deliberately, so the
        // feature and its escape hatch were the same gesture.
        const seen: Array<string | null> = [];
        const { container } = render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/components/r1']}
                onSelect={(n) => seen.push(n?.ref.id ?? null)}
            />,
        );
        const svg = sized(container);
        fireEvent.pointerDown(svg, { pointerId: 41, button: 0, clientX: 400, clientY: 300 });
        fireEvent.pointerMove(svg, { pointerId: 41, clientX: 500, clientY: 360 });
        fireEvent.pointerUp(svg, { pointerId: 41, clientX: 500, clientY: 360 });
        fireEvent.click(svg);
        expect(seen).toEqual([]);
    });

    it('a click on bare sheet that did NOT travel still clears it', () => {
        // The other half. Suppressing the click after a gesture must not suppress the gesture that is only a
        // click, or there is no way out of a selection at all.
        const seen: Array<string | null> = [];
        const { container } = render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/components/r1']}
                onSelect={(n) => seen.push(n?.ref.id ?? null)}
            />,
        );
        const svg = sized(container);
        fireEvent.pointerDown(svg, { pointerId: 42, button: 0, clientX: 400, clientY: 300 });
        fireEvent.pointerUp(svg, { pointerId: 42, clientX: 400, clientY: 300 });
        fireEvent.click(svg);
        expect(seen).toEqual([null]);
    });

    it('a group drag does not collapse the selection onto the part that was grabbed', () => {
        // The drag ends with a click on the dragged symbol, and treating that as a selection replaced the
        // whole group with the one part just moved — so a group could be dragged exactly once.
        const seen: Array<string | null> = [];
        const { container } = render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/components/r1', 'root/components/r2']}
                onArrange={() => {}}
                onSelect={(n) => seen.push(n?.ref.id ?? null)}
            />,
        );
        const svg = sized(container);
        const part = container.querySelector('[data-testid="symbol-r1"]')!;
        fireEvent.pointerDown(part, { pointerId: 43, button: 0, clientX: 300, clientY: 300 });
        fireEvent.pointerMove(svg, { pointerId: 43, clientX: 400, clientY: 300 });
        fireEvent.pointerUp(svg, { pointerId: 43, clientX: 400, clientY: 300 });
        fireEvent.click(part);
        expect(seen).toEqual([]);
    });

    it('R turns EVERY selected part, which is what the Inspector promises', () => {
        // The panel says in so many words that the keyboard verbs act on all of them. This acted on one, so
        // pressing R with several selected turned one and left the rest, with nothing saying why.
        let next: UiJson | undefined;
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/components/r1', 'root/components/r2']}
                onArrange={(_l, n) => (next = n)}
            />,
        );
        fireEvent.keyDown(window, { key: 'r' });
        expect(next?.positions?.r1?.rotation).toBe('90');
        expect(next?.positions?.r2?.rotation).toBe('90');
    });

    it('each part turns from ITS OWN angle, not from the primary’s', () => {
        // A group at different angles must all advance a quarter. Deciding once from the primary and
        // applying it to everyone would snap them together — a different edit from the one the key means.
        let next: UiJson | undefined;
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                ui={{ schemaVersion: 1, positions: { r1: { x: 100, y: 100, rotation: '90' }, r2: { x: 200, y: 100 } } }}
                selectedPaths={['root/components/r1', 'root/components/r2']}
                onArrange={(_l, n) => (next = n)}
            />,
        );
        fireEvent.keyDown(window, { key: 'r' });
        expect(next?.positions?.r1?.rotation).toBe('180');
        expect(next?.positions?.r2?.rotation).toBe('90');
    });

    it('X mirrors each part according to ITS OWN state', () => {
        // One already mirrored is returned; one that is not is mirrored. A single decision taken from the
        // primary would flip a part that was already flipped — the opposite of what the key does to it alone.
        let next: UiJson | undefined;
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                ui={{ schemaVersion: 1, positions: { r1: { x: 100, y: 100, mirror: 'x' }, r2: { x: 200, y: 100 } } }}
                selectedPaths={['root/components/r1', 'root/components/r2']}
                onArrange={(_l, n) => (next = n)}
            />,
        );
        fireEvent.keyDown(window, { key: 'x' });
        expect(next?.positions?.r1).not.toHaveProperty('mirror');
        expect(next?.positions?.r2?.mirror).toBe('x');
    });

    it('Delete acts on what is SELECTED, whatever was clicked last', () => {
        // It used to branch on the kind of the most recent click before looking at anything else: three
        // parts selected with a net row clicked last matched neither branch, and the key did nothing at all
        // — no deletion, no refusal, no banner.
        const removed: string[][] = [];
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/components/r1', 'root/components/r2', 'root/nets/gnd']}
                onDelete={(ids) => removed.push([...ids])}
            />,
        );
        fireEvent.keyDown(window, { key: 'Delete' });
        expect(removed).toEqual([['r1', 'r2']]);
    });

    it('takes several terminals off their nets when only terminals are selected', () => {
        const parted: unknown[] = [];
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/components/r1/pins/2', 'root/components/r2/pins/1']}
                onDisconnect={(pin) => parted.push(pin)}
            />,
        );
        fireEvent.keyDown(window, { key: 'Delete' });
        expect(parted).toEqual([
            { componentId: 'r1', pinId: '2' },
            { componentId: 'r2', pinId: '1' },
        ]);
    });

    it('prefers the parts when both parts and terminals are selected', () => {
        // Deleting a part takes its terminals with it, so doing both would be one of them twice.
        const removed: string[][] = [];
        const parted: unknown[] = [];
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/components/r1', 'root/components/r2/pins/1']}
                onDelete={(ids) => removed.push([...ids])}
                onDisconnect={(pin) => parted.push(pin)}
            />,
        );
        fireEvent.keyDown(window, { key: 'Delete' });
        expect({ removed, parted }).toEqual({ removed: [['r1']], parted: [] });
    });

    it('a ground symbol follows the part it marks while that part is dragged', () => {
        // Ground is not wired, so the symbol is the ONLY depiction of that connection. Leaving it behind
        // showed the reference detached from the part for the whole gesture.
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} onArrange={() => {}} />);
        const svg = sized(container);
        const glyphAt = () =>
            [...container.querySelectorAll('[data-testid="ground-glyph"]')].map((g) => g.getAttribute('transform'));
        const before = glyphAt();

        fireEvent.pointerDown(container.querySelector('[data-testid="symbol-v1"]')!, {
            pointerId: 44,
            button: 0,
            clientX: 300,
            clientY: 300,
        });
        fireEvent.pointerMove(svg, { pointerId: 44, clientX: 420, clientY: 300 });
        // At least one moved with it, and the ones belonging to parts that did not move stayed put.
        expect(glyphAt()).not.toEqual(before);
    });
});

/**
 * Selecting many at once, and making another of what is already right.
 *
 * Shift-clicking each part is the same number of gestures as not having multi-select at all once there are
 * more than about four; copying is the gesture people reach for when they have got something right and want
 * another of it. Neither existed.
 */
describe('a box selects, and Ctrl+D copies', () => {
    const translateOf = (el: Element): number[] =>
        /translate\(([-\d.]+) ([-\d.]+)\)/.exec(el.getAttribute('transform')!)!.slice(1).map(Number);

    const sized = (container: HTMLElement): SVGSVGElement => {
        const svg = container.querySelector('svg')!;
        svg.getBoundingClientRect = () =>
            ({
                width: 800,
                height: 600,
                x: 0,
                y: 0,
                top: 0,
                left: 0,
                right: 800,
                bottom: 600,
                toJSON: () => ({}),
            }) as DOMRect;
        return svg;
    };

    it('takes everything the box TOUCHES, not only what it encloses', () => {
        // A box that takes only what it fully contains makes a user draw it twice — once too small, once
        // right — which is the whole cost the gesture was meant to remove.
        const picked: string[] = [];
        const { container } = render(
            <SchematicCanvas circuit={CIRCUIT} onSelect={(n) => picked.push(n?.ref.id ?? 'null')} />,
        );
        const svg = sized(container);
        // A box that CLIPS r1 rather than containing it: from outside the sheet to a point inside the
        // symbol's own bounds. Enclosing and touching give different answers here, which a box drawn over
        // the whole sheet cannot tell apart — and that is what the first version of this test did.
        const r1 = translateOf(container.querySelector('[data-testid="symbol-r1"]')!);
        const [bx, by, bw, bh] = svg.getAttribute('viewBox')!.split(' ').map(Number) as [
            number,
            number,
            number,
            number,
        ];
        const perUnit = Math.min(800 / bw, 600 / bh);
        const at = (x: number, y: number) => ({
            clientX: (800 - bw * perUnit) / 2 + (x - bx) * perUnit,
            clientY: (600 - bh * perUnit) / 2 + (y - by) * perUnit,
        });
        fireEvent.pointerDown(svg, { pointerId: 51, button: 0, shiftKey: true, ...at(r1[0]! - 200, r1[1]! - 200) });
        fireEvent.pointerMove(svg, { pointerId: 51, ...at(r1[0]!, r1[1]!) });
        fireEvent.pointerUp(svg, { pointerId: 51, ...at(r1[0]!, r1[1]!) });
        expect(picked).toContain('r1');
    });

    it('shows the box while it is being drawn, and only while', () => {
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} onSelect={() => {}} />);
        const svg = sized(container);
        expect(container.querySelector('[data-testid="marquee"]')).toBeNull();
        fireEvent.pointerDown(svg, { pointerId: 52, button: 0, shiftKey: true, clientX: 100, clientY: 100 });
        fireEvent.pointerMove(svg, { pointerId: 52, clientX: 300, clientY: 250 });
        expect(container.querySelector('[data-testid="marquee"]')).not.toBeNull();
        fireEvent.pointerUp(svg, { pointerId: 52, clientX: 300, clientY: 250 });
        expect(container.querySelector('[data-testid="marquee"]')).toBeNull();
    });

    it('a bare drag on the sheet still PANS rather than selecting', () => {
        // Panning is the more common act by a long way, so the box is the modified gesture and not the other
        // way round. Getting this backwards would make the sheet feel stuck.
        const picked: string[] = [];
        const { container } = render(
            <SchematicCanvas circuit={CIRCUIT} onSelect={(n) => picked.push(n?.ref.id ?? 'null')} />,
        );
        const svg = sized(container);
        const before = svg.getAttribute('viewBox');
        fireEvent.pointerDown(svg, { pointerId: 53, button: 0, clientX: 100, clientY: 100 });
        fireEvent.pointerMove(svg, { pointerId: 53, clientX: 300, clientY: 250 });
        fireEvent.pointerUp(svg, { pointerId: 53, clientX: 300, clientY: 250 });
        expect({ picked, moved: svg.getAttribute('viewBox') !== before }).toEqual({ picked: [], moved: true });
    });

    it('a shift-press that does not travel changes nothing', () => {
        // An empty box must not read as "select nothing" and destroy a selection the user just built.
        const picked: string[] = [];
        const { container } = render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/components/r1']}
                onSelect={(n) => picked.push(n?.ref.id ?? 'null')}
            />,
        );
        const svg = sized(container);
        // ON a part, so an empty box would otherwise CATCH something: "the box did not travel" and "the box
        // caught nothing" are different reasons for the same outcome, and only one of them is being tested.
        const r1 = translateOf(container.querySelector('[data-testid="symbol-r1"]')!);
        const [bx, by, bw, bh] = svg.getAttribute('viewBox')!.split(' ').map(Number) as [
            number,
            number,
            number,
            number,
        ];
        const perUnit = Math.min(800 / bw, 600 / bh);
        const on = {
            clientX: (800 - bw * perUnit) / 2 + (r1[0]! - bx) * perUnit,
            clientY: (600 - bh * perUnit) / 2 + (r1[1]! - by) * perUnit,
        };
        fireEvent.pointerDown(svg, { pointerId: 54, button: 0, shiftKey: true, ...on });
        fireEvent.pointerUp(svg, { pointerId: 54, ...on });
        expect(picked).toEqual([]);
    });

    it('Ctrl+D asks for a copy of every selected part', () => {
        const asked: string[][] = [];
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/components/r1', 'root/components/r2']}
                onDuplicate={(ids) => asked.push([...ids])}
            />,
        );
        fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
        expect(asked).toEqual([['r1', 'r2']]);
    });

    it('leaves Ctrl+D to the browser when there is nothing to copy', () => {
        // It is "bookmark this page" out there. Taking it is only defensible when there is a selection.
        const asked: string[][] = [];
        render(<SchematicCanvas circuit={CIRCUIT} onDuplicate={(ids) => asked.push([...ids])} />);
        fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
        expect(asked).toEqual([]);
    });

    it('does not copy while the user is typing', () => {
        const asked: string[][] = [];
        render(
            <SchematicCanvas
                circuit={CIRCUIT}
                selectedPaths={['root/components/r1']}
                onDuplicate={(ids) => asked.push([...ids])}
            />,
        );
        const field = document.createElement('input');
        document.body.appendChild(field);
        fireEvent.keyDown(field, { key: 'd', ctrlKey: true });
        expect(asked).toEqual([]);
        field.remove();
    });
});

/**
 * The rule check, shown ON the drawing.
 *
 * ERC has been in the kernel since long before there was a canvas, and nothing in this app had ever shown
 * it: a design with no ground, a floating node, two parts sharing a designator — every one reported, every
 * one invisible. It is the check that says whether a drawing is a CIRCUIT, and the product's whole claim is
 * about designs that are verified.
 */
describe('what the rule check found is marked where it is', () => {
    const problems = [
        { code: 'ERC037', severity: 'error', message: 'R1 and R2 share a designator.', relatedIds: ['r1', 'r2'] },
        { code: 'ERC036', severity: 'warning', message: 'MID is not an E-series value.', relatedIds: ['mid'] },
    ];

    it('rings the parts an issue names', () => {
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} problems={problems} />);
        expect(container.querySelector('[data-testid="problem-r1"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="problem-r2"]')).not.toBeNull();
        // …and nothing else. A mark on a part with no issue is worse than no mark at all.
        expect(container.querySelector('[data-testid="problem-v1"]')).toBeNull();
    });

    it('marks the WIRES of a net an issue names', () => {
        // Half the codes name a net rather than a part — a floating node, a shorted source — and a ring
        // round a symbol cannot say that.
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} problems={problems} />);
        const mid = [...container.querySelectorAll('[data-net="MID"]')];
        expect(mid.length).toBeGreaterThan(0);
        expect(mid.every((w) => w.getAttribute('data-problem') === 'warning')).toBe(true);
    });

    it('says how BADLY, and an error outranks a warning on the same object', () => {
        // A part that is both duplicated and out of the E-series should read as the more serious of the two,
        // and a reader should not have to know which mark won.
        const both = [
            { code: 'ERC036', severity: 'warning', message: 'w', relatedIds: ['r1'] },
            { code: 'ERC037', severity: 'error', message: 'e', relatedIds: ['r1'] },
        ];
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} problems={both} />);
        expect(container.querySelector('[data-testid="symbol-r1"]')!.getAttribute('data-problem')).toBe('error');
    });

    it('marks nothing when there is nothing wrong', () => {
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} />);
        expect(container.querySelectorAll('[data-problem]')).toHaveLength(0);
    });

    it('does not change the SYMBOL, only adds a mark about it', () => {
        // Recolouring a flagged resistor's own strokes would make it a different-looking resistor, and a
        // reader has to be able to tell a mark about a part from the part itself.
        const plain = render(<SchematicCanvas circuit={CIRCUIT} />).container.querySelector(
            '[data-testid="symbol-r1"] polyline',
        )!.outerHTML;
        const flagged = render(<SchematicCanvas circuit={CIRCUIT} problems={problems} />).container.querySelector(
            '[data-testid="symbol-r1"] polyline',
        )!.outerHTML;
        expect(flagged).toBe(plain);
    });
});
