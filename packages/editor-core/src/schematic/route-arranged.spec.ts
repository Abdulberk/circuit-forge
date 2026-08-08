/**
 * The router on sheets somebody has ARRANGED — which is the only state a real sheet is ever in.
 *
 * Two files already test it and neither one turns a part. `route.spec.ts` builds adversarial sheets out of
 * synthetic terminals, so orientation never enters; `route-real-circuits.spec.ts` uses real circuits but
 * always straight off `placeParts` with no positions at all. So every wire ever checked was drawn against
 * parts in their default orientation, at the pitch the auto-placer chose — and a user's first act is to turn
 * things and drag them somewhere else.
 *
 * That gap is where a defect would live, because turning a part moves BOTH its pins and its body outline, and
 * those are computed separately: a rotation that moved the pins correctly and the bounds wrongly would send
 * wires straight through symbols, and nothing would have said so.
 *
 * It found one. Not a lie — the rules below all held — but two terminals dragged onto the SAME point were
 * answered with a wire from a point to itself, reported as a wire the router could not draw at right angles.
 * A perfect connection raising the module's own warning.
 */

import type { CircuitJson, Position } from '@circuit-forge/eda-core';

import { bodiesOf, groundGlyphs, netsOf, placeParts, railGlyphs } from './layout';
import { routeSheet, type Box, type Point } from './route';

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
const D = (id: string, a: string, b: string) => ({
    id,
    type: 'diode',
    designator: id.toUpperCase(),
    model: '1N4148',
    pins: [
        { pinId: 'anode', netId: a },
        { pinId: 'cathode', netId: b },
    ],
});
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

const sheet = (components: unknown[], netIds: string[]): CircuitJson =>
    ({
        version: '1.0',
        components,
        nets: netIds.map((id) => ({
            id,
            name: id.toUpperCase(),
            ...(id === 'gnd' ? { isGround: true } : {}),
            ...(id === 'vcc' ? { isPower: true } : {}),
        })),
    }) as unknown as CircuitJson;

/** Circuits this product actually draws, not adversarial ones — the point here is orientation, not density. */
const CIRCUITS: Record<string, CircuitJson> = {
    divider: sheet([V('v1', 'vin', 'gnd'), R('r1', 'vin', 'mid'), R('r2', 'mid', 'gnd')], ['vin', 'mid', 'gnd']),
    filter: sheet(
        [V('v1', 'in', 'gnd'), R('r1', 'in', 'out'), C('c1', 'out', 'gnd'), R('r2', 'out', 'gnd')],
        ['in', 'out', 'gnd'],
    ),
    clipper: sheet(
        [V('v1', 'in', 'gnd'), R('r1', 'in', 'n1'), D('d1', 'n1', 'gnd'), D('d2', 'gnd', 'n1'), C('c1', 'n1', 'gnd')],
        ['in', 'n1', 'gnd'],
    ),
    amplifier: sheet(
        [
            V('v1', 'vcc', 'gnd'),
            R('rc', 'vcc', 'col'),
            R('rb', 'vcc', 'base'),
            Q('q1', 'col', 'base', 'gnd'),
            C('cin', 'in', 'base'),
            C('cout', 'col', 'out'),
            R('rl', 'out', 'gnd'),
        ],
        ['vcc', 'col', 'base', 'in', 'out', 'gnd'],
    ),
};

/** Seeded, so a failure names a sheet somebody can reproduce rather than one that happened once. */
const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const arrangement = (circuit: CircuitJson, seed: number): Record<string, Position> => {
    const rand = rng(seed);
    const positions: Record<string, Position> = {};
    for (const c of circuit.components ?? []) {
        const rotation = (['0', '90', '180', '270'] as const)[Math.floor(rand() * 4)]!;
        const mirror = ([undefined, 'x', 'y'] as const)[Math.floor(rand() * 3)];
        positions[c.id] = {
            x: 120 + Math.round(rand() * 6) * 60,
            y: 120 + Math.round(rand() * 5) * 60,
            ...(rotation === '0' ? {} : { rotation }),
            ...(mirror ? { mirror } : {}),
        } as Position;
    }
    return positions;
};

interface Seg {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    netId: string;
    key: string;
}

const segmentsOf = (points: readonly Point[], netId: string, key: string): Seg[] =>
    points.slice(1).map((p, i) => ({ x1: points[i]![0], y1: points[i]![1], x2: p[0], y2: p[1], netId, key }));

const onSeg = (s: Seg, x: number, y: number): boolean =>
    (s.x2 - s.x1) * (y - s.y1) - (s.y2 - s.y1) * (x - s.x1) === 0 &&
    Math.min(s.x1, s.x2) <= x &&
    x <= Math.max(s.x1, s.x2) &&
    Math.min(s.y1, s.y2) <= y &&
    y <= Math.max(s.y1, s.y2);

/** Strictly inside the box — touching an edge is how a wire legitimately arrives at a pin. */
const entersBody = (s: Seg, b: Box): boolean => {
    const steps = 64;
    for (let i = 1; i < steps; i++) {
        const x = s.x1 + ((s.x2 - s.x1) * i) / steps;
        const y = s.y1 + ((s.y2 - s.y1) * i) / steps;
        if (x > b.minX && x < b.maxX && y > b.minY && y < b.maxY) return true;
    }
    return false;
};

/**
 * How two segments meet, WITHOUT assuming either is axis-aligned.
 *
 * The assumption is what an earlier version of this check got wrong: it treated a fallback diagonal as a
 * vertical line and reported four connections that were not there. Only a transversal crossing strictly
 * interior to BOTH segments is legible; every other contact — a T, an abutment, an overlap — reads as one
 * conductor, which is exactly what must not happen between two nets.
 */
const meeting = (a: Seg, b: Seg): 'apart' | 'crossing' | 'contact' => {
    const det = (px: number, py: number, qx: number, qy: number) => px * qy - py * qx;
    const r = [a.x2 - a.x1, a.y2 - a.y1] as const;
    const t = [b.x2 - b.x1, b.y2 - b.y1] as const;
    const w = [b.x1 - a.x1, b.y1 - a.y1] as const;
    const den = det(r[0], r[1], t[0], t[1]);
    if (den === 0) {
        if (det(w[0], w[1], r[0], r[1]) !== 0) return 'apart';
        const len = r[0] * r[0] + r[1] * r[1];
        if (len === 0) return 'apart'; // a point, which has no direction and cannot be reasoned about here
        const u0 = (w[0] * r[0] + w[1] * r[1]) / len;
        const u1 = u0 + (t[0] * r[0] + t[1] * r[1]) / len;
        const [lo, hi] = u0 < u1 ? [u0, u1] : [u1, u0];
        return hi < 0 || lo > 1 ? 'apart' : 'contact';
    }
    const u = det(w[0], w[1], t[0], t[1]) / den;
    const v = det(w[0], w[1], r[0], r[1]) / den;
    if (u < 0 || u > 1 || v < 0 || v > 1) return 'apart';
    return u > 0 && u < 1 && v > 0 && v < 1 ? 'crossing' : 'contact';
};

describe('the router on arranged sheets', () => {
    it('tells no lie on 240 sheets somebody has turned, mirrored and dragged', () => {
        const broken: unknown[] = [];
        let segs = 0;
        let orthogonal = 0;
        let undrawableTotal = 0;
        let degenerate = 0;

        for (const [name, circuit] of Object.entries(CIRCUITS)) {
            for (let seed = 1; seed <= 60; seed++) {
                const placed = placeParts(circuit, arrangement(circuit, seed * 7919 + name.length));
                const bodies = bodiesOf([
                    ...placed,
                    ...groundGlyphs(circuit, placed),
                    ...railGlyphs(circuit, placed),
                ]);
                const nets = netsOf(circuit, placed);
                const { wires, fellBack } = routeSheet(nets, bodies);

                const undrawable = new Set(
                    fellBack.filter((f) => f.reason === 'no-legible-route').map((f) => f.key),
                );
                undrawableTotal += undrawable.size;

                const all = wires
                    .filter((w) => !undrawable.has(w.key))
                    .flatMap((w) => segmentsOf(w.points, w.netId, w.key));

                // NO SEGMENT OF ZERO LENGTH. It has no direction, so no rule below can be applied to it, and
                // a check that quietly skipped it would be a check with a hole in it. It is also a real
                // defect on its own: with a round line cap a zero-length segment draws a DOT, and a dot is
                // this notation's strongest claim.
                for (const s of all) if (s.x1 === s.x2 && s.y1 === s.y2) degenerate++;

                const pins = nets.flatMap((n) => n.pins.map((q) => ({ ...q, netId: n.id })));
                for (const s of all) {
                    segs++;
                    if (s.x1 === s.x2 || s.y1 === s.y2) orthogonal++;
                    for (const q of pins)
                        if (q.netId !== s.netId && onSeg(s, q.x, q.y))
                            broken.push({ name, seed, why: 'touches a foreign terminal', s, q });
                    for (const b of bodies)
                        if (entersBody(s, b)) broken.push({ name, seed, why: 'passes through a symbol', s, b });
                }
                for (let i = 0; i < all.length; i++)
                    for (let k = i + 1; k < all.length; k++)
                        if (all[i]!.netId !== all[k]!.netId && meeting(all[i]!, all[k]!) === 'contact')
                            broken.push({ name, seed, why: 'two nets drawn as one conductor', a: all[i], b: all[k] });
            }
        }

        expect(broken.slice(0, 3)).toEqual([]);
        expect({ degenerate }).toEqual({ degenerate: 0 });
        // The measuring device, checked against itself: a router that drew nothing would satisfy every rule
        // above. These are circuits the product actually produces, so most wires must come out at right
        // angles even after the sheet has been shuffled, and the count that could not be drawn honestly must
        // stay small — turning a part is not supposed to cost legibility.
        expect({
            sampled: segs > 2000,
            orthogonal: orthogonal / segs > 0.95,
            undrawableShare: undrawableTotal / segs < 0.05,
        }).toEqual({ sampled: true, orthogonal: true, undrawableShare: true });
    });

    it('draws NOTHING between two terminals dragged onto the same point', () => {
        // They are already joined — that IS the connection — so the right depiction is nothing at all. The
        // router used to answer with a wire from a point to itself and then report it as one it could not
        // draw at right angles, which raised the module's own warning over a connection that is perfect.
        const circuit = sheet([R('r1', 'a', 'b'), R('r2', 'b', 'c')], ['a', 'b', 'c']);
        // END TO END, which is how this actually happens: a resistor's pins are at its two ends, so parts
        // dropped on the same centre do NOT touch — parts abutted do. The premise below is asserted rather
        // than assumed, because a sheet where the case never arose would pass this test without testing it.
        const placed = placeParts(circuit, { r1: { x: 200, y: 200 }, r2: { x: 240, y: 200 } });
        const nets = netsOf(circuit, placed);
        const shared = nets.find((n) => n.id === 'b')!;
        // The premise: the two terminals really are on the same point. Without this the test would pass on a
        // sheet where the case never arose.
        expect(shared.pins.length).toBeGreaterThan(1);
        const [first, ...rest] = shared.pins;
        expect(rest.some((p) => p.x === first!.x && p.y === first!.y)).toBe(true);

        const { wires, fellBack } = routeSheet(nets, bodiesOf(placed));
        expect(wires.filter((w) => w.netId === 'b')).toEqual([]);
        expect(fellBack.filter((f) => f.netId === 'b')).toEqual([]);
    });

    it('still draws the OTHER spokes of a net that has a coincident pair', () => {
        // Skipping the pair must not skip the net. A third terminal somewhere else is still owed a wire, and
        // dropping it would turn a cosmetic fix into a missing connection — which is the worse lie.
        const circuit = sheet([R('r1', 'a', 'n'), R('r2', 'n', 'b'), R('r3', 'n', 'c')], ['a', 'n', 'b', 'c']);
        const placed = placeParts(circuit, {
            r1: { x: 200, y: 200 },
            r2: { x: 240, y: 200 }, // abutted, so r1's second pin and r2's first are the same point
            r3: { x: 500, y: 400 },
        });
        const nets = netsOf(circuit, placed);
        const { wires } = routeSheet(nets, bodiesOf(placed));
        const drawn = wires.filter((w) => w.netId === 'n');
        expect(drawn.length).toBeGreaterThan(0);
        for (const w of drawn) expect(w.points.length).toBeGreaterThan(1);
    });
});
