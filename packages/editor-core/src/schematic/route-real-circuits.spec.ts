/**
 * The router, on the circuits this product actually produces.
 *
 * The generated sheets in route.spec.ts are adversarial on purpose and prove that no drawing LIES. They say
 * nothing about whether the drawing is any GOOD — a router that answered "diagonal" every time would pass
 * every one of them. This file is the other half: real circuits, laid out the way the canvas lays them out
 * before anyone has arranged anything, and every wire required to come out as right angles.
 *
 * It exists because that number moved a long way and quietly. An earlier router enumerated named shapes —
 * the straight line, the two elbows, a step across — and on these same four circuits drew 3 of 3, 8 of 9,
 * 9 of 10 and then FOURTEEN of twenty-six, because a sheet with more nets than gaps needs wires that run
 * partway along one lane and continue on another. Every contract test stayed green through all of it. This
 * one would not have.
 */
import type { CircuitJson } from '@circuit-forge/eda-core';

import { orientSymbol } from './orient';
import { routeSheet, type Box, type RouteNet, type RoutePin } from './route';
import { PIN_GRID, symbolFor } from './symbols';

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
    pins: [
        { pinId: 'anode', netId: a },
        { pinId: 'cathode', netId: b },
    ],
});
const V = (id: string, a: string, b: string) => ({
    id,
    type: 'voltage_source',
    designator: id.toUpperCase(),
    value: 'DC 5',
    pins: [
        { pinId: '+', netId: a },
        { pinId: '-', netId: b },
    ],
});
const GND = (id: string, net: string) => ({
    id,
    type: 'ground',
    designator: id.toUpperCase(),
    pins: [{ pinId: '1', netId: net }],
});
const nets = (...names: string[]): CircuitJson['nets'] =>
    names.map((n) => ({ id: n, name: n.toUpperCase(), isGround: n === 'gnd' }));

/** A divider with a rail — the smallest thing the studio draws. */
const DIVIDER: CircuitJson = {
    version: '1.0',
    components: [V('v1', 'vin', 'gnd'), R('r1', 'vin', 'mid'), R('r2', 'mid', 'gnd'), GND('g1', 'gnd')] as never,
    nets: nets('vin', 'mid', 'gnd'),
};

/** RC filter chain: local nets in a line, the commonest AI output there is. */
const FILTER: CircuitJson = {
    version: '1.0',
    components: [
        V('v1', 'in', 'gnd'),
        R('r1', 'in', 'a'),
        C('c1', 'a', 'gnd'),
        R('r2', 'a', 'b'),
        C('c2', 'b', 'gnd'),
        R('r3', 'b', 'out'),
        C('c3', 'out', 'gnd'),
        GND('g1', 'gnd'),
    ] as never,
    nets: nets('in', 'a', 'b', 'out', 'gnd'),
};

/** Bridge rectifier + smoothing: one node touched by four parts, which is where stars get busy. */
const BRIDGE: CircuitJson = {
    version: '1.0',
    components: [
        V('v1', 'ac1', 'ac2'),
        D('d1', 'ac1', 'plus'),
        D('d2', 'ac2', 'plus'),
        D('d3', 'gnd', 'ac1'),
        D('d4', 'gnd', 'ac2'),
        C('c1', 'plus', 'gnd'),
        R('r1', 'plus', 'gnd'),
        GND('g1', 'gnd'),
    ] as never,
    nets: nets('ac1', 'ac2', 'plus', 'gnd'),
};

/** Twenty parts on one ground — the size where a fallback grid starts to look like a real sheet. */
const BIG: CircuitJson = {
    version: '1.0',
    components: [
        V('v1', 'rail', 'gnd'),
        ...Array.from({ length: 10 }, (_, i) => R(`r${i}`, i === 0 ? 'rail' : `n${i - 1}`, `n${i}`)),
        ...Array.from({ length: 8 }, (_, i) => C(`c${i}`, `n${i}`, 'gnd')),
        GND('g1', 'gnd'),
    ] as never,
    nets: nets('rail', ...Array.from({ length: 10 }, (_, i) => `n${i}`), 'gnd'),
};

/** The canvas's own fallback layout, reproduced: what every design gets before anyone arranges it. */
function layOut(circuit: CircuitJson): { nets: RouteNet[]; bodies: Box[] } {
    const MARGIN = 40;
    const snapTo = (v: number): number => Math.round(v / PIN_GRID) * PIN_GRID;
    const parts = (circuit.components ?? []).filter((c) => c.type !== 'ground');
    const symbols = parts.map((c) => orientSymbol(symbolFor(c), undefined));
    const cols = Math.max(1, Math.ceil(Math.sqrt(parts.length)));
    const cellW = Math.max(...symbols.map((s) => s.width)) + 48;
    const cellH = Math.max(...symbols.map((s) => s.height)) + 48;

    const bodies: Box[] = [];
    const placed = parts.map((c, i) => {
        const x = snapTo(MARGIN + (i % cols) * cellW + cellW / 2);
        const y = snapTo(MARGIN + Math.floor(i / cols) * cellH + cellH / 2);
        const s = symbols[i]!;
        bodies.push({ minX: x - s.width / 2, minY: y - s.height / 2, maxX: x + s.width / 2, maxY: y + s.height / 2 });
        return { c, x, y, s };
    });

    const routeNets: RouteNet[] = [];
    for (const net of circuit.nets ?? []) {
        const pins: RoutePin[] = [];
        for (const p of placed)
            for (const pin of p.c.pins) {
                if (pin.netId !== net.id) continue;
                const sp = p.s.pins.find((q) => q.pinId === pin.pinId);
                if (sp) pins.push({ x: p.x + sp.x, y: p.y + sp.y, side: sp.side, label: `${p.c.id}.${pin.pinId}` });
            }
        if (pins.length >= 2) routeNets.push({ id: net.id, name: net.name, pins });
    }
    return { nets: routeNets, bodies };
}

it('draws every wire as right angles, on circuits the product actually produces', () => {
    const report = [
        ['divider', DIVIDER],
        ['rc-filter', FILTER],
        ['bridge', BRIDGE],
        ['twenty-parts', BIG],
    ].map(([name, circuit]) => {
        const { nets: rn, bodies } = layOut(circuit as CircuitJson);
        const out = routeSheet(rn, bodies);
        const diag = out.wires.filter((w) => w.shape === 'diagonal').length;
        return {
            circuit: name,
            wires: out.wires.length,
            orthogonal: out.wires.length - diag,
            diagonal: diag,
            illegible: out.fellBack.filter((f) => f.reason === 'no-legible-route').length,
            dots: out.junctions.length,
        };
    });
    // Every wire, on every circuit. Not a share, not a threshold: on designs this size there is no reason
    // for a wire to give up, and the day one does, the number that matters is which circuit and how many.
    expect(report.map((r) => ({ circuit: r.circuit, diagonal: r.diagonal, illegible: r.illegible }))).toEqual(
        report.map((r) => ({ circuit: r.circuit, diagonal: 0, illegible: 0 })),
    );
    // And it must have drawn something. A layout that produced no wires would satisfy the line above.
    expect(report.map((r) => r.wires)).toEqual([3, 9, 10, 26]);
    // Junction dots where nets branch — the twenty-part sheet hangs eight capacitors off one ground, so its
    // ground node forks repeatedly and every fork needs marking.
    expect(report.map((r) => r.dots > 0)).toEqual([false, true, true, true]);
});
