/**
 * The addressable object tree: Root › Components › C3 › Pins / Footprint / Pads › P1.
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
export type ObjectKind =
    | 'root'
    | 'components'
    | 'component'
    /** The design's own pins — present before any board exists. */
    | 'pins'
    | 'pin'
    | 'footprint'
    /** Copper. Only meaningful once the component has been laid out. */
    | 'pads'
    | 'pad'
    | 'nets'
    | 'net';

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
    /**
     * Which component this belongs to, for the kinds whose id is unique only WITHIN one.
     *
     * A pin is called `1`, `+` or `anode`, and every second part on the board has a pin by that name — so
     * `ref.id` alone cannot address one. The owner is visible in `path`, but reading it back by counting
     * from the end (`path[path.length - 3]`) is positional coupling: it works until the tree gains a level,
     * and then it silently addresses the wrong part rather than failing. Carried explicitly instead.
     */
    componentId?: string;
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

const ref = (kind: ObjectKind, id: string, parent: string[], componentId?: string): ObjectRef => ({
    kind,
    id,
    path: [...parent, id],
    ...(componentId === undefined ? {} : { componentId }),
});

/**
 * Is this a PART — something an engineer places, buys and assembles — or a net annotation?
 *
 * A ground symbol is the second: it marks a net as the reference, it has no footprint, it appears on no BOM
 * and nothing picks and places it. Exported because the answer has to be the same everywhere it is asked.
 * It was being re-decided in a React component's footer, which is how the tree said 26 components while the
 * status bar beside it said 27 — for the same design, on the same screen.
 */
export const isPlaceablePart = (component: Pick<Component, 'type'>): boolean => component.type !== 'ground';

/**
 * Is it DRAWN ON THE SCHEMATIC? A different question, with a different answer.
 *
 * The two were one predicate for a while, and the ground symbol is exactly where they part company: nobody
 * buys one or places it on a board, and every schematic in the world draws one. Using the board-and-BOM
 * question to decide what appears on the sheet meant the ground symbol was never drawn — so the commonest
 * connection in any circuit had no terminal on screen and no gesture could make it, and the ground net was
 * drawn instead as long wires reaching across the sheet to everything that touches it, which is precisely
 * what the symbol exists to avoid.
 *
 * Everything is drawn. `symbolFor` has a conventional shape for the types it knows and derives a labelled box
 * from the part's own pins for the rest, so there is no component a sheet cannot show. The predicate stays a
 * function rather than becoming nothing at all, because the QUESTION is what the callers need to name: a
 * renderer asking "should I draw this?" must not reach for the BOM's answer again.
 */
export const isDrawnOnSheet = (component: Pick<Component, 'type'>): boolean => component.type !== undefined;

/**
 * Project the two documents into one tree.
 *
 * `layout` is optional, and its absence is the COMMON case — an editor spends most of its life on a design
 * that has not been routed yet. Without it the tree is the schematic: nets, components, and each component's
 * pins. With it, every component additionally gains its footprint and its copper. Nothing disappears for want
 * of a board.
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
    const netNameById = new Map((circuit.nets ?? []).map((n) => [n.id, n.name]));
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

    // ---- Components come from the DESIGN, not the board.
    //
    // They used to hang under Layout, which made them disappear entirely for a circuit that had not been laid
    // out yet — the overwhelmingly common case, and the one an editor spends most of its time in. A 27-part
    // design opened as twenty-five nets and nothing else, which reads as a design with no parts in it.
    //
    // The design says WHICH parts exist; the layout only says where they ended up. So the component is the
    // node, and footprint and pads are children that appear once there is a board to describe them.
    const componentsRef = ref('components', 'components', rootRef.path);
    const componentNodes: TreeNode[] = [];
    const layoutById = new Map((layout?.components ?? []).map((lc) => [lc.id, lc]));

    for (const c of circuit.components ?? []) {
        if (!isPlaceablePart(c)) continue; // a net marker, not a part anyone places or inspects

        const lc = layoutById.get(c.id);
        const compRef = ref('component', c.id, componentsRef.path);
        const children: TreeNode[] = [];

        // The design's own pins, always — this is the schematic side, and it exists before any board does.
        if (c.pins && c.pins.length > 0) {
            const pinsRef = ref('pins', 'pins', compRef.path);
            children.push(
                add({
                    ref: pinsRef,
                    label: 'Pins',
                    detail: String(c.pins.length),
                    children: c.pins.map((p, i) =>
                        add({
                            // `pinId` is the design's own name for the terminal — '1', '+', 'anode', 'base'.
                            // The index is the fallback for a design that left it blank, so two unnamed pins
                            // stay addressable apart instead of collapsing onto one path.
                            ref: ref('pin', p.pinId || String(i), pinsRef.path, c.id),
                            label: p.pinId || `pin${i + 1}`,
                            // The net's NAME, not its id: 'GND' is what an engineer reads, 'gnd' is a key.
                            // Falls back to the id when the pin references a net the design does not declare
                            // — which is itself worth seeing rather than rendering as blank.
                            detail: netNameById.get(p.netId) ?? p.netId,
                            children: [],
                        }),
                    ),
                }),
            );
        }

        if (lc?.footprint) {
            children.push(
                add({ ref: ref('footprint', lc.footprint, compRef.path), label: lc.footprint, children: [] }),
            );
        }

        const pads = padsByComponent.get(c.id) ?? [];
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
                            unplaced.push({ what: `${c.designator}.${p.pin ?? p.id}`, reason: 'no-source-pin' });
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

        // A design part the board does not carry: excluded, refused, or the layout predates it. Only
        // meaningful once a layout EXISTS — before that, nothing is placed and the whole list would be noise.
        if (layout && !lc) unplaced.push({ what: c.designator, reason: 'no-layout-component' });

        componentNodes.push(
            add({
                ref: compRef,
                label: c.designator,
                detail: layout && !lc ? `${c.type} · not on the board` : c.type,
                children,
            }),
        );
    }

    // The reverse gap: the board carries a part the design does not. Reported, not hidden — it means the two
    // documents have drifted, which is what a user needs to know before trusting either. These get no node,
    // because the tree is a projection of the DESIGN and inventing one would assert a part the design lacks.
    for (const lc of layout?.components ?? []) {
        if (!circuitById.has(lc.id)) unplaced.push({ what: lc.designator, reason: 'no-circuit-component' });
    }

    root.children.push(
        add({
            ref: componentsRef,
            label: 'Components',
            // Says whether a board exists, on the row a reader is already looking at. "12 · laid out" and
            // "12" are different facts, and the difference decides whether Pads mean anything.
            detail: layout ? `${componentNodes.length} · laid out` : String(componentNodes.length),
            children: componentNodes,
        }),
    );

    return { root, byPath, unplaced, ambiguous };
}

/** Resolve a selection back to its node. Returns undefined rather than throwing — a stale selection after a
 *  re-layout is ordinary, and the caller clears it. */
export function nodeAt(tree: ObjectTree, path: string[]): TreeNode | undefined {
    return tree.byPath.get(path.join('/'));
}
