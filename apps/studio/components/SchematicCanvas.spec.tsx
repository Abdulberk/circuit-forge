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
import type { CircuitJson } from '@circuit-forge/eda-core';
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

    it('places the same document the same way every time', () => {
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
