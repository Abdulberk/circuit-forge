/**
 * @jest-environment jsdom
 */
/**
 * Drawn wires, on screen: the KiCad gestures the design review's acceptance table names.
 *
 * The canvas reports a draft — corners and the terminal under each end — and nothing more; what it means is
 * `planWire`'s, tested in the kernel. These tests are about the hand.
 */
import type { CircuitJson, UiJson } from '@circuit-forge/eda-core';
import type { WireDraft } from '@circuit-forge/editor-core';
import { fireEvent, render } from '@testing-library/react';

import { SchematicCanvas } from './SchematicCanvas';

/** R2's pin 1 sits on its own net, so there is something to wire. */
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
                { pinId: '1', netId: 'n9' },
                { pinId: '2', netId: 'gnd' },
            ],
        },
    ],
    nets: [
        { id: 'vin', name: 'VIN' },
        { id: 'mid', name: 'MID' },
        { id: 'n9', name: 'N9' },
        { id: 'gnd', name: 'GND', isGround: true },
    ],
};
const UI: UiJson = {
    schemaVersion: 1,
    positions: { v1: { x: 0, y: 0 }, r1: { x: 100, y: 0 }, r2: { x: 100, y: 100 } },
    wires: [],
};
// A resistor is horizontal with pins at ±20 of its centre.
const R1_2 = { x: 120, y: 0 };
const R2_1 = { x: 80, y: 100 };

const wires = (c: HTMLElement) => [...c.querySelectorAll('[data-net]')];

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
/** The mapping the browser performs, inverted: a point on the sheet as a point on the screen. */
const clientAt = (svg: SVGSVGElement, x: number, y: number): { clientX: number; clientY: number } => {
    const [bx, by, bw, bh] = svg.getAttribute('viewBox')!.split(' ').map(Number) as [number, number, number, number];
    const perUnit = Math.min(800 / bw, 600 / bh);
    return {
        clientX: (800 - bw * perUnit) / 2 + (x - bx) * perUnit,
        clientY: (600 - bh * perUnit) / 2 + (y - by) * perUnit,
    };
};

function setup(ui: UiJson = UI) {
    const drafts: WireDraft[] = [];
    const deleted: string[][] = [];
    const view = render(
        <SchematicCanvas
            circuit={CIRCUIT}
            ui={ui}
            onSelect={() => {}}
            onDrawWire={(d) => drafts.push(d)}
            onDeleteWires={(k) => deleted.push([...k])}
        />,
    );
    const svg = sized(view.container);
    const press = (x: number, y: number): void => {
        fireEvent.pointerDown(svg, { pointerId: 70, button: 0, ...clientAt(svg, x, y) });
    };
    return { ...view, svg, drafts, deleted, press };
}

describe('the wire tool draws wires the way KiCad does', () => {
    it('W arms the tool, every click puts down a corner, and a terminal finishes the wire', () => {
        const { svg, drafts, press, container } = setup();
        fireEvent.keyDown(window, { key: 'w' });
        expect(svg.getAttribute('data-tool')).toBe('wire');
        press(R1_2.x, R1_2.y); // start on R1.2
        press(150, 0); // a corner out to the right
        fireEvent.pointerMove(svg, { pointerId: 70, ...clientAt(svg, R2_1.x, R2_1.y) });
        expect(container.querySelector('[data-testid="route-in-flight"]')).not.toBeNull();
        press(R2_1.x, R2_1.y); // ends on R2.1
        expect(drafts).toHaveLength(1);
        expect(drafts[0]!.from).toEqual({ componentId: 'r1', pinId: '2' });
        expect(drafts[0]!.to).toEqual({ componentId: 'r2', pinId: '1' });
        const pts = drafts[0]!.points;
        expect(pts[0]).toEqual(R1_2);
        expect(pts[pts.length - 1]).toEqual(R2_1);
        for (let i = 1; i < pts.length; i++)
            expect(pts[i]!.x === pts[i - 1]!.x || pts[i]!.y === pts[i - 1]!.y).toBe(true);
        expect(pts).toContainEqual({ x: 150, y: 0 });
    });

    it('Backspace takes back the last corner and Esc cancels the wire without committing anything', () => {
        const { drafts, press, container } = setup();
        fireEvent.keyDown(window, { key: 'w' });
        press(R1_2.x, R1_2.y);
        press(150, 0);
        fireEvent.keyDown(window, { key: 'Backspace' });
        expect(container.querySelector('[data-testid="route-in-flight"]')).not.toBeNull();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(container.querySelector('[data-testid="route-in-flight"]')).toBeNull();
        expect(drafts).toEqual([]);
    });

    it('/ flips which way the corner bends', () => {
        const { svg, press, container } = setup();
        fireEvent.keyDown(window, { key: 'w' });
        press(R1_2.x, R1_2.y);
        fireEvent.pointerMove(svg, { pointerId: 70, ...clientAt(svg, 200, 60) });
        const before = container.querySelector('[data-testid="route-in-flight"]')!.getAttribute('points');
        fireEvent.keyDown(window, { key: '/' });
        const after = container.querySelector('[data-testid="route-in-flight"]')!.getAttribute('points');
        expect({ before, after }).toEqual({ before: '120,0 200,0 200,60', after: '120,0 120,60 200,60' });
    });

    it('clicking a free terminal starts a wire with no tool armed, as in KiCad', () => {
        // The pin grab targets exist only when the canvas can connect, as before.
        const drafts: WireDraft[] = [];
        const { container } = render(
            <SchematicCanvas
                circuit={CIRCUIT}
                ui={UI}
                onSelect={() => {}}
                onConnect={() => {}}
                onDrawWire={(d) => drafts.push(d)}
            />,
        );
        const svg = sized(container);
        for (const [id, at] of [
            ['pin-r1-2', R1_2],
            ['pin-r2-1', R2_1],
        ] as const)
            fireEvent.pointerDown(container.querySelector(`[data-testid="${id}"]`)!, {
                pointerId: 71,
                button: 0,
                ...clientAt(svg, at.x, at.y),
            });
        expect(drafts.map((d) => [d.from?.componentId, d.to?.componentId])).toEqual([['r1', 'r2']]);
    });

    it('draws stored wires exactly where they are stored — nothing is re-routed', () => {
        const stored = [
            { x: 20, y: -20 },
            { x: 50, y: -20 },
            { x: 50, y: 0 },
            { x: 80, y: 0 },
        ];
        const { container } = setup({
            ...UI,
            wires: [{ id: 'w1', netId: 'vin', points: stored, from: null, to: null }],
        });
        expect(wires(container).map((w) => w.getAttribute('points'))).toEqual(['20,-20 50,-20 50,0 80,0']);
    });

    it('a stored wire can be clicked, shows as selected, and Delete removes it', () => {
        const ui: UiJson = {
            ...UI,
            wires: [
                {
                    id: 'w1',
                    netId: 'vin',
                    points: [
                        { x: 20, y: 0 },
                        { x: 80, y: 0 },
                    ],
                    from: null,
                    to: null,
                },
            ],
        };
        const { container, deleted } = setup(ui);
        fireEvent.click(container.querySelector('[data-testid="wire-hit-w1"]')!);
        expect(container.querySelector('[data-selected="yes"]')).not.toBeNull();
        fireEvent.keyDown(window, { key: 'Delete' });
        expect(deleted).toEqual([['w1']]);
    });

    it('shows an undrawn connection as a dashed line, prints values, and draws the grid', () => {
        // VIN joins V1+ and R1.1 in the netlist and no wire is stored: a dashed line, and no wire.
        const { container } = setup();
        expect(container.querySelectorAll('[data-testid="airwire"]').length).toBeGreaterThan(0);
        expect(wires(container)).toHaveLength(0);
        expect(container.querySelector('[data-testid="value-r1"]')?.textContent).toBe('1k');
        expect(container.querySelector('[data-testid="grid"]')).not.toBeNull();
    });

    it('a design with no drawing is frozen for display, so it can be wired from the first frame', () => {
        const { container } = setup({});
        // Frozen means stored wires, not a routed picture: each one has a hit target the tool can use.
        expect(container.querySelectorAll('[data-testid^="wire-hit-"]').length).toBeGreaterThan(0);
        expect(container.querySelectorAll('[data-testid="airwire"]')).toHaveLength(0);
    });
});
