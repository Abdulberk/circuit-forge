/**
 * The addressable object tree: Root › Layout › Components › C3 › Footprint / Pads › P1.
 *
 * WHY A TREE AT ALL. An inspector, a selection model and a rules cascade all need the same thing — a
 * stable way to NAME any part of a design, from the whole board down to one pad. Flux exposes exactly this
 * and it is the backbone of its properties panel, not decoration: every row you can select is a row you can
 * inspect, and every rule attaches to one.
 *
 * WHAT MAKES IT HONEST HERE. The tree is a PROJECTION, never a second copy of the design. Nothing below is
 * stored; it is derived on demand from the two documents we already have, and the ids it hands out are the
 * ids those documents already carry. A node whose underlying object cannot be found is not invented — the
 * join is reported as incomplete instead, because a tree that quietly omits a pad reads exactly like a
 * board that does not have one.
 *
 * THE JOIN. A component in `CircuitJson` and a component in `LayoutGeometry` meet at `id`; a pad meets its
 * authored pin at `LayoutPad.sourcePin`, which pcb-core now delivers. Neither join is re-derived here — a
 * consumer reconstructing pcb-core's internal pin-name tables from the outside works for the few component
 * types someone checked and mis-attributes for every other part in a catalog of any size.
 *
 * PURE. No DOM, no Node, no framework. Types in, plain data out.
 */
import type { CircuitJson, Component } from '@circuit-forge/eda-core';
import type { LayoutGeometry, LayoutPad } from '@circuit-forge/pcb-contract';

/** What kind of thing a node addresses. Closed on purpose: a new kind is a compile error at every switch. */
export type ObjectKind = 'root' | 'layout' | 'components' | 'component' | 'footprint' | 'pads' | 'pad' | 'nets' | 'net';

/**
 * A stable address for one object.
 *
 * `path` is the chain of ids from the root, so a node survives a re-render, a re-layout and a reload — it is
 * addressed by identity, never by position in an array. That is also the one property a later
 * collaboration layer would need, and it costs nothing to keep now.
 */
export interface ObjectRef {
    kind: ObjectKind;
    /** Stable id within its kind: a componentId, a padId, a net name, or the kind itself for singletons. */
    id: string;
    path: string[];
}

export interface TreeNode {
    ref: ObjectRef;
    /** What a row shows. Never invented — a component's designator, a pad's pin, a net's name. */
    label: string;
    /** Secondary text: the part's type, the pad's net, the group's count. */
    detail?: string;
    children: TreeNode[];
}

export interface ObjectTree {
    root: TreeNode;
    /** Every node by `path.join('/')`, so a selection can be resolved in one lookup rather than a walk. */
    byPath: Map<string, TreeNode>;
    /**
     * What the projection could NOT place, with the reason. Never silently dropped: a pad missing from the
     * tree and a pad missing from the board look identical to a reader, and only one of them is true.
     */
    unplaced: Array<{ what: string; reason: 'no-layout-component' | 'no-circuit-component' | 'no-source-pin' }>;
    /**
     * Addresses claimed by more than one object.
     *
     * A path is a selection: clicking a row resolves it through `byPath`. If two objects claim one path, the
     * map holds one of them and every click on the other silently selects the first — a user inspects C3 and
     * is shown C7's properties, with nothing anywhere saying so. Two components CAN arrive sharing an id: the
     * design may be machine-generated, merged from two sub-sheets, or imported. So the first claim wins (the
     * lookup stays deterministic) and the loser is named here rather than disappearing into the map.
     */
    ambiguous: Array<{ what: string; path: string }>;
}

const ref = (kind: ObjectKind, id: string, parent: string[]): ObjectRef => ({ kind, id, path: [...parent, id] });

/** A component's human label — the designator, which is what an engineer calls it. */
const labelOf = (c: Component | undefined, fallback: string): string => c?.designator ?? fallback;

/**
 * Project the two documents into one tree.
 *
 * `layout` is optional: before a board exists there is still a design to inspect, and the tree should show
 * it rather than nothing. The Layout branch simply does not appear, which is the truthful rendering of
 * "this design has not been laid out yet".
 */
export function buildObjectTree(circuit: CircuitJson, layout?: LayoutGeometry): ObjectTree {
    const unplaced: ObjectTree['unplaced'] = [];
    const ambiguous: ObjectTree['ambiguous'] = [];
    const byPath = new Map<string, TreeNode>();

    const add = (node: TreeNode): TreeNode => {
        const path = node.ref.path.join('/');
        // First claim wins, and the loser is reported. `set` alone would make the LAST one win silently,
        // which is the same bug with worse ergonomics: the addressable object changes as the array order does.
        if (byPath.has(path)) ambiguous.push({ what: node.label, path });
        else byPath.set(path, node);
        return node;
    };

    const circuitById = new Map((circuit.components ?? []).map((c) => [c.id, c]));
    const padsByComponent = new Map<string, LayoutPad[]>();
    for (const pad of layout?.pads ?? []) {
        const list = padsByComponent.get(pad.componentId) ?? [];
        list.push(pad);
        padsByComponent.set(pad.componentId, list);
    }

    const rootRef = ref('root', 'root', []);
    const root: TreeNode = { ref: rootRef, label: 'Root', children: [] };
    add(root);

    // ---- Nets. They belong at the top: a net is not owned by any component, and half of what a user wants
    // to select ("show me everything on GND") is net-scoped.
    const netsRef = ref('nets', 'nets', rootRef.path);
    const nets = add({
        ref: netsRef,
        label: 'Nets',
        detail: String((circuit.nets ?? []).length),
        children: (circuit.nets ?? []).map((n) =>
            add({
                ref: ref('net', n.id, netsRef.path),
                label: n.name,
                detail: n.isGround ? 'ground' : undefined,
                children: [],
            }),
        ),
    });
    root.children.push(nets);

    if (!layout) return { root, byPath, unplaced, ambiguous };

    const layoutRef = ref('layout', 'layout', rootRef.path);
    const componentsRef = ref('components', 'components', layoutRef.path);
    const componentNodes: TreeNode[] = [];

    for (const lc of layout.components) {
        const circuitComponent = circuitById.get(lc.id);
        if (!circuitComponent) {
            // The board carries a part the design does not. Reported, not hidden — it means the two
            // documents have drifted, which is exactly what a user needs to know before trusting either.
            unplaced.push({ what: lc.designator, reason: 'no-circuit-component' });
        }

        const compRef = ref('component', lc.id, componentsRef.path);
        const children: TreeNode[] = [];

        if (lc.footprint) {
            children.push(
                add({ ref: ref('footprint', lc.footprint, compRef.path), label: lc.footprint, children: [] }),
            );
        }

        const pads = padsByComponent.get(lc.id) ?? [];
        if (pads.length > 0) {
            const padsRef = ref('pads', 'pads', compRef.path);
            children.push(
                add({
                    ref: padsRef,
                    label: 'Pads',
                    detail: String(pads.length),
                    children: pads.map((p) => {
                        if (p.sourcePin === null) {
                            // An NC footprint pad, or one pcb-core could not identify. Shown either way —
                            // undeclared copper is precisely the thing a reviewer must be able to see.
                            unplaced.push({ what: `${lc.designator}.${p.pin ?? p.id}`, reason: 'no-source-pin' });
                        }
                        return add({
                            ref: ref('pad', p.id, padsRef.path),
                            // The AUTHORED pin is the label when we have it: an engineer knows "anode", not
                            // "pin1". The renderer's own name is the fallback, never a guess between them.
                            label: p.sourcePin ?? p.pin ?? p.id,
                            detail: p.net ?? 'no net',
                            children: [],
                        });
                    }),
                }),
            );
        }

        componentNodes.push(
            add({
                ref: compRef,
                label: labelOf(circuitComponent, lc.designator),
                detail: circuitComponent?.type ?? 'not in the design',
                children,
            }),
        );
    }

    // A design component with no board component: it was excluded, refused, or the layout predates it.
    // Membership through a Set, not `.some()` per component — the nested scan is quadratic, and the tree is
    // rebuilt on every document change, so on a 200-part board it would burn 40k comparisons per keystroke.
    const placedIds = new Set(layout.components.map((lc) => lc.id));
    for (const c of circuit.components ?? []) {
        if (c.type === 'ground') continue; // a net marker, never placed — not a gap
        if (!placedIds.has(c.id)) unplaced.push({ what: c.designator, reason: 'no-layout-component' });
    }

    const components = add({
        ref: componentsRef,
        label: 'Components',
        detail: String(componentNodes.length),
        children: componentNodes,
    });
    const layoutNode = add({ ref: layoutRef, label: 'Layout', children: [components] });
    root.children.push(layoutNode);

    return { root, byPath, unplaced, ambiguous };
}

/** Resolve a selection back to its node. Returns undefined rather than throwing — a stale selection after a
 *  re-layout is ordinary, and the caller clears it. */
export function nodeAt(tree: ObjectTree, path: string[]): TreeNode | undefined {
    return tree.byPath.get(path.join('/'));
}
