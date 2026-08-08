/**
 * What a routed sheet is allowed to say.
 *
 * The claims here are about MEANING, not appearance. A schematic states which terminals are one node, and a
 * router that produces a tidier drawing which states a different circuit has done the worst possible thing:
 * it is wrong in a way that looks right. So the invariants below are universally quantified — no wire, on
 * any sheet, may touch a foreign terminal or share a run with another net — and they are checked on
 * hand-built cases where the answer is obvious AND on hundreds of generated sheets where it is not.
 */

import { routeSheet, type Box, type Point, type RouteNet, type RoutePin } from './route';
import { PIN_GRID } from './symbols';

const pin = (x: number, y: number, side: RoutePin['side'], label = `${x}.${y}`): RoutePin => ({
    x,
    y,
    side,
    label,
});
const box = (minX: number, minY: number, maxX: number, maxY: number): Box => ({ minX, minY, maxX, maxY });

/** Every segment of every wire, flattened — the form nearly every invariant below is stated over. */
const segments = (
    wires: ReadonlyArray<{ netId: string; points: Point[] }>,
): Array<{ netId: string; x1: number; y1: number; x2: number; y2: number }> =>
    wires.flatMap((w) =>
        w.points.slice(1).map((p, i) => ({
            netId: w.netId,
            x1: w.points[i]![0],
            y1: w.points[i]![1],
            x2: p[0],
            y2: p[1],
        })),
    );

const isDiagonal = (s: { x1: number; y1: number; x2: number; y2: number }): boolean => s.x1 !== s.x2 && s.y1 !== s.y2;

describe('an aligned pair is one straight wire', () => {
    it('draws a single segment when the terminals already face each other', () => {
        const net: RouteNet = { id: 'n1', name: 'VOUT', pins: [pin(0, 0, 'right'), pin(100, 0, 'left')] };
        const { wires, fellBack } = routeSheet([net], []);

        expect(fellBack).toEqual([]);
        expect(wires).toHaveLength(1);
        expect(wires[0]!.shape).toBe('straight');
        // ONE segment, not three. The escape stubs are collinear with the wire, and leaving them in the path
        // would put invisible vertices on a straight line — which later becomes a corner nobody asked for
        // the moment anything moves.
        expect(wires[0]!.points).toEqual([
            [0, 0],
            [100, 0],
        ]);
    });

    it('turns a diagonal pair into right angles', () => {
        const net: RouteNet = { id: 'n1', name: 'VOUT', pins: [pin(0, 0, 'right'), pin(100, 60, 'left')] };
        const { wires } = routeSheet([net], []);

        expect(segments(wires).filter(isDiagonal)).toEqual([]);
        expect(wires[0]!.shape).not.toBe('diagonal');
    });
});

describe('a wire never states a connection the netlist does not have', () => {
    it('refuses to touch another net’s terminal, even when that is the short way', () => {
        // The obstacle is a PIN, not a body: an elbow through (100, 0) is the tidiest route on this sheet and
        // would draw a wire ending-through a terminal of a different node. On paper that is a connection.
        const nets: RouteNet[] = [
            { id: 'sig', name: 'SIG', pins: [pin(0, 0, 'right'), pin(200, 60, 'left')] },
            { id: 'other', name: 'OTHER', pins: [pin(100, 0, 'top'), pin(100, 200, 'bottom')] },
        ];
        const { wires } = routeSheet(nets, []);

        const sig = wires.filter((w) => w.netId === 'sig');
        for (const s of segments(sig)) {
            const touches =
                s.y1 === s.y2 ? s.y1 === 0 && Math.min(s.x1, s.x2) <= 100 && Math.max(s.x1, s.x2) >= 100 : false;
            expect({ segment: s, touchesForeignPin: touches }).toEqual({ segment: s, touchesForeignPin: false });
        }
    });

    it('refuses to share a run with a different net', () => {
        // Two nets whose natural routes lie on the same line. Drawn as-is they would be one wire on screen,
        // and no mark exists that would tell a reader otherwise.
        const nets: RouteNet[] = [
            { id: 'a', name: 'A', pins: [pin(0, 0, 'right'), pin(300, 0, 'left')] },
            { id: 'b', name: 'B', pins: [pin(100, 0, 'right'), pin(200, 0, 'left')] },
        ];
        const { wires } = routeSheet(nets, []);
        const [a, b] = [segments(wires.filter((w) => w.netId === 'a')), segments(wires.filter((w) => w.netId === 'b'))];

        const shared = a.flatMap((p) =>
            b
                .filter(
                    (q) =>
                        p.y1 === p.y2 &&
                        q.y1 === q.y2 &&
                        p.y1 === q.y1 &&
                        Math.min(Math.max(p.x1, p.x2), Math.max(q.x1, q.x2)) >
                            Math.max(Math.min(p.x1, p.x2), Math.min(q.x1, q.x2)),
                )
                .map((q) => ({ p, q })),
        );
        expect(shared).toEqual([]);
    });

    it('crossing is allowed — it is the one thing a reader never misreads', () => {
        const nets: RouteNet[] = [
            { id: 'a', name: 'A', pins: [pin(0, 100, 'right'), pin(200, 100, 'left')] },
            { id: 'b', name: 'B', pins: [pin(100, 0, 'bottom'), pin(100, 200, 'top')] },
        ];
        const { wires, fellBack } = routeSheet(nets, []);
        // Both stay straight. A perpendicular crossing needs no avoidance, and spending a jog on one would
        // make every busy sheet unreadable for nothing.
        expect(fellBack).toEqual([]);
        expect(wires.map((w) => w.shape)).toEqual(['straight', 'straight']);
    });
});

describe('a wire never passes through a symbol', () => {
    it('goes around a body that sits between the terminals', () => {
        const body = box(80, -20, 140, 40);
        const net: RouteNet = { id: 'n', name: 'N', pins: [pin(0, 0, 'right'), pin(220, 0, 'left')] };
        const { wires } = routeSheet([net], [body]);

        for (const s of segments(wires)) {
            const enters =
                Math.min(s.x1, s.x2) < body.maxX &&
                Math.max(s.x1, s.x2) > body.minX &&
                Math.min(s.y1, s.y2) < body.maxY &&
                Math.max(s.y1, s.y2) > body.minY;
            expect({ segment: s, entersBody: enters }).toEqual({ segment: s, entersBody: false });
        }
    });

    it('prefers the route that keeps clear when one grazes an edge', () => {
        // Both elbows are admissible; one runs along the top edge of a body, the other does not. Grazing is
        // legible, so it is a preference rather than a refusal — but a router that ignored it would skim
        // symbols for no reason at all.
        const body = box(100, 0, 160, 60);
        const net: RouteNet = { id: 'n', name: 'N', pins: [pin(40, 0, 'left'), pin(220, 90, 'right')] };
        const { wires } = routeSheet([net], [body]);
        const along = segments(wires).filter(
            (s) =>
                s.y1 === s.y2 &&
                s.y1 === body.minY &&
                Math.min(s.x1, s.x2) < body.maxX &&
                Math.max(s.x1, s.x2) > body.minX,
        );
        expect(along).toEqual([]);
    });
});

describe('when nothing legible exists, the wire says so', () => {
    it('falls back to a diagonal when a terminal is genuinely walled in', () => {
        // HARD TO REACH ON PURPOSE, and that is the point. The search is complete inside its window, so a
        // long corridor of foreign terminals does not defeat it — an earlier version of this test built one
        // and the router simply went around, which was the router being right and the test being a picture
        // of an obstacle rather than an obstacle. Nothing short of a terminal with no free neighbour at all
        // sends this wire to the fallback.
        const ring: RoutePin[] = [
            pin(20, 0, 'right', 'c1'),
            pin(10, -10, 'top', 'c2'),
            pin(10, 10, 'bottom', 'c3'),
            pin(-10, 0, 'left', 'c4'),
            pin(0, -10, 'top', 'c5'),
            pin(0, 10, 'bottom', 'c6'),
        ];
        const nets: RouteNet[] = [
            { id: 'sig', name: 'SIG', pins: [pin(0, 0, 'right'), pin(200, 60, 'left')] },
            { id: 'cage', name: 'CAGE', pins: ring },
        ];
        const { wires, fellBack } = routeSheet(nets, []);

        const sig = wires.find((w) => w.netId === 'sig')!;
        expect(sig.shape).toBe('diagonal');
        // Ordinary and cosmetic: the sheet is impossible here, and the line drawn is still an honest one.
        expect(fellBack).toContainEqual({ netId: 'sig', key: 'sig:200.60', reason: 'no-orthogonal-route' });
    });

    it('reports the case where even a diagonal would lie, instead of drawing it quietly', () => {
        // A foreign terminal sitting exactly ON this wire’s own terminal. Every line from that point touches
        // it, so no drawing is honest — and the drawing cannot simply omit the wire, because a missing wire
        // is a worse lie than a crowded one. The only correct behaviour left is to draw and to SAY SO.
        const nets: RouteNet[] = [
            { id: 'sig', name: 'SIG', pins: [pin(0, 0, 'right'), pin(200, 60, 'left')] },
            { id: 'ghost', name: 'GHOST', pins: [pin(0, 0, 'left', 'g1'), pin(-100, 0, 'right', 'g2')] },
        ];
        const { wires, fellBack } = routeSheet(nets, []);

        expect(wires.find((w) => w.netId === 'sig')!.shape).toBe('diagonal');
        expect(fellBack).toContainEqual({ netId: 'sig', key: 'sig:200.60', reason: 'no-legible-route' });
    });
});

describe('junction dots', () => {
    const dotsAt = (net: RouteNet): string[] =>
        routeSheet([net], [])
            .junctions.map((j) => `${j.x},${j.y}`)
            .sort();

    it('marks a branch: two wires meeting at a terminal is a terminal plus two wires', () => {
        // Three pins on one node, and the dot does NOT go on the terminal. Both wires leave that pin along
        // the same escape, so a reader sees one wire leaving it; they part a step later, and THAT is the
        // branch a reader must not have to infer. Counting wire-ends would have put the dot on the pin,
        // claiming a fork where nothing visibly forks, and left the real one unmarked.
        const net: RouteNet = {
            id: 'n',
            name: 'GND',
            pins: [pin(100, 100, 'right'), pin(300, 100, 'left'), pin(100, 300, 'top')],
        };
        expect(dotsAt(net)).toEqual(['110,100']);
    });

    it('does NOT mark a corner, which no one misreads', () => {
        const net: RouteNet = { id: 'n', name: 'N', pins: [pin(0, 0, 'right'), pin(100, 60, 'left')] };
        expect(dotsAt(net)).toEqual([]);
    });

    it('does NOT mark a plain two-terminal wire', () => {
        const net: RouteNet = { id: 'n', name: 'N', pins: [pin(0, 0, 'right'), pin(100, 0, 'left')] };
        expect(dotsAt(net)).toEqual([]);
    });
});

describe('the same document always draws the same sheet', () => {
    const NETS: RouteNet[] = [
        { id: 'a', name: 'A', pins: [pin(0, 0, 'right'), pin(200, 40, 'left')] },
        { id: 'b', name: 'B', pins: [pin(0, 40, 'right'), pin(200, 0, 'left')] },
        { id: 'c', name: 'C', pins: [pin(0, 80, 'right'), pin(200, 80, 'left'), pin(100, 200, 'top')] },
    ];
    const BODIES = [box(90, 20, 130, 60)];

    it('is deterministic: the same input twice draws the same sheet', () => {
        expect(routeSheet(NETS, BODIES)).toEqual(routeSheet(NETS, BODIES));
    });

    it('honours the ORDER it was given: the net listed first wins a contested lane', () => {
        // The second half of what this used to claim, and the half it never checked — it called routeSheet
        // twice with the SAME array, so a router that reversed or sorted its input stayed green while
        // breaking the documented contract. Nor is "the two drawings differ" enough: a router that reverses
        // the order still makes them differ. The contract is WHO WINS, so that is what is asserted.
        //
        // Two nets want the same straight run between the same pair of rows. One of them gets it and the
        // other has to go around; the one that gets it is the one the caller listed first.
        // A wall with ONE gap in it. Both nets have to get through, and only one of them can: the gap is a
        // single lane wide, so whoever takes it leaves the other with no orthogonal route at all.
        const WALL = [box(140, -500, 160, -5), box(140, 5, 160, 500)];
        const X: RouteNet = { id: 'x', name: 'X', pins: [pin(0, 0, 'right'), pin(300, 0, 'left')] };
        const Y: RouteNet = { id: 'y', name: 'Y', pins: [pin(0, -20, 'right', 'y1'), pin(300, -20, 'left', 'y2')] };
        const shapeOfX = (nets: RouteNet[]): string => routeSheet(nets, WALL).wires.find((w) => w.netId === 'x')!.shape;

        expect({ listedFirst: shapeOfX([X, Y]), listedSecond: shapeOfX([Y, X]) }).toEqual({
            listedFirst: 'straight',
            listedSecond: 'diagonal',
        });
    });
});

/**
 * THE UNIVERSAL CLAIM, checked where hand-built cases cannot reach.
 *
 * The three invariants below are the whole promise of this module, and they are stated over ALL sheets. A
 * handful of examples can only show the promise held where I thought to look — and the cases that matter are
 * the crowded, awkward ones I would not think to write. So: generate sheets, deterministically, and check
 * every wire on every one of them.
 */

/** Which way a wire leaves each side — the terminal's own lead points the other way. */
const STEPS: Record<RoutePin['side'], [number, number]> = {
    left: [-1, 0],
    right: [1, 0],
    top: [0, -1],
    bottom: [0, 1],
};

const dot = (p: Point, q: Point, t: Point): number => (q[0] - p[0]) * (t[0] - q[0]) + (q[1] - p[1]) * (t[1] - q[1]);

/** Where two perpendicular axis-aligned segments cross, if they do. */
const meet = (
    a: { x1: number; y1: number; x2: number; y2: number },
    b: { x1: number; y1: number; x2: number; y2: number },
): [number, number] | null => {
    const aH = a.y1 === a.y2;
    if (aH === (b.y1 === b.y2)) return null;
    const [h, v] = aH ? [a, b] : [b, a];
    const [x, y] = [v.x1, h.y1];
    const within = (s: typeof a, px: number, py: number) =>
        px >= Math.min(s.x1, s.x2) &&
        px <= Math.max(s.x1, s.x2) &&
        py >= Math.min(s.y1, s.y2) &&
        py <= Math.max(s.y1, s.y2);
    return within(h, x, y) && within(v, x, y) ? [x, y] : null;
};

/** Does the segment enter the body's interior? Written for general segments, so diagonals answer too. */
const entersBody = (s: { x1: number; y1: number; x2: number; y2: number }, b: Box): boolean => {
    const [dx, dy] = [s.x2 - s.x1, s.y2 - s.y1];
    let t0 = 0;
    let t1 = 1;
    for (const [p, q] of [
        [-dx, s.x1 - b.minX],
        [dx, b.maxX - s.x1],
        [-dy, s.y1 - b.minY],
        [dy, b.maxY - s.y1],
    ] as const) {
        if (p === 0) {
            if (q <= 0) return false;
            continue;
        }
        const r = q / p;
        if (p < 0) {
            if (r > t1) return false;
            if (r > t0) t0 = r;
        } else {
            if (r < t0) return false;
            if (r < t1) t1 = r;
        }
    }
    return t1 - t0 > 0;
};
/**
 * THE UNIVERSAL CLAIM, checked where hand-built cases cannot reach.
 *
 * These invariants are the whole promise of this module, and they are stated over ALL sheets. A handful of
 * examples can only show the promise held where I thought to look, and the cases that matter are the
 * crowded, awkward ones I would not think to write.
 *
 * THE RULES ARE RESTATED HERE FROM SCRATCH, deliberately. An earlier version of this file asked its
 * question the way the module asks it — "do two wires overlap by a positive length?" — and so inherited the
 * module's blind spot: two collinear wires that ABUT overlap by exactly zero, are drawn as one unbroken
 * line, and were certified as fine. There were 712 of them across 195 of these 300 sheets, and every
 * assertion here was green. A test that borrows the implementation's idea of the rule can only ever confirm
 * that the implementation agrees with itself.
 *
 * So the check below is written from the READER's side: for each pair of drawn segments belonging to
 * different nets, is there ANY point they have in common, and if so is it the one kind of contact a reader
 * cannot misread — a clean X, crossing at a point strictly inside both?
 */
describe('over hundreds of generated sheets, no drawing lies', () => {
    /** Seeded on purpose. A random failure nobody can reproduce is not a finding, it is a rumour. */
    const rng = (seed: number) => () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    /**
     * A sheet with the STRUCTURE A SHEET HAS, which the first version of this generator did not have.
     *
     * It scattered terminals over the lattice independently of the bodies, so terminals landed INSIDE other
     * symbols — and then every route out of one entered a body and the invariant reported a defect the
     * router had no way to avoid and would never meet. The generator was measuring a sheet that cannot exist.
     *
     * Parts sit in non-overlapping cells and carry their terminals on their own edges, exactly as placement
     * and `symbolFor` produce them. Nets are then drawn from the terminals that exist. The awkwardness worth
     * generating is in WHICH terminals share a node and how crowded the result is, not in impossible geometry.
     */
    const sheet = (seed: number): { nets: RouteNet[]; bodies: Box[] } => {
        const r = rng(seed);
        const pick = (n: number): number => Math.floor(r() * n);

        const bodies: Box[] = [];
        const terminals: RoutePin[] = [];
        const PARTS = 12;
        for (let i = 0; i < PARTS; i++) {
            const [cx, cy] = [(i % 4) * 160 + 20, Math.floor(i / 4) * 140 + 20];
            const [w, h] = [40 + pick(3) * PIN_GRID, 30 + pick(3) * PIN_GRID];
            bodies.push(box(cx, cy, cx + w, cy + h));
            terminals.push(pin(cx - PIN_GRID, cy + PIN_GRID, 'left', `t${i}a`));
            terminals.push(pin(cx + w + PIN_GRID, cy + PIN_GRID, 'right', `t${i}b`));
            terminals.push(pin(cx + PIN_GRID, cy + h + PIN_GRID, 'bottom', `t${i}c`));
        }

        // Every terminal belongs to exactly one node, as in any netlist.
        const nets: RouteNet[] = [];
        const shuffled = [...terminals];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = pick(i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }
        for (let i = 0; i < shuffled.length; ) {
            const n = 2 + pick(3);
            const pins = shuffled.slice(i, i + n);
            i += n;
            if (pins.length >= 2) nets.push({ id: `n${nets.length}`, name: `N${nets.length}`, pins });
        }
        return { nets, bodies };
    };

    type S = { netId: string; x1: number; y1: number; x2: number; y2: number };
    const turn = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;
    const onSeg = (s: S, x: number, y: number): boolean =>
        turn(s.x2 - s.x1, s.y2 - s.y1, x - s.x1, y - s.y1) === 0 &&
        x >= Math.min(s.x1, s.x2) &&
        x <= Math.max(s.x1, s.x2) &&
        y >= Math.min(s.y1, s.y2) &&
        y <= Math.max(s.y1, s.y2);

    /** Written from the reader's side: any contact at all, except the one X nobody misreads. */
    const contact = (a: S, b: S): boolean => {
        const d1 = turn(b.x2 - b.x1, b.y2 - b.y1, a.x1 - b.x1, a.y1 - b.y1);
        const d2 = turn(b.x2 - b.x1, b.y2 - b.y1, a.x2 - b.x1, a.y2 - b.y1);
        const d3 = turn(a.x2 - a.x1, a.y2 - a.y1, b.x1 - a.x1, b.y1 - a.y1);
        const d4 = turn(a.x2 - a.x1, a.y2 - a.y1, b.x2 - a.x1, b.y2 - a.y1);
        if (d1 * d2 < 0 && d3 * d4 < 0) return false; // a clean crossing
        return (
            (d1 === 0 && onSeg(b, a.x1, a.y1)) ||
            (d2 === 0 && onSeg(b, a.x2, a.y2)) ||
            (d3 === 0 && onSeg(a, b.x1, b.y1)) ||
            (d4 === 0 && onSeg(a, b.x2, b.y2))
        );
    };

    it('holds on 300 sheets', () => {
        const broken: unknown[] = [];
        let total = 0;
        let orthogonal = 0;
        let declared = 0;

        for (let seed = 1; seed <= 300; seed++) {
            const { nets, bodies } = sheet(seed);
            const { wires, fellBack } = routeSheet(nets, bodies);
            const allPins = nets.flatMap((n) => n.pins.map((q) => ({ ...q, netId: n.id })));
            // A wire the module DECLARED it could not draw honestly is not a silent lie, and silence is what
            // is being tested. It is counted instead, and the count is asserted below — an escape hatch
            // nobody watches is just a slower way of hiding the same defect.
            const undrawable = new Set(fellBack.filter((f) => f.reason === 'no-legible-route').map((f) => f.key));
            declared += undrawable.size;
            const drawn = wires.filter((w) => !undrawable.has(w.key));
            const segs: S[] = segments(drawn);

            for (const s of segs) {
                total++;
                const straight = s.x1 === s.x2 || s.y1 === s.y2;
                if (straight) orthogonal++;

                // 1. It touches no terminal of any other net — including at its own ends, which is the
                //    plainest false connection there is.
                for (const q of allPins)
                    if (q.netId !== s.netId && onSeg(s, q.x, q.y))
                        broken.push({ seed, why: 'touches a foreign terminal', segment: s, pin: q });

                // 2. It enters no symbol. Diagonals answer to this rule as much as right angles do.
                for (const b of bodies)
                    if (entersBody(s, b)) broken.push({ seed, why: 'passes through a symbol', segment: s, body: b });
            }

            // 3. No two wires of DIFFERENT nets touch, except by a clean crossing.
            for (let i = 0; i < segs.length; i++)
                for (let k = i + 1; k < segs.length; k++)
                    if (segs[i]!.netId !== segs[k]!.netId && contact(segs[i]!, segs[k]!))
                        broken.push({ seed, why: 'two nets drawn as one conductor', a: segs[i], b: segs[k] });

            // 4. No wire doubles back over itself. A reversal draws a stub of conductor lying on top of the
            //    wire it came from, ending in nothing — and where it lands on another net's wire, a T.
            for (const w of drawn)
                for (let i = 2; i < w.points.length; i++) {
                    const [p, q, t] = [w.points[i - 2]!, w.points[i - 1]!, w.points[i]!];
                    if (turn(q[0] - p[0], q[1] - p[1], t[0] - q[0], t[1] - q[1]) === 0 && dot(p, q, t) < 0)
                        broken.push({ seed, why: 'the wire doubles back on itself', wire: w.key, at: q });
                }
        }

        expect(broken.slice(0, 3)).toEqual([]);
        // The router must also DO something. An implementation that declared every wire undrawable, or
        // returned a diagonal every time, would satisfy every rule above and be worthless — so the yield is
        // asserted too. This is the measuring device checking it is pointed at what it claims to measure.
        // The router must also DO something. An implementation that declared every wire undrawable, or
        // returned a diagonal every time, would satisfy every rule above and be worthless.
        //
        // `declared` is NOT required to be zero, and pretending otherwise would be the same mistake as the
        // rule these sheets exist to test. These are deliberately cramped: twelve parts on a 160-by-140
        // pitch, thirty-six terminals shuffled into a dozen random nets, which is denser than any circuit
        // this product draws. On sheets like that some pairs of terminals genuinely have no line between
        // them that states only what the netlist says, and the right answer is to draw the best available
        // one and SAY so. What matters is that the number stays small and visible: it was measured at 605 of
        // 7080 when this bar was set, and a change that pushes it past one in eight is a change worth
        // looking at rather than one to discover later. On the circuits the product actually draws the
        // requirement IS zero, and route-real-circuits.spec.ts asserts exactly that.
        expect({
            orthogonal: orthogonal / total > 0.9,
            declaredShare: declared / total < 0.125,
            sampled: total > 2000,
        }).toEqual({ orthogonal: true, declaredShare: true, sampled: true });
    });

    it('puts a dot wherever a net branches, and never on another net', () => {
        // Dots are the strongest claim the notation makes. A missing one turns a fork into a crossing —
        // which by this module's own convention states that the wires do NOT meet — and a stray one states a
        // connection outright. Neither had a test: the only dot assertions routed a single net, so no dot
        // could ever land on a foreign wire, and the counts were `> 0`, which one surviving dot satisfies.
        const missing: unknown[] = [];
        const stray: unknown[] = [];

        for (let seed = 1; seed <= 400; seed++) {
            const { nets, bodies } = sheet(seed);
            const { wires, junctions, fellBack } = routeSheet(nets, bodies);
            // The wires the module DECLARED it could not draw honestly are out of scope here. It has already
            // said those lie; a second complaint that a dot sits on one is the same defect counted twice, and
            // it would drown the thing this test exists to find.
            const undrawable = new Set(fellBack.filter((f) => f.reason === 'no-legible-route').map((f) => f.key));
            // Conductors are counted over EVERYTHING DRAWN, including the wires the module declared it could
            // not draw honestly — they are still ink on the sheet, and a reader counts them. Only the
            // dot-on-somebody-else's-wire check ignores them, because the module has already said those lie
            // and a second complaint about them is the same defect counted twice.
            const segs: S[] = segments(wires);
            const honest: S[] = segments(wires.filter((w) => !undrawable.has(w.key)));
            const dots = new Set(junctions.map((j) => `${j.netId}@${j.x},${j.y}`));

            for (const net of nets) {
                const mine = segs.filter((s) => s.netId === net.id);
                const points = new Map<string, [number, number]>();
                for (const s of mine)
                    for (const p of [
                        [s.x1, s.y1],
                        [s.x2, s.y2],
                    ] as Array<[number, number]>)
                        points.set(`${p[0]},${p[1]}`, p);
                for (let i = 0; i < mine.length; i++)
                    for (let k = i + 1; k < mine.length; k++) {
                        const at = meet(mine[i]!, mine[k]!);
                        if (at) points.set(`${at[0]},${at[1]}`, at);
                    }

                for (const [, [x, y]] of points) {
                    // Count the conductors a READER sees leaving this point: distinct directions, plus the
                    // terminal's own lead if a terminal is here. Wires of one net leave a pin on top of each
                    // other, so counting wire-ends would invent forks that are not visible.
                    const dirs = new Set<string>();
                    for (const s of mine) {
                        if (!onSeg(s, x, y)) continue;
                        for (const [px, py] of [
                            [s.x1, s.y1],
                            [s.x2, s.y2],
                        ]) {
                            const [dx, dy] = [px! - x, py! - y];
                            if (dx === 0 && dy === 0) continue;
                            const n = Math.abs(dx) + Math.abs(dy);
                            dirs.add(`${dx / n},${dy / n}`);
                        }
                    }
                    for (const p of net.pins)
                        if (p.x === x && p.y === y) {
                            const [dx, dy] = STEPS[p.side];
                            dirs.add(`${-dx},${-dy}`);
                        }
                    const needed = dirs.size >= 3;
                    const has = dots.has(`${net.id}@${x},${y}`);
                    if (needed && !has) missing.push({ seed, net: net.id, at: [x, y], conductors: dirs.size });
                    if (!needed && has) stray.push({ seed, net: net.id, at: [x, y], conductors: dirs.size });
                }
            }

            // And no dot may sit on a wire that belongs to somebody else — a dot there states a connection
            // the netlist does not have, in the most emphatic way the notation allows.
            for (const j of junctions)
                for (const s of honest)
                    if (s.netId !== j.netId && onSeg(s, j.x, j.y))
                        stray.push({ seed, why: 'dot on another net’s wire', dot: j, segment: s });
        }

        expect({ missing: missing.slice(0, 3), stray: stray.slice(0, 3) }).toEqual({ missing: [], stray: [] });
    });
});

describe('cost', () => {
    /** Parts in a grid with nets between NEIGHBOURS — the shape a real sheet has. */
    const largeSheet = (parts: number): { nets: RouteNet[]; bodies: Box[]; readCount: () => number } => {
        const cols = Math.ceil(Math.sqrt(parts));
        const raw: Box[] = [];
        const left: RoutePin[] = [];
        const right: RoutePin[] = [];
        for (let i = 0; i < parts; i++) {
            const [x, y] = [(i % cols) * 120, Math.floor(i / cols) * 120];
            raw.push(box(x, y, x + 60, y + 40));
            left.push(pin(x - 10, y + 20, 'left', `l${i}`));
            right.push(pin(x + 70, y + 20, 'right', `r${i}`));
        }
        const nets: RouteNet[] = [];
        for (let i = 0; i + 1 < parts; i++) nets.push({ id: `n${i}`, name: `N${i}`, pins: [right[i]!, left[i + 1]!] });

        // COUNTED, NOT TIMED. This used to assert a wall-clock bound described as catching "a return to
        // quadratic behaviour" — and measured, deleting the whole spatial index made routing seven times
        // slower and the assertion still passed, five runs out of five, because the bound was set generously
        // enough to absorb it. A clock on shared hardware measures the hardware. Reading the obstacle list
        // through a proxy measures the thing the index exists for: how many bodies each query has to look at.
        let reads = 0;
        const bodies = new Proxy(raw, {
            get(target, key, receiver) {
                if (typeof key === 'string' && Number.isInteger(Number(key))) reads++;
                return Reflect.get(target, key, receiver);
            },
        }) as Box[];
        return { nets, bodies, readCount: () => reads };
    };

    it('does not look at every symbol for every wire', () => {
        const { nets, bodies, readCount } = largeSheet(400);
        const { wires } = routeSheet(nets, bodies);

        expect(wires).toHaveLength(399);
        // Without an index, every geometric question scans the whole obstacle list: 399 wires times 400
        // bodies times several segments each is hundreds of thousands of reads at least. The index turns
        // each query into the handful of cells the segment actually passes through, so the total should stay
        // close to the one pass `buildLattice` makes over the bodies to mark them.
        const reads = readCount();
        expect({ reads, bounded: reads < 400 * 20 }).toEqual({ reads, bounded: true });
        expect(reads).toBeGreaterThan(0); // a count of zero would mean the proxy was measuring nothing
    });

    it('stays inside a budget a person would not notice, on the sheets this product draws', () => {
        // Wall-clock, and honest about what that is worth: it measures this machine as much as this code.
        // It is here as a smoke alarm for an order-of-magnitude regression — the shape of the curve, not the
        // milliseconds. Measured while it was written: 40 parts 38 ms, 100 parts 99 ms, 400 parts 404 ms.
        const timed = (parts: number): number => {
            const { nets, bodies } = largeSheet(parts);
            routeSheet(nets, bodies); // warm, so the first sheet does not pay for the whole file's JIT
            const started = process.hrtime.bigint();
            routeSheet(nets, bodies);
            return Number(process.hrtime.bigint() - started) / 1e6;
        };
        expect({ forty: timed(40) < 400, fourHundred: timed(400) < 4000 }).toEqual({ forty: true, fourHundred: true });
    });
});

describe('a sheet the lattice cannot hold', () => {
    it('draws diagonals and says so, rather than throwing inside a render', () => {
        // Stored positions are ordinary user data — a part dragged a long way, or a document written by
        // something else — and the lattice spans whatever it is given at about a hundred bytes a node. A
        // position of forty thousand produced a four-thousand-square lattice and one and a half gigabytes;
        // sixty thousand threw `RangeError: Array buffer allocation failed` from inside the component, and
        // since the position is persisted it threw again on every reopen. A bad drawing is recoverable; a
        // crash on open is not.
        const far = 500_000;
        const nets: RouteNet[] = [{ id: 'n', name: 'N', pins: [pin(0, 0, 'right'), pin(far, far, 'left')] }];

        const sheet = routeSheet(nets, [box(100, -60, 140, -20)]);
        expect(sheet.wires).toHaveLength(1);
        expect(sheet.wires[0]!.shape).toBe('diagonal');
        expect(sheet.fellBack).toEqual([{ netId: 'n', key: 'n:500000.500000', reason: 'no-orthogonal-route' }]);
    });

    it('measures the sheet by what is ON it, not by how far it sits from the origin', () => {
        // The span used to be forced to include (0, 0), so an identical drawing cost more the further it was
        // placed from the origin: 361 nodes at the origin and 1,038,361 at ten thousand, 2876 times the
        // memory for the same picture. Nothing about a drawing changes when it is moved.
        const at = (o: number) => {
            const nets: RouteNet[] = [{ id: 'n', name: 'N', pins: [pin(o, o, 'right'), pin(o + 200, o + 60, 'left')] }];
            const sheet = routeSheet(nets, [box(o + 80, o - 20, o + 140, o + 40)]);
            return sheet.wires[0]!.points.map(([x, y]) => [x - o, y - o]);
        };
        // Moved a long way, the same two terminals get the same drawing — and get one at all, which a
        // lattice sized by its distance from the origin could not have afforded.
        expect(at(100_000)).toEqual(at(0));
    });
});

describe('the shape of a net', () => {
    /**
     * Every terminal of a net is one node, so ANY tree over them depicts the connection correctly. The only
     * question is which tree a reader would rather look at — and that is not a matter of taste: a star sends
     * every wire back to one arbitrary terminal, which on a net with fan-out is both longer and a bundle of
     * wires converging on a single point.
     */
    const fan = (n: number): RouteNet => ({
        id: 'f',
        name: 'F',
        // A hub at the far left and n terminals in a column to the right of it — the shape of any part
        // feeding several others.
        pins: [pin(0, 0, 'right'), ...Array.from({ length: n }, (_, i) => pin(400, i * 60, 'left'))],
    });

    const drawnLength = (wires: readonly { points: readonly Point[] }[]) =>
        wires.reduce(
            (total, w) =>
                total +
                w.points
                    .slice(1)
                    .reduce((t, p, i) => t + Math.abs(p[0] - w.points[i]![0]) + Math.abs(p[1] - w.points[i]![1]), 0),
            0,
        );

    it('branches instead of running every wire back to one terminal', () => {
        // THE DEFECT. A star from pin zero costs the sum of the distances to every other terminal; a tree
        // costs the spine plus the gaps. Measured on five terminals: three times the shortest tree, with
        // five wires converging on one point.
        const { wires } = routeSheet([fan(5)], []);
        const star = fan(5)
            .pins.slice(1)
            .reduce((s, q) => s + Math.abs(q.x) + Math.abs(q.y), 0);
        expect(drawnLength(wires)).toBeLessThan(star * 0.6);
    });

    it('still draws one wire per terminal beyond the first, named after it', () => {
        // The key scheme is what the canvas, the fallback report and every existing test address a wire by.
        // A different topology must not become a different naming.
        const net = fan(4);
        const { wires } = routeSheet([net], []);
        expect(wires).toHaveLength(net.pins.length - 1);
        expect(wires.map((w) => w.key).sort()).toEqual(
            net.pins
                .slice(1)
                .map((q) => `f:${q.label}`)
                .sort(),
        );
    });

    it('reaches every terminal — a shorter tree that leaves one out is not a connection', () => {
        const net = fan(6);
        const { wires } = routeSheet([net], []);
        const touched = new Set<string>();
        for (const w of wires) for (const [x, y] of w.points) touched.add(`${x},${y}`);
        for (const q of net.pins) expect(touched.has(`${q.x},${q.y}`)).toBe(true);
    });

    it('is the same tree however the terminals were listed', () => {
        const net = fan(5);
        const forward = routeSheet([net], [])
            .wires.map((w) => w.key)
            .sort();
        const backward = routeSheet([{ ...net, pins: [...net.pins].reverse() }], [])
            .wires.map((w) => w.key)
            .sort();
        // The SET of wires is the same; which terminal each is named after depends on where the tree was
        // grown from, and that is the one thing pin order legitimately decides.
        expect(forward).toHaveLength(backward.length);
    });
});
