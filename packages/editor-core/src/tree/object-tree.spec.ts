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

/**
 * A design matching the board's real ids, so the join has something to meet.
 *
 * The pins are derived from the board's own pads — `sourcePin` is the design-side name pcb-core recorded, so
 * reusing it here produces the design that would have PRODUCED this board, rather than a plausible-looking
 * one. Nets likewise: the pads carry the net each is on.
 */
const circuitFor = (layout: LayoutGeometry): CircuitJson => {
    const nets = [...new Set(layout.pads.map((p) => p.net).filter((n): n is string => typeof n === 'string'))];
    return {
        version: '1.0',
        components: layout.components.map((c) => ({
            id: c.id,
            type: c.designator.startsWith('D') || c.designator.startsWith('LED') ? 'diode' : 'resistor',
            designator: c.designator,
            pins: layout.pads
                .filter((p) => p.componentId === c.id)
                .map((p) => ({ pinId: p.sourcePin ?? p.pin ?? p.id, netId: p.net ?? 'unconnected' })),
        })),
        nets: nets.map((n) => ({ id: n, name: n.toUpperCase(), isGround: /^gnd$/i.test(n) })),
    } as unknown as CircuitJson;
};

const walk = (n: TreeNode, out: TreeNode[] = []): TreeNode[] => {
    out.push(n);
    for (const c of n.children) walk(c, out);
    return out;
};
const kinds = (tree: { root: TreeNode }, kind: string) => walk(tree.root).filter((n) => n.ref.kind === kind);

describe('buildObjectTree — Root › Components › C › Pins / Footprint / Pads', () => {
    const layout = layoutOf('bridge-rectifier');
    const circuit = circuitFor(layout);

    it('shows the components of a design that has NO layout at all', () => {
        // The regression this file exists for. Components used to hang under a Layout branch, so a circuit
        // that had not been routed yet — which is what an editor looks at nearly all the time — rendered as
        // its nets and nothing else. A 27-part design read as a design with no parts in it.
        const tree = buildObjectTree(circuit);
        expect(kinds(tree, 'component')).toHaveLength(layout.components.length);
        expect(kinds(tree, 'pin').length).toBeGreaterThan(0);
        // No board, so nothing claims to know about copper.
        expect(kinds(tree, 'pad')).toHaveLength(0);
        expect(kinds(tree, 'footprint')).toHaveLength(0);
        // And nothing is reported as unplaced: with no layout, nothing was supposed to be placed.
        expect(tree.unplaced).toEqual([]);
    });

    it('adds footprint and copper once a layout exists, without moving anything', () => {
        const withBoard = buildObjectTree(circuit, layout);
        const without = buildObjectTree(circuit);
        // The SAME addresses either way — a selection made before layout still resolves after it.
        expect(kinds(withBoard, 'component').map((n) => n.ref.path.join('/'))).toEqual(
            kinds(without, 'component').map((n) => n.ref.path.join('/')),
        );
        expect(kinds(withBoard, 'pad')).toHaveLength(layout.pads.length);
    });

    it("labels a pad by OUR authored pin, not the renderer's name", () => {
        // The whole point of the sourcePin join: an engineer knows "anode", not "pin1".
        const padLabels = kinds(buildObjectTree(circuit, layout), 'pad').map((n) => n.label);
        expect(padLabels).toContain('anode');
        expect(padLabels).toContain('cathode');
        expect(padLabels).not.toContain('pin1');
    });

    it('shows each pin against its net NAME, not the net id', () => {
        // 'GND' is what an engineer reads; 'gnd' is a key. A tree that showed the key would be readable only
        // by someone who already knew the document.
        const details = kinds(buildObjectTree(circuit), 'pin').map((n) => n.detail);
        expect(details).toContain('GND');
        expect(details).not.toContain('gnd');
    });

    it('addresses every node by a stable path that resolves in one lookup', () => {
        const tree = buildObjectTree(circuit, layout);
        for (const node of walk(tree.root)) {
            expect(nodeAt(tree, node.ref.path)).toBe(node);
        }
        // A stale selection after a re-layout is ordinary, not an error.
        expect(nodeAt(tree, ['root', 'components', 'gone'])).toBeUndefined();
    });

    it('reports drift in BOTH directions instead of dropping it', () => {
        // A board carrying a part the design lacks means the two documents have drifted — exactly what a user
        // must be told before trusting either.
        const missingFirst = { ...circuit, components: circuit.components.slice(1) } as CircuitJson;
        const orphanOnBoard = buildObjectTree(missingFirst, layout);
        expect(orphanOnBoard.unplaced.some((u) => u.reason === 'no-circuit-component')).toBe(true);

        // …and the reverse: a design part that never made it onto the board. It is still SHOWN — it exists in
        // the design — but its row says so rather than looking like an ordinary placed part.
        const extra = {
            ...circuit,
            components: [...circuit.components, { id: 'ghost', type: 'resistor', designator: 'R99', pins: [] }],
        } as unknown as CircuitJson;
        const notPlaced = buildObjectTree(extra, layout);
        expect(notPlaced.unplaced.some((u) => u.reason === 'no-layout-component' && u.what === 'R99')).toBe(true);
        expect(kinds(notPlaced, 'component').find((n) => n.label === 'R99')?.detail).toContain('not on the board');
    });

    it('says on the group row whether a board exists', () => {
        // "12" and "12 · laid out" are different facts, and the difference decides whether Pads mean anything.
        const group = (t: ReturnType<typeof buildObjectTree>) =>
            t.root.children.find((c) => c.ref.kind === 'components')!.detail;
        expect(group(buildObjectTree(circuit))).not.toContain('laid out');
        expect(group(buildObjectTree(circuit, layout))).toContain('laid out');
    });

    it('omits ground markers — they are net annotations, not parts to place', () => {
        const withGround = {
            ...circuit,
            components: [...circuit.components, { id: 'g1', type: 'ground', designator: 'GND1', pins: [] }],
        } as unknown as CircuitJson;
        const tree = buildObjectTree(withGround);
        expect(kinds(tree, 'component').map((n) => n.label)).not.toContain('GND1');
        // …and it is not reported as a gap either, because it was never supposed to be placed.
        expect(tree.unplaced).toEqual([]);
    });

    it('names the loser when two objects claim one address', () => {
        // Reachable: a machine-generated design, two merged sub-sheets, an import. The failure it prevents is
        // the quiet one — clicking C3 and being shown C7 — so the duplicate is reported, and the FIRST claim
        // keeps the address so the lookup does not depend on array order.
        const twin = circuit.components[0]!;
        const twinned = {
            ...circuit,
            components: [...circuit.components, { ...twin, designator: 'IMPOSTOR' }],
        } as CircuitJson;
        const tree = buildObjectTree(twinned);

        expect(tree.ambiguous.map((a) => a.path)).toContain(`root/components/${twin.id}`);
        // The address still resolves — to the original, not the impostor.
        expect(nodeAt(tree, ['root', 'components', twin.id])!.label).toBe(twin.designator);
        expect(buildObjectTree(circuit).ambiguous).toEqual([]);
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
            // Four pads per component, each with a DISTINCT source pin. Spreading one real pad 1600 times
            // gave every pad the same `sourcePin`, so all four pins of a component claimed one address — and
            // the tree correctly reported 4802 collisions. The fixture was wrong, not the code; a component
            // whose pins are all called the same thing is not a board anyone would fabricate.
            pads: Array.from({ length: 1600 }, (_, i) => ({
                ...layout.pads[0]!,
                id: `p${i}`,
                componentId: `c${i % 400}`,
                // The pad's index WITHIN its component, not `i % 4` — with 400 components that stride is a
                // multiple of 4, so every pad of a component landed on the same name and the collision came
                // straight back. Deriving it from the position in the group is what actually makes it unique.
                pin: String(Math.floor(i / 400) + 1),
                sourcePin: `pin${Math.floor(i / 400) + 1}`,
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
            expect({ board, pads: kinds(tree, 'pad').length }).toEqual({ board, pads: g.pads.length });
            // Only NC footprint pads may lack an authored pin, and those are declared, never silent.
            const unnamed = tree.unplaced.filter((u) => u.reason === 'no-source-pin').length;
            expect(unnamed).toBe(g.pads.filter((p) => p.sourcePin === null).length);
        }
    });
});
