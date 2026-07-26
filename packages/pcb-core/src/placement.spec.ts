import type { CircuitJson } from '@circuit-forge/eda-core';

import { placeParts, computeHpwl, rot, type PlacementInput, type PlaceablePart } from './placement';
import { buildNetWeights, deriveExtraEdges } from './placement-bridge';

const R = (id: string, net1: string, net2: string): PlaceablePart => ({
    id, w: 1.6, h: 0.8, role: 'part',
    pads: [{ x: -0.8, y: 0, net: net1 }, { x: 0.8, y: 0, net: net2 }],
});

/** A tiny 555-ish board: hub IC + timing parts + LED chain + power connector. */
function blinkerParts(): PlaceablePart[] {
    return [
        {
            id: 'U1', w: 4, h: 5, role: 'part',
            pads: [
                { x: -2, y: -1.9, net: 'GND' }, { x: -2, y: -0.6, net: 'THR' }, { x: -2, y: 0.6, net: 'OUT' }, { x: -2, y: 1.9, net: 'VCC' },
                { x: 2, y: -0.6, net: 'THR' }, { x: 2, y: 0.6, net: 'DIS' }, { x: 2, y: 1.9, net: 'VCC' },
            ],
        },
        R('R1', 'VCC', 'DIS'),
        R('R2', 'DIS', 'THR'),
        R('R3', 'OUT', 'LEDK'),
        { id: 'C1', w: 1.6, h: 0.8, role: 'part', pads: [{ x: -0.8, y: 0, net: 'THR' }, { x: 0.8, y: 0, net: 'GND' }] },
        { id: 'LED1', w: 1.6, h: 0.8, role: 'part', pads: [{ x: -0.8, y: 0, net: 'LEDK' }, { x: 0.8, y: 0, net: 'GND' }] },
        { id: 'V1', w: 2.5, h: 5, role: 'connector', pads: [{ x: 0, y: -1.27, net: 'VCC' }, { x: 0, y: 1.27, net: 'GND' }] },
    ];
}

const WEIGHTS = { GND: 0.05, VCC: 0.3, THR: 1, DIS: 1, OUT: 1, LEDK: 1 };

function input(over: Partial<PlacementInput> = {}): PlacementInput {
    return { parts: blinkerParts(), netWeights: WEIGHTS, boardW: 40, boardH: 40, gridMm: 0.5, marginMm: 4, ...over };
}

describe('rot — exact integer rotation matrices (no trig, plan §12)', () => {
    it('rotates unit points exactly', () => {
        expect(rot(0, 3, 2)).toEqual([3, 2]);
        expect(rot(90, 3, 2)).toEqual([-2, 3]);
        expect(rot(180, 3, 2)).toEqual([-3, -2]);
        expect(rot(270, 3, 2)).toEqual([2, -3]);
    });
});

describe('placeParts — the Lever-2 engine', () => {
    it('is deterministic: two runs produce identical output', () => {
        const a = placeParts(input());
        const b = placeParts(input());
        expect(b).toEqual(a);
    });

    it('improves HPWL over a spread-out arrangement and stays inside the board', () => {
        const out = placeParts(input());
        expect(out.ok).toBe(true);
        // all parts inside board minus margin
        for (const p of blinkerParts()) {
            const pos = out.positions[p.id]!;
            const [w, h] = pos.rotation === 90 || pos.rotation === 270 ? [p.h / 2, p.w / 2] : [p.w / 2, p.h / 2];
            expect(Math.abs(pos.x) + w).toBeLessThanOrEqual(out.boardW / 2 - 3.9);
            expect(Math.abs(pos.y) + h).toBeLessThanOrEqual(out.boardH / 2 - 3.9);
        }
        // vs a deliberately bad diagonal spread
        const spread: Record<string, { x: number; y: number; rotation: 0 }> = {};
        blinkerParts().forEach((p, i) => { spread[p.id] = { x: -15 + i * 5, y: -15 + i * 5, rotation: 0 }; });
        expect(out.hpwl).toBeLessThan(computeHpwl(blinkerParts(), spread));
    });

    it('produces zero courtyard overlaps (the legalization invariant)', () => {
        const out = placeParts(input());
        const parts = blinkerParts();
        for (let i = 0; i < parts.length; i++) {
            for (let j = i + 1; j < parts.length; j++) {
                const a = parts[i]!;
                const b = parts[j]!;
                const pa = out.positions[a.id]!;
                const pb = out.positions[b.id]!;
                const [wa, ha] = pa.rotation === 90 || pa.rotation === 270 ? [a.h / 2, a.w / 2] : [a.w / 2, a.h / 2];
                const [wb, hb] = pb.rotation === 90 || pb.rotation === 270 ? [b.h / 2, b.w / 2] : [b.w / 2, b.h / 2];
                const sepX = Math.abs(pb.x - pa.x) >= wa + wb;
                const sepY = Math.abs(pb.y - pa.y) >= ha + hb;
                expect(sepX || sepY).toBe(true);
            }
        }
    });

    it('pulls the timing capacitor near the hub IC (the mutfak-ocak property)', () => {
        const out = placeParts(input());
        const dC = Math.hypot(out.positions.C1!.x - out.positions.U1!.x, out.positions.C1!.y - out.positions.U1!.y);
        // C1 (THR net, weight 1 to the hub) must sit meaningfully closer than half the board
        expect(dC).toBeLessThan(out.boardW / 2);
    });

    it('terminates (with growth or an honest failure) on a deliberately too-small board — never hangs', () => {
        const big: PlaceablePart[] = Array.from({ length: 4 }, (_, i) => ({
            id: `BIG${i}`, w: 14, h: 14, role: 'part',
            pads: [{ x: -6, y: 0, net: 'A' }, { x: 6, y: 0, net: 'A' }],
        }));
        const out = placeParts(input({ parts: big, netWeights: { A: 1 }, boardW: 20, boardH: 20 }));
        // either grown-and-legal or ok:false — both acceptable, hanging is not
        if (out.ok) {
            expect(out.boardW).toBeGreaterThan(20);
            expect(out.notes.join(' ')).toMatch(/grown/);
        } else {
            expect(out.notes.join(' ')).toMatch(/FAILED/);
        }
    });

    it('shrinks an oversized board to fit (plan §4.6.3)', () => {
        const out = placeParts(input({ boardW: 120, boardH: 120 }));
        expect(out.ok).toBe(true);
        expect(out.boardW).toBeLessThan(120);
        expect(out.boardH).toBeLessThan(120);
        expect(out.boardW).toBeGreaterThanOrEqual(20);
    });

    it('snaps every coordinate to the placement grid', () => {
        const out = placeParts(input());
        for (const pos of Object.values(out.positions)) {
            // positions are re-centered by a grid-snapped offset, so they stay on the 0.5mm lattice
            expect(Math.abs(pos.x / 0.5 - Math.round(pos.x / 0.5))).toBeLessThan(1e-6);
            expect(Math.abs(pos.y / 0.5 - Math.round(pos.y / 0.5))).toBeLessThan(1e-6);
        }
    });
});

describe('placement-bridge — weights and derived decap edges (plan §4.2)', () => {
    const gnd = { id: 'gnd', name: 'GND', isGround: true };
    const circuit: CircuitJson = {
        version: '1.0',
        components: [
            { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'vcc' }, { pinId: '-', netId: 'gnd' }] },
            { id: 'u1', type: 'generic', designator: 'U1', footprint: 'soic16', pins: [{ pinId: '16', netId: 'vcc' }, { pinId: '8', netId: 'gnd' }, { pinId: '1', netId: 'sig' }] },
            { id: 'u2', type: 'generic', designator: 'U2', footprint: 'soic8', pins: [{ pinId: '8', netId: 'vcc' }, { pinId: '4', netId: 'gnd' }] },
            { id: 'cd1', type: 'capacitor', designator: 'C1', value: '100n', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'gnd' }] },
            { id: 'cd2', type: 'capacitor', designator: 'C2', value: '100n', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'gnd' }] },
            { id: 'cbulk', type: 'capacitor', designator: 'C3', value: '10u', pins: [{ pinId: '1', netId: 'vcc' }, { pinId: '2', netId: 'gnd' }] },
            { id: 'ct', type: 'capacitor', designator: 'C4', value: '10n', pins: [{ pinId: '1', netId: 'sig' }, { pinId: '2', netId: 'gnd' }] },
        ],
        nets: [{ id: 'vcc', name: 'VCC' }, { id: 'sig', name: 'SIG' }, gnd],
    } as unknown as CircuitJson;
    const netNameById = { vcc: 'VCC', sig: 'SIG', gnd: 'GND' };
    const namesById = { v1: 'V1', u1: 'U1', u2: 'U2', cd1: 'C1', cd2: 'C2', cbulk: 'C3', ct: 'C4' };

    it('weights: GND≈0, source rails low, signals 1', () => {
        const w = buildNetWeights(circuit, netNameById);
        expect(w.GND).toBeCloseTo(0.05);
        expect(w.VCC).toBeCloseTo(0.3);
        expect(w.SIG).toBe(1);
    });

    it('decaps pair deterministically: first decap → biggest unserved IC, second → next; bulk cap excluded', () => {
        const edges = deriveExtraEdges(circuit, namesById);
        const decapEdges = edges.filter((e) => e.weight === 4);
        expect(decapEdges).toEqual([
            { a: 'C1', b: 'U1', weight: 4 }, // U1 = 16-pin, served first
            { a: 'C2', b: 'U2', weight: 4 }, // next unserved IC on the rail
        ]);
        expect(edges.find((e) => e.a === 'C3' && e.weight === 4)).toBeUndefined(); // 10µF bulk ≠ decap
    });

    it('timing cap on a single-IC signal net gets the mild proximity edge', () => {
        const edges = deriveExtraEdges(circuit, namesById);
        expect(edges).toContainEqual({ a: 'C4', b: 'U1', weight: 2 });
    });
});
