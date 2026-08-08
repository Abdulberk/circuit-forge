/**
 * The one rule, on its own — because the thing that actually went wrong is invisible from further away.
 *
 * A box selection sent "additive" once per part it caught; the rule read that as "toggle"; so dragging a box
 * across parts that were already selected took them OUT. Every panel looked right, the canvas reported the
 * right parts, and the selection emptied anyway. The defect lived entirely in what one word was taken to
 * mean, which is exactly the kind of thing a whole-page test walks past.
 */

import type { TreeNode } from '@circuit-forge/editor-core';

import { applySelection } from './selection';

const node = (id: string): TreeNode =>
    ({
        label: id.toUpperCase(),
        ref: { kind: 'component', id, path: ['root', 'components', id] },
        children: [],
    }) as unknown as TreeNode;

const ids = (nodes: readonly TreeNode[]) => nodes.map((n) => n.ref.id);

describe('what a selection gesture does', () => {
    const r1 = node('r1');
    const r2 = node('r2');
    const r3 = node('r3');

    it('replaces on a plain click, however much was selected', () => {
        expect(ids(applySelection([r1, r2], r3))).toEqual(['r3']);
    });

    it('clears when nothing was pointed at', () => {
        // Clicking empty sheet is how anyone gets out of a selection.
        expect(applySelection([r1, r2], null, 'toggle')).toEqual([]);
    });

    describe('toggle — the Shift-click', () => {
        it('adds what was not selected', () => {
            expect(ids(applySelection([r1], r2, 'toggle'))).toEqual(['r1', 'r2']);
        });

        it('REMOVES what was, so overshooting is undoable with the same key', () => {
            expect(ids(applySelection([r1, r2], r2, 'toggle'))).toEqual(['r1']);
        });
    });

    describe('add — the box selection', () => {
        it('keeps what it catches that was already held', () => {
            // THE DEFECT. As a toggle this returned ['r2'] — the box dropped the part it had just caught,
            // and a user dragging a box over their own selection watched it empty.
            expect(ids(applySelection([r1, r2], r1, 'add')).sort()).toEqual(['r1', 'r2']);
        });

        it('never shrinks the selection, whatever it catches', () => {
            // The property behind the case above, stated so a future rule cannot regress past it: gathering
            // is monotonic. Every subset of a sheet, caught in any order, only ever grows what is held.
            const all = [r1, r2, r3];
            for (const start of [[], [r1], [r2, r3], all]) {
                for (const caught of all) {
                    const after = applySelection(start, caught, 'add');
                    expect(after.length).toBeGreaterThanOrEqual(start.length);
                    for (const was of start) expect(ids(after)).toContain(was.ref.id);
                    expect(ids(after)).toContain(caught.ref.id);
                }
            }
        });

        it('makes the LAST one caught the primary, which is what the Inspector shows', () => {
            // A panel of fields has to be about one object. Leaving a re-caught part where it was would make
            // the Inspector show something the box finished somewhere else entirely.
            const after = applySelection([r1, r2], r1, 'add');
            expect(after[after.length - 1]!.ref.id).toBe('r1');
        });
    });

    it('does not mutate the selection it was given', () => {
        // It is React state. Editing it in place would leave the panels painting a selection the renderer
        // never heard about — the same class of defect as two surfaces disagreeing, with no second surface.
        const was = [r1, r2];
        const copy = [...was];
        applySelection(was, r3, 'add');
        applySelection(was, r1, 'toggle');
        expect(was).toEqual(copy);
    });
});
