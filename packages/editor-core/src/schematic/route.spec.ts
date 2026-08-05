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
    it('is deterministic, and depends on the order it was given rather than on anything hidden', () => {
        const nets: RouteNet[] = [
            { id: 'a', name: 'A', pins: [pin(0, 0, 'right'), pin(200, 40, 'left')] },
            { id: 'b', name: 'B', pins: [pin(0, 40, 'right'), pin(200, 0, 'left')] },
            { id: 'c', name: 'C', pins: [pin(0, 80, 'right'), pin(200, 80, 'left'), pin(100, 200, 'top')] },
        ];
        const once = routeSheet(nets, [box(90, 20, 130, 60)]);
        const twice = routeSheet(nets, [box(90, 20, 130, 60)]);
        expect(twice).toEqual(once);
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
     * symbols — and then every route out of one entered a body and the invariant reported a defect the router
     * had no way to avoid and would never meet. The generator was measuring a sheet that cannot exist.
     *
     * Parts sit in non-overlapping cells and carry their terminals on their own edges, exactly as placement
     * and `symbolFor` produce them. Nets are then drawn from the terminals that exist. The awkwardness worth
     * generating is in WHICH terminals share a node and how crowded the result is, not in impossible geometry.
     */
    const sheet = (seed: number): { nets: RouteNet[]; bodies: Box[] } => {
        const r = rng(seed);
        const pick = (n: number) => Math.floor(r() * n);

        const bodies: Box[] = [];
        const terminals: RoutePin[] = [];
        const PARTS = 12;
        for (let i = 0; i < PARTS; i++) {
            const [cx, cy] = [(i % 4) * 160 + 20, Math.floor(i / 4) * 140 + 20];
            const [w, h] = [40 + pick(3) * PIN_GRID, 30 + pick(3) * PIN_GRID];
            bodies.push(box(cx, cy, cx + w, cy + h));
            // Terminals on the body edges, on the lattice, the way a symbol declares them.
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

    it('holds on 300 sheets', () => {
        const broken: unknown[] = [];
        let orthogonal = 0;
        let total = 0;
        let declared = 0;

        for (let seed = 1; seed <= 300; seed++) {
            const { nets, bodies } = sheet(seed);
            const { wires, fellBack } = routeSheet(nets, bodies);
            const allPins = nets.flatMap((n) => n.pins.map((q) => ({ ...q, netId: n.id })));
            // A wire the module DECLARED it could not draw honestly is not a silent lie, and silence is the
            // thing being tested. It is counted instead, and the count is asserted below — an escape hatch
            // nobody watches is just a slower way of hiding the same defect.
            const undrawable = new Set(fellBack.filter((f) => f.reason === 'no-legible-route').map((f) => f.key));
            declared += undrawable.size;

            for (const s of segments(wires.filter((w) => !undrawable.has(w.key)))) {
                total++;
                if (isDiagonal(s)) continue; // the honest fallback answers to none of the rules below
                orthogonal++;

                const h = s.y1 === s.y2;
                const at = (q: { x: number; y: number }) => (h ? q.x : q.y);
                const [from, to] = h
                    ? [Math.min(s.x1, s.x2), Math.max(s.x1, s.x2)]
                    : [Math.min(s.y1, s.y2), Math.max(s.y1, s.y2)];

                // 1. It touches no terminal of any other net.
                for (const q of allPins)
                    if (q.netId !== s.netId && (h ? q.y === s.y1 : q.x === s.x1) && at(q) >= from && at(q) <= to)
                        broken.push({ seed, why: 'touches a foreign terminal', segment: s, pin: q });

                // 2. It enters no symbol.
                for (const bx of bodies)
                    if (
                        Math.min(s.x1, s.x2) < bx.maxX &&
                        Math.max(s.x1, s.x2) > bx.minX &&
                        Math.min(s.y1, s.y2) < bx.maxY &&
                        Math.max(s.y1, s.y2) > bx.minY
                    )
                        broken.push({ seed, why: 'passes through a symbol', segment: s, body: bx });

                // 3. It shares no run with a different net.
                for (const t2 of segments(wires.filter((w) => !undrawable.has(w.key))))
                    if (t2.netId !== s.netId && !isDiagonal(t2) && (t2.y1 === t2.y2) === h) {
                        const same = h ? t2.y1 === s.y1 : t2.x1 === s.x1;
                        const [tf, tt] = h
                            ? [Math.min(t2.x1, t2.x2), Math.max(t2.x1, t2.x2)]
                            : [Math.min(t2.y1, t2.y2), Math.max(t2.y1, t2.y2)];
                        if (same && Math.min(to, tt) > Math.max(from, tf))
                            broken.push({ seed, why: 'shares a run with another net', a: s, b: t2 });
                    }
            }
        }

        expect(broken.slice(0, 3)).toEqual([]);
        // The router must also DO something. An implementation that declared every wire undrawable, or
        // returned a diagonal every time, would satisfy every rule above and be worthless — so the yield is
        // asserted too. This is the measuring device checking it is pointed at what it claims to measure.
        expect({
            orthogonal: orthogonal / total > 0.9,
            declared,
            sampled: total > 2000,
        }).toEqual({ orthogonal: true, declared: 0, sampled: true });
    });
});

describe('cost', () => {
    it('routes a large sheet without the work exploding', () => {
        // 400 parts, ~1200 terminals — the size at which the naive form (wires × candidates × segments ×
        // terminals) becomes tens of millions of comparisons per keystroke. This runs inside a `useMemo` on
        // every document change, so "eventually finishes" is not the bar.
        const nets: RouteNet[] = [];
        const bodies: Box[] = [];
        for (let i = 0; i < 400; i++) {
            const [x, y] = [(i % 20) * 120, Math.floor(i / 20) * 120];
            bodies.push(box(x, y, x + 60, y + 40));
            nets.push({
                id: `n${i}`,
                name: `N${i}`,
                pins: [
                    pin(x - 10, y + 20, 'left', 'a'),
                    pin(x + 70, y + 20, 'right', 'b'),
                    pin(x + 30, y + 60, 'bottom', 'c'),
                ],
            });
        }
        const started = process.hrtime.bigint();
        const { wires } = routeSheet(nets, bodies);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;

        expect(wires).toHaveLength(800);
        // Generous by an order of magnitude, because a wall-clock bound on shared CI hardware measures the
        // hardware as much as the code. It is here to catch a return to quadratic behaviour, which would
        // blow through this by 50×, not to police milliseconds.
        expect({ ms: ms < 2000 }).toEqual({ ms: true });
    });
});
