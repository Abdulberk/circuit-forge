/**
 * @jest-environment jsdom
 */
/**
 * The panel where a design is actually changed — and, until this file, the layer with no tests at all.
 *
 * That gap is what these tests are really about. The connectivity kernel was written, proven and merged with
 * twenty-one tests behind it, and none of it was reachable: no screen called `movePinToNet`, so a user could
 * not rewire anything. "It compiles and the kernel is green" is exactly the evidence that would have said
 * everything was fine. So every test below goes through the rendered panel and a real click.
 */
import type { CircuitJson } from '@circuit-forge/eda-core';
import { buildObjectTree, type EditResult, type TreeNode } from '@circuit-forge/editor-core';
import { fireEvent, render, screen } from '@testing-library/react';

import type { DocumentState } from '../lib/useDocument';

import { AddPart, Inspector } from './Inspector';

const CIRCUIT: CircuitJson = {
    version: '1.0',
    components: [
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
    ],
    nets: [
        { id: 'vin', name: 'VIN', isPower: true },
        { id: 'mid', name: 'MID' },
        { id: 'gnd', name: 'GND', isGround: true },
    ],
};

/** The tree node for one pin, taken from the REAL projection rather than hand-built. */
function pinNode(componentId: string, pinId: string): TreeNode {
    const tree = buildObjectTree(CIRCUIT);
    const node = [...tree.byPath.values()].find(
        (n) => n.ref.kind === 'pin' && n.ref.componentId === componentId && n.ref.id === pinId,
    );
    if (!node) throw new Error(`no tree node for ${componentId}.${pinId}`);
    return node;
}

/** A document double that records what the panel asked for and applies it for real. */
function fakeDoc() {
    const applied: CircuitJson[] = [];
    const refusals: string[] = [];
    const doc = {
        refusal: null,
        notes: [],
        apply: (edit: (c: CircuitJson) => EditResult) => {
            const r = edit(CIRCUIT);
            if (r.ok) {
                if (r.changed) applied.push(r.circuit);
            } else refusals.push(r.reason);
        },
    } as unknown as DocumentState;
    return { doc, applied, refusals };
}

const netOf = (c: CircuitJson, componentId: string, pinId: string) =>
    c.components.find((x) => x.id === componentId)?.pins.find((p) => p.pinId === pinId)?.netId;

describe('a pin can be rewired from the panel', () => {
    it('shows which net the pin is on', () => {
        const { doc } = fakeDoc();
        render(<Inspector selected={pinNode('r1', '2')} circuit={CIRCUIT} doc={doc} />);
        expect(screen.getByText('R1 · 2')).toBeTruthy();
        expect((screen.getByLabelText('Net') as HTMLSelectElement).value).toBe('mid');
    });

    it('offers every net in the design, labelling the ones with a role', () => {
        const { doc } = fakeDoc();
        render(<Inspector selected={pinNode('r1', '2')} circuit={CIRCUIT} doc={doc} />);
        const options = [...(screen.getByLabelText('Net') as HTMLSelectElement).options].map((o) => o.textContent);
        expect(options).toEqual(['VIN (power)', 'MID', 'GND (ground)']);
    });

    it('MOVES the pin when another net is chosen — and moves only that pin', () => {
        // The distinction the kernel draws between `movePinToNet` and `connectPins`. Choosing from a list
        // says "this pin belongs there"; dragging a wire would say "these become one node" and would bring
        // the pin's existing neighbours along. Offering the wrong one here would silently rewire R2.
        const { doc, applied } = fakeDoc();
        render(<Inspector selected={pinNode('r1', '2')} circuit={CIRCUIT} doc={doc} />);

        fireEvent.change(screen.getByLabelText('Net'), { target: { value: 'gnd' } });

        expect(applied).toHaveLength(1);
        expect(netOf(applied[0]!, 'r1', '2')).toBe('gnd');
        expect(netOf(applied[0]!, 'r2', '1')).toBe('mid'); // its former neighbour did NOT come along
    });

    it('puts the pin on a net of its own when asked', () => {
        const { doc, applied } = fakeDoc();
        render(<Inspector selected={pinNode('r1', '2')} circuit={CIRCUIT} doc={doc} />);

        fireEvent.click(screen.getByText('Move to its own net'));

        expect(applied).toHaveLength(1);
        const moved = netOf(applied[0]!, 'r1', '2');
        expect(moved).not.toBe('mid');
        expect(netOf(applied[0]!, 'r2', '1')).toBe('mid');
    });

    it('names the role of the net a pin sits on', () => {
        const { doc } = fakeDoc();
        render(<Inspector selected={pinNode('r2', '2')} circuit={CIRCUIT} doc={doc} />);
        expect(screen.getByText('ground')).toBeTruthy();
    });

    it('does not offer connectivity for a node that is not a pin', () => {
        const { doc } = fakeDoc();
        const tree = buildObjectTree(CIRCUIT);
        const componentNode = tree.byPath.get('root/components/r1')!;
        render(<Inspector selected={componentNode} circuit={CIRCUIT} doc={doc} />);
        expect(screen.queryByLabelText('Net')).toBeNull();
    });

    it('shows a refusal from the kernel rather than swallowing it', () => {
        const doc = {
            refusal: { reason: 'rail-short', message: 'GND is declared ground and VIN is a power rail.' },
            notes: [],
            apply: () => {},
        } as unknown as DocumentState;
        render(<Inspector selected={pinNode('r1', '2')} circuit={CIRCUIT} doc={doc} />);
        expect(screen.getByRole('alert').textContent).toMatch(/declared ground/);
    });
});

/**
 * Adding and removing a part, through the rendered panel.
 *
 * The kernel work behind this is worth nothing if no screen calls it — the mistake made twice this week and
 * caught once by the founder. So both operations are exercised by a real click on a real control.
 */
describe('a user can add and remove a part', () => {
    it('offers only the types that can be created with a known pin list', () => {
        // A subcircuit's pins are authored to match its own port order, so the kernel refuses a blank one.
        // Offering it would put a control on screen whose only outcome is a refusal.
        const { doc } = fakeDoc();
        render(<AddPart doc={doc} />);
        const options = [...(screen.getByLabelText('Add a part') as HTMLSelectElement).options].map((o) => o.value);
        expect(options).toContain('resistor');
        expect(options).toContain('capacitor');
        expect(options).not.toContain('subckt');
        expect(options).not.toContain('logic_and');
    });

    it('adds the chosen type, numbered after what is already there', () => {
        const { doc, applied } = fakeDoc();
        render(<AddPart doc={doc} />);

        fireEvent.change(screen.getByLabelText('Add a part'), { target: { value: 'capacitor' } });

        expect(applied).toHaveLength(1);
        const added = applied[0]!.components.find((c) => c.id === 'c1');
        expect(added?.designator).toBe('C1');
        // Born disconnected: each pin on a net of its own, touching nothing that was there.
        expect(new Set(added!.pins.map((p) => p.netId)).size).toBe(2);
        for (const p of added!.pins) expect(['vin', 'mid', 'gnd']).not.toContain(p.netId);
    });

    it('deletes the selected part from its own panel', () => {
        const { doc, applied } = fakeDoc();
        const tree = buildObjectTree(CIRCUIT);
        render(<Inspector selected={tree.byPath.get('root/components/r1')!} circuit={CIRCUIT} doc={doc} />);

        fireEvent.click(screen.getByText('Delete R1'));

        expect(applied).toHaveLength(1);
        expect(applied[0]!.components.map((c) => c.id)).toEqual(['r2']);
    });

    it('offers no delete control for a node that is not a component', () => {
        const { doc } = fakeDoc();
        const tree = buildObjectTree(CIRCUIT);
        const netNode = [...tree.byPath.values()].find((n) => n.ref.kind === 'net')!;
        render(<Inspector selected={netNode} circuit={CIRCUIT} doc={doc} />);
        expect(screen.queryByText(/^Delete /)).toBeNull();
    });
});
