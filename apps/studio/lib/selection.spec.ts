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

describe('a gesture that names many objects at once', () => {
    const r1 = node('r1');
    const r2 = node('r2');
    const r3 = node('r3');

    it('gathers the whole catch in one report', () => {
        expect(ids(applySelection([r1], [r2, r3], 'add')).sort()).toEqual(['r1', 'r2', 'r3']);
    });

    it('keeps what it re-catches, exactly as it does one at a time', () => {
        // The property is the same whether a box reports its catch piecemeal or whole. It has to be: the two
        // were the same call until the piecemeal version turned out to be quadratic in what was caught.
        expect(ids(applySelection([r1, r2], [r1, r3], 'add')).sort()).toEqual(['r1', 'r2', 'r3']);
    });

    it('does NOT clear the selection when a gesture found nothing — in ANY mode', () => {
        // An empty list is a gesture that found nothing; `null` is the click on empty sheet that means
        // "clear". Reading them alike would take a user's selection away for dragging across a blank patch.
        //
        // Every mode, because that is where the rule actually bites: with 'add' and 'toggle' an empty list
        // is already a no-op by construction, so a test of those two alone passed whether the rule was
        // there or not — measured, by deleting it.
        for (const mode of ['replace', 'add', 'toggle'] as const)
            expect({ mode, left: ids(applySelection([r1, r2], [], mode)) }).toEqual({ mode, left: ['r1', 'r2'] });
        expect(applySelection([r1, r2], null, 'add')).toEqual([]);
    });

    it('holds each object once, however many times it was named', () => {
        // A box can catch the same part twice only through a caller's mistake, but a selection holding two
        // of one object shows two rows for one thing and deletes it twice.
        const twice = applySelection([], [r1, r2, r1], 'add');
        expect(ids(twice).sort()).toEqual(['r1', 'r2']);
        expect(twice).toHaveLength(2);
    });

    it('makes the LAST one named the primary', () => {
        const after = applySelection([r3], [r1, r2], 'add');
        expect(after[after.length - 1]!.ref.id).toBe('r2');
    });

    it('replaces with the whole list, not just the first of it', () => {
        expect(ids(applySelection([r3], [r1, r2])).sort()).toEqual(['r1', 'r2']);
    });

    it('toggles each in turn, so a repeat within one report cancels itself', () => {
        expect(ids(applySelection([r1], [r2, r2], 'toggle'))).toEqual(['r1']);
        expect(ids(applySelection([r1], [r1, r2], 'toggle'))).toEqual(['r2']);
    });

    it('costs one pass, not one pass per object', () => {
        // THE MEASUREMENT. Reported one at a time, each report re-filtered the whole selection — quadratic in
        // what the box caught, 20ms for 1600 parts against 0.16ms done once. Asserted as a RATIO against the
        // piecemeal cost rather than as milliseconds, because a wall-clock threshold measures the machine.
        const many = Array.from({ length: 1200 }, (_, i) => node('p' + i));

        const start = process.hrtime.bigint();
        const batched = applySelection([], many, 'add');
        const one = Number(process.hrtime.bigint() - start);

        const startEach = process.hrtime.bigint();
        let piecemeal: TreeNode[] = [];
        for (const n of many) piecemeal = applySelection(piecemeal, n, 'add');
        const each = Number(process.hrtime.bigint() - startEach);

        expect(ids(batched)).toEqual(ids(piecemeal)); // same answer, which is the point
        expect({ faster: one * 8 < each }).toEqual({ faster: true });
    });
});
