/**
 * Where the parts go, which is what a reader is actually looking at.
 *
 * The wires on a sheet can only be as short as the placement allows, and ours were placed in a square grid
 * by array order with the netlist never consulted. This tests the three claims the layered arrangement
 * makes: the sheet reads left to right from its sources, parts that are wired together end up NEAR each
 * other, and rails are not treated as connections.
 *
 * The measurements are of LENGTH, not of coordinates. Asserting that R2 lands at (280, 120) would be a test
 * of today's cell size that fails the moment anybody changes the spacing, and it would say nothing about
 * whether the sheet is any good.
 */

import type { CircuitJson } from '@circuit-forge/eda-core';

import { arrangeBySignalFlow } from './arrange';
import { bodiesOf, groundGlyphs, netsOf, placeParts } from './layout';
import { routeSheet } from './route';

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
const C = (id: string, a: string, b: string) => ({ ...R(id, a, b), type: 'capacitor', value: '100n' });
const Q = (id: string, c: string, b: string, e: string) => ({
    id,
    type: 'bjt',
    designator: id.toUpperCase(),
    model: '2N3904',
    pins: [
        { pinId: 'c', netId: c },
        { pinId: 'b', netId: b },
        { pinId: 'e', netId: e },
    ],
});
const V = (id: string, a: string, b: string) => ({
    id,
    type: 'voltage_source',
    designator: id.toUpperCase(),
    value: '5',
    pins: [
        { pinId: '+', netId: a },
        { pinId: '-', netId: b },
    ],
});

const sheet = (components: unknown[], netIds: string[], rails: string[] = ['gnd']): CircuitJson =>
    ({
        version: '1.0',
        components,
        nets: netIds.map((id) => ({
            id,
            name: id.toUpperCase(),
            ...(id === 'gnd' ? { isGround: true } : {}),
            ...(rails.includes(id) && id !== 'gnd' ? { isPower: true } : {}),
        })),
    }) as unknown as CircuitJson;

/** How much wire the sheet actually costs, which is the number a reader feels. */
const wireLength = (circuit: CircuitJson): number => {
    const placed = placeParts(circuit);
    const { wires } = routeSheet(netsOf(circuit, placed), bodiesOf([...placed, ...groundGlyphs(circuit, placed)]));
    return wires.reduce(
        (total, w) =>
            total +
            w.points
                .slice(1)
                .reduce((t, p, i) => t + Math.abs(p[0] - w.points[i]![0]) + Math.abs(p[1] - w.points[i]![1]), 0),
        0,
    );
};

describe('reading order', () => {
    it('puts the source on the left and the signal to its right', () => {
        // The convention every schematic follows and no algorithm gets for free. It is also what makes the
        // rest of the arrangement mean anything: a column is a step in the signal's path.
        const circuit = sheet(
            [R('r1', 'in', 'mid'), R('r2', 'mid', 'gnd'), V('v1', 'in', 'gnd')],
            ['in', 'mid', 'gnd'],
        );
        const slots = arrangeBySignalFlow(circuit);
        expect(slots.get('v1')!.column).toBe(0);
        expect(slots.get('r1')!.column).toBeGreaterThan(slots.get('v1')!.column);
        expect(slots.get('r2')!.column).toBeGreaterThan(slots.get('r1')!.column);
    });

    it('does not read the RAILS as connections', () => {
        // A rail reaches half the design. Counted as a connection it would put half the design in column 1
        // and say nothing about how the circuit is read — which is exactly why a schematic marks rails at
        // each terminal instead of wiring them.
        const chain = sheet(
            [V('v1', 'in', 'gnd'), R('r1', 'in', 'a'), R('r2', 'a', 'b'), R('r3', 'b', 'gnd')],
            ['in', 'a', 'b', 'gnd'],
        );
        const slots = arrangeBySignalFlow(chain);
        // Four parts in a chain must occupy four columns. Sharing ground would collapse them into two.
        expect(new Set([...slots.values()].map((s) => s.column)).size).toBe(4);
    });

    it('is the same arrangement whatever order the parts arrived in', () => {
        // Deterministic, like every other answer this kernel gives: undo, redo and a reload must agree, and
        // a test has to be able to name the result.
        const parts = [V('v1', 'in', 'gnd'), R('r1', 'in', 'mid'), R('r2', 'mid', 'out'), C('c1', 'out', 'gnd')];
        const forward = arrangeBySignalFlow(sheet(parts, ['in', 'mid', 'out', 'gnd']));
        const backward = arrangeBySignalFlow(sheet([...parts].reverse(), ['in', 'mid', 'out', 'gnd']));
        expect([...backward].sort()).toEqual([...forward].sort());
    });

    it('still arranges a fragment with no source in it', () => {
        // A sub-sheet, or a design somebody is halfway through. It has no left edge of its own, so the
        // busiest part becomes one — arbitrary, but not random, and never "everything at the origin".
        const fragment = sheet([R('r1', 'a', 'b'), R('r2', 'b', 'c'), R('r3', 'c', 'd')], ['a', 'b', 'c', 'd']);
        const slots = arrangeBySignalFlow(fragment);
        expect(slots.size).toBe(3);
        expect(new Set([...slots.values()].map((s) => `${s.column},${s.row}`)).size).toBe(3);
    });

    it('gives every part a slot of its own, including one connected to nothing', () => {
        // Two parts in one slot are two symbols drawn on top of each other, which is worse than any
        // arrangement. An island has to go SOMEWHERE, and it must not be column 0, which claims it feeds
        // the circuit.
        const withIsland = sheet(
            [V('v1', 'in', 'gnd'), R('r1', 'in', 'gnd'), R('lonely', 'x', 'y')],
            ['in', 'gnd', 'x', 'y'],
        );
        const slots = arrangeBySignalFlow(withIsland);
        expect(slots.size).toBe(3);
        expect(new Set([...slots.values()].map((s) => `${s.column},${s.row}`)).size).toBe(3);
        // BELOW the circuit, not beside it. It used to take a column of its own with a blank one after —
        // measured, a thirteen-part sheet went from 480 units wide to 3040 after eight palette adds, and the
        // part somebody had just added ended up furthest from what they were looking at. A row below says
        // "not part of this yet" without pushing the design off the screen.
        expect(slots.get('lonely')!.row).toBeGreaterThan(Math.max(slots.get('v1')!.row, slots.get('r1')!.row));
    });

    it('keeps unwired parts in a BLOCK rather than a ribbon', () => {
        // A part dragged out of the palette is unwired by construction — every pin gets its own private net
        // — so this is the ordinary state of a sheet somebody is building, not a corner case.
        const bank = sheet(
            [
                V('v1', 'in', 'gnd'),
                R('r1', 'in', 'gnd'),
                ...Array.from({ length: 9 }, (_, i) => R(`c${i}`, `x${i}`, `y${i}`)),
            ],
            [
                'in',
                'gnd',
                ...Array.from({ length: 9 }, (_, i) => `x${i}`),
                ...Array.from({ length: 9 }, (_, i) => `y${i}`),
            ],
        );
        const slots = arrangeBySignalFlow(bank);
        const loose = Array.from({ length: 9 }, (_, i) => slots.get(`c${i}`)!);
        // Nine of them fit in three columns and three rows, not nine columns and one row.
        expect(new Set(loose.map((s) => s.column)).size).toBeLessThanOrEqual(3);
        expect(new Set(loose.map((s) => s.row)).size).toBeGreaterThan(1);
        // …and every one still has a slot to itself.
        expect(new Set(loose.map((s) => `${s.column},${s.row}`)).size).toBe(9);
    });

    it('leaves markers out of it — they belong against the terminal they annotate', () => {
        const withMarker = sheet(
            [
                V('v1', 'in', 'gnd'),
                R('r1', 'in', 'gnd'),
                { id: 'g1', type: 'ground', designator: '', pins: [{ pinId: '1', netId: 'gnd' }] },
            ],
            ['in', 'gnd'],
        );
        expect([...arrangeBySignalFlow(withMarker).keys()].sort()).toEqual(['r1', 'v1']);
    });

    it('says nothing about an empty sheet rather than inventing a slot', () => {
        expect(arrangeBySignalFlow(sheet([], []))).toEqual(new Map());
    });
});

describe('what the arrangement is FOR', () => {
    it('puts parts that are wired together near each other', () => {
        // The property the whole thing exists for, and the one a grid filled by index cannot give: on an
        // eight-part ladder it put two parts of the same net 640 units apart at opposite corners, and the
        // router then drew the honest long way round.
        const ladder = sheet(
            [
                V('v1', 'in', 'gnd'),
                ...Array.from({ length: 8 }, (_, i) =>
                    R(`r${i}`, i === 0 ? 'in' : `n${i}`, i === 7 ? 'gnd' : `n${i + 1}`),
                ),
            ],
            ['in', 'gnd', ...Array.from({ length: 8 }, (_, i) => `n${i + 1}`)],
        );
        const placed = placeParts(ladder);
        const at = new Map(placed.map((p) => [p.id, p]));
        const joined = (a: { pins: { netId: string }[] }, b: { pins: { netId: string }[] }) =>
            a.pins.some((p) => b.pins.some((q) => p.netId === q.netId && q.netId !== 'gnd'));

        let worst = 0;
        for (const a of ladder.components!)
            for (const b of ladder.components!) {
                if (a.id >= b.id || !joined(a, b)) continue;
                worst = Math.max(
                    worst,
                    Math.abs(at.get(a.id)!.x - at.get(b.id)!.x) + Math.abs(at.get(a.id)!.y - at.get(b.id)!.y),
                );
            }
        // One cell apart is the best any grid can do; two is a neighbour once removed. Six — which is what
        // index order gave — is the other side of the sheet.
        expect({ worst, ok: worst <= 400 }).toEqual({ worst, ok: true });
    });

    it('draws less wire than the grid it replaced, on the circuits this product makes', () => {
        // The number a reader feels. Measured against the grid-by-index arrangement these were drawn with
        // before: divider 580, RC filter 570, eight-part ladder 2400.
        const divider = sheet(
            [V('v1', 'in', 'gnd'), R('r1', 'in', 'mid'), R('r2', 'mid', 'gnd')],
            ['in', 'mid', 'gnd'],
        );
        const filter = sheet([V('v1', 'in', 'gnd'), R('r1', 'in', 'out'), C('c1', 'out', 'gnd')], ['in', 'out', 'gnd']);
        expect({ divider: wireLength(divider) < 580, filter: wireLength(filter) < 570 }).toEqual({
            divider: true,
            filter: true,
        });
    });
});

/**
 * How many times one net's wire crosses another's, strictly through the middle of both.
 *
 * A crossing is legible — it is the one thing a reader never misreads, and the router allows it on purpose —
 * but it is still work: every one is a place somebody has to follow a line with their eye to be sure. Length
 * is what a sheet costs; crossings are what it costs to READ.
 */
const crossings = (circuit: CircuitJson): number => {
    const placed = placeParts(circuit);
    const { wires } = routeSheet(netsOf(circuit, placed), bodiesOf([...placed, ...groundGlyphs(circuit, placed)]));
    const segs = wires.flatMap((w) =>
        w.points.slice(1).map((p, i) => ({
            x1: w.points[i]![0],
            y1: w.points[i]![1],
            x2: p[0],
            y2: p[1],
            net: w.netId,
        })),
    );
    const det = (px: number, py: number, qx: number, qy: number) => px * qy - py * qx;
    let total = 0;
    for (let i = 0; i < segs.length; i++)
        for (let k = i + 1; k < segs.length; k++) {
            const a = segs[i]!;
            const b = segs[k]!;
            if (a.net === b.net) continue;
            const r = [a.x2 - a.x1, a.y2 - a.y1] as const;
            const t = [b.x2 - b.x1, b.y2 - b.y1] as const;
            const w = [b.x1 - a.x1, b.y1 - a.y1] as const;
            const den = det(r[0], r[1], t[0], t[1]);
            if (den === 0) continue;
            const u = det(w[0], w[1], t[0], t[1]) / den;
            const v = det(w[0], w[1], r[0], r[1]) / den;
            // STRICTLY interior to both, which is what a crossing IS: touching at an end is a junction, and
            // the router forbids that between two nets anyway.
            if (u > 0 && u < 1 && v > 0 && v < 1) total++;
        }
    return total;
};

describe('not crossing', () => {
    /**
     * A source feeding three branches, two of which feed one output — and the ids chosen so that ALPHABETICAL
     * order is the wrong order: `xa` hangs off the last branch and `xb` off the first.
     *
     * This circuit exists because the ordering step could not be shown to do anything without it. On a chain
     * — a divider, a filter, a ladder — the order parts arrive in is already the order that does not cross,
     * so switching the step off changed nothing on any of them, and a step that changes nothing is one to
     * delete rather than keep. Measured here: with it, no crossing and 1120 units of wire; without it, one
     * crossing and 1440.
     */
    const FAN: CircuitJson = sheet(
        [
            V('v1', 'in', 'gnd'),
            R('a', 'in', 'na'),
            R('b', 'in', 'nb'),
            R('c', 'in', 'nc'),
            R('xa', 'nc', 'out'),
            R('xb', 'na', 'out'),
        ],
        ['in', 'gnd', 'na', 'nb', 'nc', 'out'],
    );

    it('orders a column by what it connects to, not by the ids', () => {
        const slots = arrangeBySignalFlow(FAN);
        // `xb` hangs off `a`, which is the top of its column, so it belongs at the top of the next one.
        expect(slots.get('xb')!.row).toBeLessThan(slots.get('xa')!.row);
    });

    it('leaves the fan-out sheet with no crossings at all', () => {
        expect({ crossings: crossings(FAN) }).toEqual({ crossings: 0 });
    });

    it('leaves the circuits this product actually makes with none either', () => {
        // Length was the number I measured when this arrangement was written; crossings are the number a
        // reader feels, and nothing was checking them. All five come out clean.
        const divider = sheet(
            [V('v1', 'in', 'gnd'), R('r1', 'in', 'mid'), R('r2', 'mid', 'gnd')],
            ['in', 'mid', 'gnd'],
        );
        const filter = sheet([V('v1', 'in', 'gnd'), R('r1', 'in', 'out'), C('c1', 'out', 'gnd')], ['in', 'out', 'gnd']);
        // THE WHOLE amplifier, transistors included. An earlier version of this fixture left them out and
        // measured one crossing — correctly: without them the stages touch nothing but the rails, the graph
        // falls into unconnected pieces, and no arrangement of unconnected pieces is better than another.
        // It is the transistors that make it a circuit rather than a pile of parts.
        const twoStage = sheet(
            [
                V('v1', 'vcc', 'gnd'),
                C('c1', 'in', 'b1'),
                R('rb1', 'vcc', 'b1'),
                Q('q1', 'c1n', 'b1', 'gnd'),
                R('rc1', 'vcc', 'c1n'),
                C('c2', 'c1n', 'b2'),
                R('rb2', 'vcc', 'b2'),
                Q('q2', 'c2n', 'b2', 'gnd'),
                R('rc2', 'vcc', 'c2n'),
                C('c3', 'c2n', 'out'),
                R('rl', 'out', 'gnd'),
            ],
            ['vcc', 'gnd', 'in', 'b1', 'c1n', 'b2', 'c2n', 'out'],
            ['gnd', 'vcc'],
        );
        expect({
            divider: crossings(divider),
            filter: crossings(filter),
            twoStage: crossings(twoStage),
        }).toEqual({ divider: 0, filter: 0, twoStage: 0 });
    });
});
