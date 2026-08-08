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

import { pathKey, type SelectMode, type TreeNode } from '@circuit-forge/editor-core';

/**
 * Apply a gesture to a selection, giving back the new one.
 *
 * ORDERED, and the LAST one is the primary: it is what the Inspector shows, because a panel of fields has to
 * be about one object, and the one you most recently pointed at is the one you meant.
 */
export function applySelection(
    was: readonly TreeNode[],
    what: TreeNode | readonly TreeNode[] | null,
    mode: SelectMode = 'replace',
): TreeNode[] {
    // NULL CLEARS, an EMPTY LIST does not. Clicking empty sheet is how anyone gets out of a selection; a box
    // that caught nothing is a gesture that found nothing, and taking the user's selection away for it would
    // punish them for dragging across a blank patch of sheet.
    if (what === null) return [];
    const nodes = Array.isArray(what) ? what : [what as TreeNode];
    if (nodes.length === 0) return [...was];

    if (mode === 'replace') return dedupe(nodes);

    // ONE PASS FOR THE WHOLE GESTURE. A box used to report what it caught one part at a time, and every
    // report filtered the entire selection again — quadratic in what was caught, and it is the only cost in
    // this gesture that is not free: measured at 20ms for 1600 parts against 0.16ms done once. The box test
    // itself is 0.05ms at that size, which is why there is no spatial index here and should not be one.
    if (mode === 'toggle') {
        const out = [...was];
        for (const node of nodes) {
            const path = pathKey(node.ref.path);
            const at = out.findIndex((n) => pathKey(n.ref.path) === path);
            // The same key adds and removes, which is what every editor does and what a user tries first
            // when they overshoot.
            if (at >= 0) out.splice(at, 1);
            else out.push(node);
        }
        return out;
    }

    // A box GATHERS. Re-catching something already held is not a request to drop it: sent as a toggle, a
    // marquee removed every part it caught that was already selected, so dragging across your own selection
    // emptied it. Re-appended rather than left in place, so the last thing caught is the primary.
    const caught = new Set(nodes.map((n) => pathKey(n.ref.path)));
    return dedupe([...was.filter((n) => !caught.has(pathKey(n.ref.path))), ...nodes]);
}

/** Last one wins, so the primary is what the gesture finished on. */
const dedupe = (nodes: readonly TreeNode[]): TreeNode[] => {
    const byPath = new Map<string, TreeNode>();
    for (const node of nodes) byPath.set(pathKey(node.ref.path), node);
    return [...byPath.values()];
};
