/**
 * @jest-environment jsdom
 */
/**
 * The tree, driven by a keyboard — which is the one thing a tree is for.
 *
 * It exists to find a part in a long list, and a long list is exactly where a mouse is worst. The canvas's
 * own help text has been telling screen readers that "arrow keys and Tab move between objects in the tree"
 * since it was written, and until now Up and Down did nothing at all: a promise with no behaviour behind it,
 * which is worse than silence because it sends somebody looking for a way through that is not there.
 *
 * The other half is measured rather than felt: every row was a tab stop, which on a four-hundred-part design
 * is two thousand presses of Tab to reach whatever comes after the panel.
 */

import type { CircuitJson } from '@circuit-forge/eda-core';
import type { TreeNode } from '@circuit-forge/editor-core';
import { render, fireEvent } from '@testing-library/react';

import { ObjectTreePanel } from './ObjectTreePanel';

const R = (id: string, a: string, b: string) => ({
    id,
    type: 'resistor',
    designator: id.toUpperCase(),
    value: '1k',
    pins: [
        { pinId: '1', netId: a },
        { pinId: '2', netId: b },
    ],
});

const CIRCUIT: CircuitJson = {
    version: '1.0',
    components: [R('r1', 'in', 'mid'), R('r2', 'mid', 'out'), R('r3', 'out', 'gnd')] as never,
    nets: [
        { id: 'in', name: 'IN' },
        { id: 'mid', name: 'MID' },
        { id: 'out', name: 'OUT' },
        { id: 'gnd', name: 'GND', isGround: true },
    ],
};

const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
const tabbable = (container: HTMLElement) => rows(container).filter((r) => r.getAttribute('tabindex') === '0');
const pathOf = (row: HTMLElement) => row.getAttribute('data-path');

describe('driving the tree from a keyboard', () => {
    beforeEach(() => {
        // The caret takes focus on the next frame, so the row it moved to is the one already rendered as
        // tabbable. Run it immediately here rather than leaving the assertions to race it.
        jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
            cb(0);
            return 0;
        });
    });
    afterEach(() => jest.restoreAllMocks());

    describe('the tab order', () => {
        it('is ONE stop for the whole tree, not one per row', () => {
            // THE DEFECT, measured: 2005 rows on a four-hundred-part design, every one of them a tab stop.
            // A keyboard user could not get past the panel.
            const { container } = render(<ObjectTreePanel circuit={CIRCUIT} />);
            expect(rows(container).length).toBeGreaterThan(5);
            expect(tabbable(container)).toHaveLength(1);
        });

        it('starts on the first row, so Tab lands somewhere rather than nowhere', () => {
            const { container } = render(<ObjectTreePanel circuit={CIRCUIT} />);
            expect(pathOf(tabbable(container)[0]!)).toBe(pathOf(rows(container)[0]!));
        });

        it('moves the one stop to wherever the caret went', () => {
            const { container } = render(<ObjectTreePanel circuit={CIRCUIT} />);
            fireEvent.keyDown(rows(container)[0]!, { key: 'ArrowDown' });
            expect(tabbable(container)).toHaveLength(1);
            expect(pathOf(tabbable(container)[0]!)).toBe(pathOf(rows(container)[1]!));
        });
    });

    describe('moving', () => {
        it('goes DOWN and UP, which did nothing at all before', () => {
            const { container } = render(<ObjectTreePanel circuit={CIRCUIT} />);
            const all = rows(container);
            fireEvent.keyDown(all[0]!, { key: 'ArrowDown' });
            expect(pathOf(tabbable(container)[0]!)).toBe(pathOf(all[1]!));
            fireEvent.keyDown(all[1]!, { key: 'ArrowUp' });
            expect(pathOf(tabbable(container)[0]!)).toBe(pathOf(all[0]!));
        });

        it('stops at the ends instead of wrapping', () => {
            // Wrapping in a tree loses the user: a list that jumps from the bottom to the top reads as the
            // caret having disappeared.
            const { container } = render(<ObjectTreePanel circuit={CIRCUIT} />);
            const all = rows(container);
            fireEvent.keyDown(all[0]!, { key: 'ArrowUp' });
            expect(pathOf(tabbable(container)[0]!)).toBe(pathOf(all[0]!));
        });

        it('jumps to the first and last visible rows with Home and End', () => {
            const { container } = render(<ObjectTreePanel circuit={CIRCUIT} />);
            const all = rows(container);
            fireEvent.keyDown(all[0]!, { key: 'End' });
            expect(pathOf(tabbable(container)[0]!)).toBe(pathOf(all[all.length - 1]!));
            fireEvent.keyDown(all[all.length - 1]!, { key: 'Home' });
            expect(pathOf(tabbable(container)[0]!)).toBe(pathOf(all[0]!));
        });

        it('takes the FOCUS with it, not just the tab stop', () => {
            // A caret that moves without focus is invisible: the ring stays on the row the user left, and a
            // screen reader goes on announcing it.
            const { container } = render(<ObjectTreePanel circuit={CIRCUIT} />);
            fireEvent.keyDown(rows(container)[0]!, { key: 'ArrowDown' });
            expect(document.activeElement).toBe(rows(container)[1]!);
        });

        it('does not walk into rows that are FOLDED AWAY', () => {
            // Movement is down the SCREEN, not down the data. A caret inside a closed group is somewhere the
            // user cannot see it.
            const { container } = render(<ObjectTreePanel circuit={CIRCUIT} />);
            const root = rows(container)[0]!;
            const openCount = rows(container).length;
            fireEvent.keyDown(root, { key: 'ArrowLeft' }); // fold the root
            const foldedCount = rows(container).length;
            expect(foldedCount).toBeLessThan(openCount);
            fireEvent.keyDown(rows(container)[0]!, { key: 'ArrowDown' });
            // Whatever it moved to, it is a row that is actually on screen.
            expect(rows(container).map(pathOf)).toContain(pathOf(tabbable(container)[0]!));
        });
    });

    describe('folding', () => {
        it('opens with Right and closes with Left', () => {
            const { container } = render(<ObjectTreePanel circuit={CIRCUIT} />);
            const root = rows(container)[0]!;
            const open = rows(container).length;
            fireEvent.keyDown(root, { key: 'ArrowLeft' });
            expect(rows(container).length).toBeLessThan(open);
            fireEvent.keyDown(rows(container)[0]!, { key: 'ArrowRight' });
            expect(rows(container).length).toBe(open);
        });

        it('uses Right and Left to MOVE where there is nothing to fold', () => {
            // On a leaf the two keys read as "further in" and "further out". Doing nothing at all is the
            // answer that makes a user press the key twice and then reach for the mouse.
            const { container } = render(<ObjectTreePanel circuit={CIRCUIT} />);
            const all = rows(container);
            const leaf = all.find((r) => r.getAttribute('aria-expanded') === null)!;
            const at = all.indexOf(leaf);
            fireEvent.keyDown(leaf, { key: 'ArrowRight' });
            expect(pathOf(tabbable(container)[0]!)).toBe(pathOf(all[at + 1] ?? leaf));
        });
    });

    describe('what moving must NOT do', () => {
        it('does not change the selection', () => {
            // Walking a list to look at it is not an edit. Selecting as the caret moved would mark the
            // document unsaved and mint an undo step for a glance.
            const seen: unknown[] = [];
            const { container } = render(<ObjectTreePanel circuit={CIRCUIT} onSelect={(w) => seen.push(w)} />);
            for (const k of ['ArrowDown', 'ArrowDown', 'End', 'Home', 'ArrowUp']) {
                fireEvent.keyDown(tabbable(container)[0]!, { key: k });
            }
            expect(seen).toEqual([]);
        });

        it('selects only when asked, with Enter or Space', () => {
            const seen: Array<string | undefined> = [];
            const { container } = render(
                <ObjectTreePanel circuit={CIRCUIT} onSelect={(w) => seen.push((w as TreeNode | null)?.ref.id)} />,
            );
            fireEvent.keyDown(rows(container)[0]!, { key: 'ArrowDown' });
            fireEvent.keyDown(tabbable(container)[0]!, { key: 'Enter' });
            expect(seen).toHaveLength(1);
        });
    });
});

describe('rows whose ids are awkward', () => {
    beforeEach(() => {
        jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
            cb(0);
            return 0;
        });
    });
    afterEach(() => jest.restoreAllMocks());

    it('selects a row whose id contains a SEPARATOR, instead of clearing everything', () => {
        // THE DEFECT, and a regression this session put in. `pathKey` escapes '%' and '/' inside a segment so
        // an id carrying a separator stays addressable; the panel then split that ESCAPED string on '/' and
        // handed the pieces to `nodeAt`, which escaped them a second time. The lookup missed, the miss became
        // null, and the one selection rule reads null as CLEAR — so clicking such a row failed to select it
        // AND destroyed whatever the user already had.
        const odd: CircuitJson = {
            version: '1.0',
            components: [R('sheetA/r1', 'a', 'b'), R('plain', 'b', 'c')] as never,
            nets: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as never,
        };
        const seen: Array<string | null> = [];
        const { container } = render(
            <ObjectTreePanel circuit={odd} onSelect={(w) => seen.push(w === null ? null : (w as TreeNode).ref.id)} />,
        );
        const row = rows(container).find((r) => pathOf(r)?.includes('sheetA'))!;
        expect(row).toBeDefined();
        fireEvent.click(row);
        expect(seen).toEqual(['sheetA/r1']);
    });

    it('gives every ROW its own identity when two objects share an id', () => {
        // The kernel supports duplicate ids on purpose — machine-generated, imported, merged from two
        // sub-sheets — and reports them as ambiguous rather than dropping one. Two rows then carry the same
        // ADDRESS, and keying by address handed React the same key twice (which this repo's jest setup
        // treats as a defect) and trapped the caret: pressing Down on the second row jumped BACKWARDS into
        // the first one's subtree, and everything below it was unreachable from a keyboard.
        const twins: CircuitJson = {
            version: '1.0',
            components: [
                { ...R('r1', 'a', 'b'), designator: 'R1' },
                { ...R('r1', 'b', 'c'), designator: 'R7' },
            ] as never,
            nets: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as never,
        };
        const { container } = render(<ObjectTreePanel circuit={twins} />);
        const seats = rows(container).map((r) => r.getAttribute('data-seat'));
        expect(new Set(seats).size).toBe(seats.length);
    });

    it('moves FORWARD from the second of two rows sharing an id', () => {
        const twins: CircuitJson = {
            version: '1.0',
            components: [
                { ...R('r1', 'a', 'b'), designator: 'R1' },
                { ...R('r1', 'b', 'c'), designator: 'R7' },
            ] as never,
            nets: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as never,
        };
        const { container } = render(<ObjectTreePanel circuit={twins} />);
        const all = rows(container);
        // The last row that addresses the duplicated id — the one the caret used to jump backwards from.
        const second = all.filter((r) => pathOf(r)?.endsWith('/r1')).at(-1)!;
        const at = all.indexOf(second);
        fireEvent.keyDown(second, { key: 'ArrowDown' });
        const now = rows(container).findIndex((r) => r.getAttribute('tabindex') === '0');
        expect({ movedForward: now > at }).toEqual({ movedForward: true });
    });
});
