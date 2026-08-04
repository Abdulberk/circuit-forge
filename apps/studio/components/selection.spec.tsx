/**
 * @jest-environment jsdom
 */
/**
 * ONE selection, two views of it.
 *
 * The tree and the canvas are two renderings of the same document, and until now each kept its own idea of
 * what was selected: clicking a symbol told the Inspector and left the tree painting some other row;
 * clicking a row told the Inspector and left the canvas highlighting nothing. Neither was wrong by its own
 * lights, which is what makes this class of defect hard to notice — every panel looks correct alone.
 *
 * So the property is not "selection works". It is that the two AGREE, and it can only be observed by
 * rendering them together.
 */
import type { CircuitJson } from '@circuit-forge/eda-core';
import type { TreeNode } from '@circuit-forge/editor-core';
import { render, fireEvent } from '@testing-library/react';
import { useState } from 'react';

import { ObjectTreePanel } from './ObjectTreePanel';
import { SchematicCanvas } from './SchematicCanvas';

const CIRCUIT: CircuitJson = {
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
            value: '2k',
            pins: [
                { pinId: '1', netId: 'b' },
                { pinId: '2', netId: 'a' },
            ],
        },
    ],
    nets: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
    ],
};

/** The two panels wired the way the workspace wires them: one selection, held above both. */
function Workspace() {
    const [selected, setSelected] = useState<TreeNode | null>(null);
    const path = selected?.ref.path.join('/') ?? null;
    return (
        <div>
            <ObjectTreePanel circuit={CIRCUIT} selectedPath={path} onSelect={setSelected} />
            <SchematicCanvas circuit={CIRCUIT} selectedPath={path} onSelect={setSelected} />
        </div>
    );
}

const treeRowFor = (c: HTMLElement, label: string) =>
    [...c.querySelectorAll('.tree-row')].find((r) => r.textContent?.includes(label))!;

describe('the tree and the canvas agree about what is selected', () => {
    it('clicking a SYMBOL highlights its tree row', () => {
        const { container } = render(<Workspace />);
        fireEvent.click(container.querySelector('[data-testid="symbol-r2"]')!);
        expect(treeRowFor(container, 'R2').getAttribute('aria-selected')).toBe('true');
        expect(treeRowFor(container, 'R1').getAttribute('aria-selected')).toBe('false');
    });

    it('clicking a tree ROW highlights its symbol', () => {
        const { container } = render(<Workspace />);
        fireEvent.click(treeRowFor(container, 'R2'));
        // The canvas paints a selected symbol with the accent stroke; the others keep the ordinary one.
        const strokeOf = (id: string) =>
            container
                .querySelector(`[data-testid="symbol-${id}"] polygon, [data-testid="symbol-${id}"] polyline`)!
                .getAttribute('stroke');
        expect(strokeOf('r2')).not.toBe(strokeOf('r1'));
    });

    it('selecting one thing DESELECTS the other, in both views at once', () => {
        // Two independent selections would each keep their own, and the screen would show two things
        // selected — which is the visible form of the defect this replaces.
        const { container } = render(<Workspace />);
        fireEvent.click(container.querySelector('[data-testid="symbol-r1"]')!);
        fireEvent.click(treeRowFor(container, 'R2'));
        expect(treeRowFor(container, 'R1').getAttribute('aria-selected')).toBe('false');
        expect(treeRowFor(container, 'R2').getAttribute('aria-selected')).toBe('true');
    });
});
