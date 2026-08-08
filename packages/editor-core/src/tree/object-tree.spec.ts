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

import { buildObjectTree, componentPath, netPath, nodeAt, pathKey, pinPath, type TreeNode } from './object-tree';

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

    it('INCLUDES a ground marker, because it is on the drawing and a click has to resolve to something', () => {
        // This tree is the SELECTION AUTHORITY: the canvas resolves every click through it. While it skipped
        // net markers and the sheet drew them, the ground symbol was the one object a user could see, drag
        // and wire — and never select. Clicking it destroyed whatever WAS selected and put nothing in its
        // place, so it could not be turned, mirrored, deleted or inspected by any surface in the app.
        const withGround = {
            ...circuit,
            components: [...circuit.components, { id: 'g1', type: 'ground', designator: 'GND1', pins: [] }],
        } as unknown as CircuitJson;
        const tree = buildObjectTree(withGround);
        expect(kinds(tree, 'component').map((n) => n.label)).toContain('GND1');
        expect(tree.byPath.get('root/components/g1')).toBeTruthy();
        // …and it is still not a PART. The row says which it is rather than leaving a reader to count.
        expect(kinds(tree, 'component').find((n) => n.label === 'GND1')?.detail).toBe('net marker');
        expect(tree.unplaced).toEqual([]);
    });

    it('names BOTH numbers on the group, so neither has to be inferred', () => {
        // A single count would leave a reader working out which question it answers — the same confusion that
        // once had the tree saying 26 while the status bar beside it said 27, for the same design.
        const withGround = {
            ...circuit,
            components: [...circuit.components, { id: 'g1', type: 'ground', designator: 'GND1', pins: [] }],
        } as unknown as CircuitJson;
        const parts = circuit.components.length;
        expect(buildObjectTree(withGround).root.children.find((n) => n.ref.kind === 'components')?.detail).toBe(
            `${parts} parts · 1 markers`,
        );
        // With no markers there is only one number to give, so it is given plainly.
        expect(buildObjectTree(circuit).root.children.find((n) => n.ref.kind === 'components')?.detail).toBe(
            String(parts),
        );
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

    it('builds a large board without a quadratic scan', () => {
        // The tree is rebuilt on every document change, so a nested scan here is felt on every keystroke.
        //
        // COUNTED, NOT TIMED — and it took three attempts to get there, which is the part worth recording.
        //
        // First it asserted a wall-clock ceiling of 250 ms. That failed CI at 261 ms, on a test whose own
        // comment said a nested scan "costs seconds rather than milliseconds"; a deadline does not measure
        // complexity, it measures how fast the box is. Worse, it was wrong in BOTH directions: a real
        // reintroduced quadratic ran in 36 ms at that size and sailed under the bar.
        //
        // Then it doubled the input and asserted the TIME ratio, on the reasoning that linear work doubles
        // and a nested scan quadruples regardless of machine. Locally that measured 1.75–2.17 across
        // 100→1600 parts, cleanly linear. On a two-core CI runner the same code measured 4.6 — because a
        // larger workload on a constrained machine degrades super-linearly for reasons that have nothing to
        // do with the algorithm: allocation pressure, cache, the scheduler. A ratio is less
        // machine-dependent than a deadline and it is not machine-INdependent, which is what the claim
        // needed.
        //
        // So this counts the WORK. Every pad access is tallied through a proxy: a linear build touches each
        // pad a fixed number of times, a nested scan touches every pad once per component. At 400 parts
        // that is ~1.6k against ~640k — three orders of magnitude apart, exact, and identical on every
        // machine that has ever run it. There is no bar to tune and no noise to sit above.
        const boardOf = (components: number): LayoutGeometry => ({
            ...layout,
            components: Array.from({ length: components }, (_, i) => ({
                ...layout.components[0]!,
                id: `c${i}`,
                designator: `R${i}`,
            })),
            // Four pads per component, each with a DISTINCT source pin. Spreading one real pad N×4 times
            // gave every pad the same `sourcePin`, so all four pins of a component claimed one address — and
            // the tree correctly reported thousands of collisions. The fixture was wrong, not the code; a
            // component whose pins are all called the same thing is not a board anyone would fabricate.
            pads: Array.from({ length: components * 4 }, (_, i) => ({
                ...layout.pads[0]!,
                id: `p${i}`,
                componentId: `c${i % components}`,
                // The pad's index WITHIN its component, not `i % 4` — with N components that stride is a
                // multiple of 4, so every pad of a component landed on the same name and the collision came
                // straight back. Deriving it from the position in the group is what actually makes it unique.
                pin: String(Math.floor(i / components) + 1),
                sourcePin: `pin${Math.floor(i / components) + 1}`,
            })),
        });

        /** Build the tree and report how many times the pad array was READ. */
        const padReads = (components: number): { reads: number; pads: number } => {
            const board = boardOf(components);
            let reads = 0;
            // A proxy over the pad array. Only numeric index reads are counted — `length`, `Symbol.iterator`
            // and the like are structure, not work. A `for…of` over the array reads each element once; a
            // `filter` per component reads every element once PER COMPONENT, which is exactly the shape the
            // guard exists to catch.
            const counted = new Proxy(board.pads, {
                get(target, prop, receiver) {
                    if (typeof prop === 'string' && /^\d+$/.test(prop)) reads++;
                    return Reflect.get(target, prop, receiver) as unknown;
                },
            });
            const tree = buildObjectTree(circuitFor(board), { ...board, pads: counted });
            expect(tree.ambiguous).toEqual([]);
            return { reads, pads: board.pads.length };
        };

        const { reads, pads } = padReads(400);

        // A small constant multiple of the pad count. Linear work reads each pad a bounded number of times
        // however the implementation is arranged; a nested scan reads `components × pads`, four hundred
        // times more. The bound is loose on purpose — it is not a performance budget, it is the line
        // between "touches each pad a few times" and "touches every pad for every component".
        expect({ reads: reads <= pads * 8, reads_actual: reads, pads }).toEqual({
            reads: true,
            reads_actual: reads,
            pads,
        });

        // …and it must not be vacuous: a build that read NO pads would satisfy the bound while doing
        // nothing, which is how a guard quietly stops guarding.
        expect(reads).toBeGreaterThan(0);
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

describe('an object’s address', () => {
    /**
     * An id is ORDINARY DATA. This module already says so a few lines from the ambiguity report it keeps: a
     * design can be machine-generated, imported, or merged from two sub-sheets, and any of those can produce
     * an id with a slash in it. An address is a JOIN, and a join is only unambiguous while no segment can
     * contain the separator.
     */
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
                // The collision, exactly: joined naively this is the same string as r1's pin 2.
                id: 'r1/pins/2',
                type: 'resistor',
                designator: 'R2',
                value: '2k',
                pins: [
                    { pinId: '1', netId: 'b' },
                    { pinId: '2', netId: 'a' },
                ],
            },
        ] as never,
        nets: [
            { id: 'a', name: 'A' },
            { id: 'b', name: 'B' },
        ],
    };

    it('cannot be forged by an id that looks like one', () => {
        // THE DEFECT. Both objects joined to `root/components/r1/pins/2`, so one of them lost its address:
        // reported as an ADDRESS CLAIMED TWICE in a document with no repeated id anywhere, and unselectable
        // on the sheet — visible, clickable, and every click selecting something else entirely.
        const tree = buildObjectTree(CIRCUIT);
        const part = tree.byPath.get(componentPath('r1/pins/2'));
        const pin = tree.byPath.get(pinPath('r1', '2'));
        expect(part?.ref.kind).toBe('component');
        expect(part?.ref.id).toBe('r1/pins/2');
        expect(pin?.ref.kind).toBe('pin');
        expect(pin?.ref.componentId).toBe('r1');
        expect(componentPath('r1/pins/2')).not.toBe(pinPath('r1', '2'));
        // ...and nothing was reported as ambiguous, because nothing WAS.
        expect(tree.ambiguous).toEqual([]);
    });

    it('cannot be forged by an id containing the escape either', () => {
        // `%` is escaped first for this reason: without it, an id holding the literal text `%2F` would decode
        // into a separator and the same collision would come back by a longer route.
        // The pair that actually forges: one id PRODUCES the escape (`a/b` becomes `a%2Fb`) and the other
        // one CONTAINS it already. Comparing an escaped id against a two-segment path instead — which is what
        // this test did first — differs whether or not `%` is escaped, so it passed either way and proved
        // nothing. Escaping `%` first is what keeps these two apart.
        expect(pathKey(['x', 'a/b'])).not.toBe(pathKey(['x', 'a%2Fb']));
        expect(pathKey(['x', 'a%b'])).not.toBe(pathKey(['x', 'a%25b']));
    });

    it('leaves ordinary addresses exactly as they read', () => {
        // The escaping must be invisible for every id anybody actually has — a scheme that rewrote `r1` would
        // churn every stored selection and every test that names a row.
        expect(componentPath('r1')).toBe('root/components/r1');
        expect(pinPath('r1', '2')).toBe('root/components/r1/pins/2');
        expect(netPath('gnd')).toBe('root/nets/gnd');
    });

    it('round-trips through nodeAt for an id with a separator in it', () => {
        // `nodeAt` takes SEGMENTS, so it must escape them the same way the map was keyed — otherwise the two
        // halves of one mechanism disagree and only the awkward ids notice.
        const tree = buildObjectTree(CIRCUIT);
        const node = nodeAt(tree, ['root', 'components', 'r1/pins/2']);
        expect(node?.ref.id).toBe('r1/pins/2');
    });

    it('still reports a genuinely duplicated id, which is a real document defect', () => {
        // Narrowing what counts as an ambiguity must not switch the report off: two parts really sharing an
        // id means one of them is unreachable, and the user has to be told which.
        const twins: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'a' }] },
                { id: 'r1', type: 'resistor', designator: 'R2', value: '2k', pins: [{ pinId: '1', netId: 'a' }] },
            ] as never,
            nets: [{ id: 'a', name: 'A' }],
        };
        expect(buildObjectTree(twins).ambiguous.length).toBeGreaterThan(0);
    });
});
