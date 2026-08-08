/**
 * Every design this product actually ships, drawn and measured.
 *
 * Everything else in this directory tests the drawing against circuits written to exercise it — adversarial
 * sheets, generated ladders, four regression circuits. Those are worth having and they are not the product.
 * The API ships twenty-one templates, from a thirteen-part night light to a hundred-and-thirty-five-gate
 * 8-bit ALU, and until this file nothing had ever drawn one of them.
 *
 * The first run found the arrangement collapsing every digital design: the ALU came out with 1999 crossings
 * on 236 wires, which is a sheet nobody can read, because breadth-first layering saw eighteen supplies
 * touching everything and put the whole design one step from a source.
 *
 * WHAT IS ASSERTED, and why in this order:
 *
 *  1. NO WIRE LIES. Absolute, on every template. A drawing that states a connection the netlist does not
 *     have is the one failure this module exists to prevent, and it does not get a budget.
 *  2. Crossings and length are held against MEASURED numbers, not ideals. They are quality, not truth: the
 *     bar is that they do not silently get worse.
 *  3. Time is a smoke alarm for an order-of-magnitude regression, and honest about measuring this machine
 *     as much as this code.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { CircuitJson } from '@circuit-forge/eda-core';

import { bodiesOf, groundGlyphs, netsOf, placeParts, railGlyphs } from './layout';
import { routeSheet, type Box } from './route';

/**
 * The product's templates, read from where the API seeds them.
 *
 * A test-only reach across packages, and deliberate: copying them here would be a second set that goes stale
 * the moment somebody edits a template, and the whole value of this file is that it draws the REAL ones.
 */
const TEMPLATE_DIR = join(__dirname, '..', '..', '..', '..', 'apps', 'api', 'prisma', 'templates');

const templates = (): Array<{ name: string; circuit: CircuitJson }> =>
    readdirSync(TEMPLATE_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => {
            const raw = JSON.parse(readFileSync(join(TEMPLATE_DIR, f), 'utf8')) as {
                circuitJson?: CircuitJson;
            } & CircuitJson;
            return { name: f.replace('.json', ''), circuit: raw.circuitJson ?? raw };
        })
        .filter((t) => (t.circuit.components ?? []).length > 0);

interface Seg {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    net: string;
}

const det = (px: number, py: number, qx: number, qy: number) => px * qy - py * qx;

const onSeg = (s: Seg, x: number, y: number): boolean =>
    det(s.x2 - s.x1, s.y2 - s.y1, x - s.x1, y - s.y1) === 0 &&
    Math.min(s.x1, s.x2) <= x &&
    x <= Math.max(s.x1, s.x2) &&
    Math.min(s.y1, s.y2) <= y &&
    y <= Math.max(s.y1, s.y2);

const entersBody = (s: Seg, b: Box): boolean => {
    for (let i = 1; i < 64; i++) {
        const x = s.x1 + ((s.x2 - s.x1) * i) / 64;
        const y = s.y1 + ((s.y2 - s.y1) * i) / 64;
        if (x > b.minX && x < b.maxX && y > b.minY && y < b.maxY) return true;
    }
    return false;
};

/** Only a crossing strictly interior to both segments is legible; every other contact reads as one wire. */
const meeting = (a: Seg, b: Seg): 'apart' | 'crossing' | 'contact' => {
    const r = [a.x2 - a.x1, a.y2 - a.y1] as const;
    const t = [b.x2 - b.x1, b.y2 - b.y1] as const;
    const w = [b.x1 - a.x1, b.y1 - a.y1] as const;
    const den = det(r[0], r[1], t[0], t[1]);
    if (den === 0) {
        if (det(w[0], w[1], r[0], r[1]) !== 0) return 'apart';
        const len = r[0] * r[0] + r[1] * r[1];
        if (len === 0) return 'apart';
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

const draw = (circuit: CircuitJson) => {
    const placed = placeParts(circuit);
    const bodies = bodiesOf([...placed, ...groundGlyphs(circuit, placed), ...railGlyphs(circuit, placed)]);
    const nets = netsOf(circuit, placed);
    const { wires, fellBack } = routeSheet(nets, bodies);

    const undrawable = new Set(fellBack.filter((f) => f.reason === 'no-legible-route').map((f) => f.key));
    const drawn = wires.filter((w) => !undrawable.has(w.key));
    const segs: Seg[] = drawn.flatMap((w) =>
        w.points.slice(1).map((p, i) => ({
            x1: w.points[i]![0],
            y1: w.points[i]![1],
            x2: p[0],
            y2: p[1],
            net: w.netId,
        })),
    );
    const pins = nets.flatMap((n) => n.pins.map((q) => ({ ...q, netId: n.id })));

    const lies: string[] = [];
    let crossings = 0;
    for (const s of segs) {
        for (const q of pins)
            if (q.netId !== s.net && onSeg(s, q.x, q.y)) lies.push(`${s.net} touches a terminal of ${q.netId}`);
        for (const b of bodies)
            if (entersBody(s, b)) {
                lies.push(`${s.net} passes through a symbol`);
                break;
            }
    }
    for (let i = 0; i < segs.length; i++)
        for (let k = i + 1; k < segs.length; k++) {
            if (segs[i]!.net === segs[k]!.net) continue;
            const how = meeting(segs[i]!, segs[k]!);
            if (how === 'contact') lies.push(`${segs[i]!.net} and ${segs[k]!.net} drawn as one conductor`);
            else if (how === 'crossing') crossings++;
        }

    const length = drawn.reduce(
        (total, w) =>
            total +
            w.points
                .slice(1)
                .reduce((t, p, i) => t + Math.abs(p[0] - w.points[i]![0]) + Math.abs(p[1] - w.points[i]![1]), 0),
        0,
    );
    return { wires: wires.length, undrawable: undrawable.size, crossings, length, lies };
};

describe('the designs this product ships', () => {
    const all = templates();

    it('found the templates at all', () => {
        // A test that silently drew nothing would pass every assertion below. This is the device checking it
        // is pointed at something — the reach across packages is exactly the kind of path that goes stale.
        expect(all.length).toBeGreaterThan(15);
        expect(all.map((t) => t.name)).toContain('01-alu-8bit');
    });

    it('draws NO WIRE THAT LIES, on any of them', () => {
        // The one absolute. Everything else here is quality; this is truth, and it has no budget.
        const broken = all.flatMap((t) => draw(t.circuit).lies.slice(0, 2).map((why) => `${t.name}: ${why}`));
        expect(broken).toEqual([]);
    });

    it('keeps the analogue sheets clean and small', () => {
        // These are what the product produces most of, and they are the ones a person reads end to end.
        for (const name of ['03-power-amp', '05-ldo-linear-regulator', '17-ntc-thermostat-alarm']) {
            const t = all.find((x) => x.name === name)!;
            const m = draw(t.circuit);
            expect({ name, undrawable: m.undrawable, tooManyCrossings: m.crossings > 60 }).toEqual({
                name,
                undrawable: 0,
                tooManyCrossings: false,
            });
        }
    });

    it('holds the big digital sheets to what they were measured at', () => {
        // The ALU is four times the size of anything else here and it is the hardest case by a distance.
        // Breadth-first layering alone gave it 1999 crossings and 304,450 units of wire; taking the deeper of
        // "near a source" and "after everything feeding it" gave 632 and 151,630. These bounds are those
        // numbers with room, so an improvement is welcome and a regression is not silent.
        const alu = draw(all.find((t) => t.name === '01-alu-8bit')!.circuit);
        expect({ crossings: alu.crossings < 900, length: alu.length < 200_000, undrawable: alu.undrawable < 8 }).toEqual(
            { crossings: true, length: true, undrawable: true },
        );

        const dds = draw(all.find((t) => t.name === '02-dds-8bit')!.circuit);
        expect({ crossings: dds.crossings < 200, undrawable: dds.undrawable < 20 }).toEqual({
            crossings: true,
            undrawable: true,
        });
    });

    it('draws an ordinary design in a time nobody notices', () => {
        // Wall-clock, and honest about what that is worth: it measures this machine as much as this code, so
        // it is a smoke alarm for an order-of-magnitude change rather than a benchmark. Measured while
        // written: every template except the two big digital ones came in under 100ms.
        const ordinary = all.filter((t) => (t.circuit.components ?? []).length < 60);
        const slowest = Math.max(
            ...ordinary.map((t) => {
                const started = process.hrtime.bigint();
                draw(t.circuit);
                return Number(process.hrtime.bigint() - started) / 1e6;
            }),
        );
        expect({ slowest: slowest < 2000 }).toEqual({ slowest: true });
    });
});
