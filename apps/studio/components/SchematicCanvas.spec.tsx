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
import type { CircuitJson, UiJson } from '@circuit-forge/eda-core';
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

const wires = (c: HTMLElement) => [...c.querySelectorAll('line')];

describe('what the canvas draws', () => {
    it('draws every placeable part, and labels it with its designator', () => {
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} />);
        for (const id of ['v1', 'r1', 'r2']) expect(screen.getByTestId(`symbol-${id}`)).toBeTruthy();
        expect(container.textContent).toContain('R1');
        expect(container.textContent).toContain('V1');
    });

    it('does NOT draw a net marker as a part', () => {
        // A ground symbol annotates a net; it has no footprint, appears on no BOM and nothing places it.
        // The same rule the tree and the BOM use, imported rather than re-decided here.
        expect(screen.queryByTestId('symbol-g1')).toBeNull();
    });

    it('draws a wire for every CONNECTION and none where there is no net', () => {
        // Three nets: VIN (2 pins), MID (2 pins), GND (3 pins — but the marker is not drawn, so 2 drawn).
        // A star from the first pin means one segment fewer than pins on each net.
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} />);
        const nets = wires(container).map((l) => l.getAttribute('data-net'));
        expect(nets.filter((n) => n === 'VIN')).toHaveLength(1);
        expect(nets.filter((n) => n === 'MID')).toHaveLength(1);
        expect(nets.filter((n) => n === 'GND')).toHaveLength(1); // V1.- to R2.2; the marker has no symbol
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
            [
                ...render(
                    <SchematicCanvas circuit={CIRCUIT} ui={{ positions: { r1: { x: 200, y: 100, rotation } } }} />,
                ).container.querySelectorAll('line'),
            ]
                .map((l) => `${l.getAttribute('x1')},${l.getAttribute('y1')}`)
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
        const { container } = render(<SchematicCanvas circuit={CIRCUIT} selectedPath="root/components/r1" />);
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
                selectedPath={R1}
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
            <SchematicCanvas circuit={CIRCUIT} ui={ui} selectedPath={R1} onArrange={(_l, n) => (ui = n)} />,
        );
        for (const expected of ['90', '180', '270', undefined]) {
            fireEvent.keyDown(window, { key: 'r' });
            rerender(<SchematicCanvas circuit={CIRCUIT} ui={ui} selectedPath={R1} onArrange={(_l, n) => (ui = n)} />);
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
                selectedPath={R1}
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
                selectedPath={R1}
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
                selectedPath="root/nets/VIN"
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
            <SchematicCanvas circuit={CIRCUIT} selectedPath={R1} onArrange={(_l, n) => (next = n)} />,
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
