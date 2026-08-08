/**
 * What a selection gesture DOES — the one rule, in one place, so no surface has to have an opinion.
 *
 * The tree and the canvas are two renderings of the same document. Each one deciding for itself what a click
 * means is the defect this codebase already paid for: clicking a symbol told the Inspector and left the tree
 * painting some other row. So the surfaces report what the user MEANT and this decides what happens.
 *
 * It lives here, apart from the workspace that calls it, because a rule buried in a component can only be
 * tested by driving the whole page — and the thing that actually went wrong (a box selection quietly removing
 * what it caught) is invisible at that distance.
 */

import type { SelectMode, TreeNode } from '@circuit-forge/editor-core';

/**
 * Apply a gesture to a selection, giving back the new one.
 *
 * ORDERED, and the LAST one is the primary: it is what the Inspector shows, because a panel of fields has to
 * be about one object, and the one you most recently pointed at is the one you meant.
 */
export function applySelection(
    was: readonly TreeNode[],
    node: TreeNode | null,
    mode: SelectMode = 'replace',
): TreeNode[] {
    // Nothing selected clears it. Clicking empty sheet is how anyone gets out of a selection.
    if (!node) return [];
    if (mode === 'replace') return [node];

    const path = node.ref.path.join('/');
    const without = was.filter((n) => n.ref.path.join('/') !== path);
    const had = without.length !== was.length;

    // Shift-clicking something already selected takes it OUT — the same key adds and removes, which is what
    // every editor does and what a user tries first when they overshoot.
    if (mode === 'toggle') return had ? without : [...was, node];

    // A box GATHERS. Re-catching something already held is not a request to drop it: sent as a toggle, a
    // marquee removed every part it caught that was already selected, so dragging across your own selection
    // emptied it. Re-appended rather than left in place, so the last thing caught is the primary.
    return [...without, node];
}
