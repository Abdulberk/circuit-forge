/**
 * The object tree, against a REAL board.
 *
 * The fixtures are `apps/pcb-viewer/public/*.layout.json` — genuine pipeline output, the same geometry the
 * worker delivers, not a hand-written shape that happens to satisfy the code. A projection tested only
 * against its own idea of the data proves nothing about the data.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CircuitJson } from '@circuit-forge/eda-core';
import type { LayoutGeometry } from '@circuit-forge/pcb-contract';

import { buildObjectTree, nodeAt, type TreeNode } from './object-tree';

const FIXTURES = join(__dirname, '..', '..', '..', '..', 'apps', 'pcb-viewer', 'public');
const layoutOf = (board: string): LayoutGeometry =>
    (JSON.parse(readFileSync(join(FIXTURES, `${board}.layout.json`), 'utf8')) as { geometry: LayoutGeometry }).geometry;

/** A minimal design matching bridge-rectifier's real component ids, so the join has something to meet. */
const circuitFor = (layout: LayoutGeometry): CircuitJson =>
    ({
        version: '1.0',
        components: layout.components.map((c) => ({
            id: c.id,
            type: c.designator.startsWith('D') || c.designator.startsWith('LED') ? 'diode' : 'resistor',
            designator: c.designator,
            pins: [],
        })),
        nets: [
            { id: 'gnd', name: 'GND', isGround: true },
            { id: 'vplus', name: 'VPLUS' },
        ],
    }) as unknown as CircuitJson;

const walk = (n: TreeNode, out: TreeNode[] = []): TreeNode[] => {
    out.push(n);
    for (const c of n.children) walk(c, out);
    return out;
};

describe('buildObjectTree — Root › Layout › Components › C › Pads › P', () => {
    const layout = layoutOf('bridge-rectifier');
    const circuit = circuitFor(layout);

    it('projects every component and every pad of a real board', () => {
        const tree = buildObjectTree(circuit, layout);
        const nodes = walk(tree.root);
        expect(nodes.filter((n) => n.ref.kind === 'component')).toHaveLength(layout.components.length);
        expect(nodes.filter((n) => n.ref.kind === 'pad')).toHaveLength(layout.pads.length);
    });

    it("labels a pad by OUR authored pin, not the renderer's name", () => {
        // The whole point of the sourcePin join: an engineer knows "anode", not "pin1".
        const tree = buildObjectTree(circuit, layout);
        const padLabels = walk(tree.root)
            .filter((n) => n.ref.kind === 'pad')
            .map((n) => n.label);
        expect(padLabels).toContain('anode');
        expect(padLabels).toContain('cathode');
        expect(padLabels).not.toContain('pin1');
    });

    it('addresses every node by a stable path that resolves in one lookup', () => {
        const tree = buildObjectTree(circuit, layout);
        for (const node of walk(tree.root)) {
            expect(nodeAt(tree, node.ref.path)).toBe(node);
        }
        // A stale selection after a re-layout is ordinary, not an error.
        expect(nodeAt(tree, ['root', 'layout', 'components', 'gone'])).toBeUndefined();
    });

    it('reports what it could not place instead of dropping it', () => {
        // A board carrying a part the design does not know about means the two documents have drifted —
        // exactly what a user must be told before trusting either. A tree that silently omitted it would
        // read as a board that does not have that part.
        const partial = { ...circuit, components: circuit.components.slice(1) } as CircuitJson;
        const tree = buildObjectTree(partial, layout);
        expect(tree.unplaced.some((u) => u.reason === 'no-circuit-component')).toBe(true);
        // …and it is still SHOWN, with an honest detail rather than a fabricated type.
        const orphan = walk(tree.root).find((n) => n.detail === 'not in the design');
        expect(orphan).toBeDefined();
    });

    it('without a layout it shows the design alone — not an empty tree', () => {
        // Before a board exists there is still a circuit to inspect. The Layout branch simply does not
        // appear, which is the truthful rendering of "this has not been laid out yet".
        const tree = buildObjectTree(circuit);
        expect(tree.root.children.map((c) => c.ref.kind)).toEqual(['nets']);
        expect(tree.unplaced).toEqual([]);
    });

    it('names the loser when two objects claim one address', () => {
        // Reachable: a machine-generated design, two merged sub-sheets, an import. The failure it prevents is
        // the quiet one — clicking C3 and being shown C7 — so the duplicate is reported, and the FIRST claim
        // keeps the address so the lookup does not depend on array order.
        const twinned: LayoutGeometry = {
            ...layout,
            components: [...layout.components, { ...layout.components[0]!, designator: 'IMPOSTOR' }],
        };
        const tree = buildObjectTree(circuitFor(layout), twinned);
        const twin = layout.components[0]!;
        // The whole subtree collides, and every colliding address is named — not just the component. The
        // impostor's pads are equally unreachable, and a report that mentioned only the parent would leave a
        // reader believing the pads beneath it were fine.
        expect(tree.ambiguous.map((a) => a.path)).toEqual(
            expect.arrayContaining([`root/layout/components/${twin.id}`, `root/layout/components/${twin.id}/pads`]),
        );
        const clashingPads = tree.ambiguous.filter((a) => a.path.includes('/pads/'));
        expect(clashingPads).toHaveLength(layout.pads.filter((p) => p.componentId === twin.id).length);
        // The address still resolves — to the original, not the impostor.
        expect(nodeAt(tree, ['root', 'layout', 'components', layout.components[0]!.id])!.label).toBe(
            layout.components[0]!.designator,
        );
        // …and a clean board reports nothing, so the field is not noise.
        expect(buildObjectTree(circuitFor(layout), layout).ambiguous).toEqual([]);
    });

    it('builds a 400-component board without a quadratic scan', () => {
        // The tree is rebuilt on every document change. This is a floor, not a benchmark: it fails only if
        // someone reintroduces a nested scan, which at this size costs seconds rather than milliseconds.
        const big: LayoutGeometry = {
            ...layout,
            components: Array.from({ length: 400 }, (_, i) => ({
                ...layout.components[0]!,
                id: `c${i}`,
                designator: `R${i}`,
            })),
            pads: Array.from({ length: 1600 }, (_, i) => ({
                ...layout.pads[0]!,
                id: `p${i}`,
                componentId: `c${i % 400}`,
            })),
        };
        const started = performance.now();
        const tree = buildObjectTree(circuitFor(big), big);
        expect(performance.now() - started).toBeLessThan(250);
        expect(tree.ambiguous).toEqual([]);
    });

    it('every gallery board projects without loss', () => {
        for (const board of ['bridge-rectifier', 'opamp-amp', 'shift-register', 'chaser-4017']) {
            const g = layoutOf(board);
            const tree = buildObjectTree(circuitFor(g), g);
            const pads = walk(tree.root).filter((n) => n.ref.kind === 'pad');
            expect({ board, pads: pads.length }).toEqual({ board, pads: g.pads.length });
            // Only NC footprint pads may lack an authored pin, and those are declared, never silent.
            const unnamed = tree.unplaced.filter((u) => u.reason === 'no-source-pin').length;
            expect(unnamed).toBe(g.pads.filter((p) => p.sourcePin === null).length);
        }
    });
});
