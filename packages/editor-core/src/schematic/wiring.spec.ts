/**
 * Drawn wires, against every template the product ships.
 *
 * The design review measured the old editor on these same templates: a connection moved half the untouched
 * parts, rerouted 72% of untouched wires, and a dragged wire previewed something other than what it
 * committed 48% of the time. Each of those numbers is asserted here as ZERO, and the drawing and the netlist
 * must never disagree across thousands of random edits.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { safeValidateUiJson, type CircuitJson, type Position, type UiJson, type Wire } from '@circuit-forge/eda-core';

import { setValue } from '../document/edits';
import { beginHistory, commit, undo, type History } from '../document/history';
import { connectPins, disconnectPin } from '../document/nets';
import { addComponent, deleteComponent } from '../document/parts';

import {
    airwires,
    drawingProblems,
    freezeDrawing,
    planWire,
    planWireDeletion,
    sheetPins,
    wireKey,
    withPositions,
    type WirePlan,
} from './wiring';

const TEMPLATE_DIR = join(__dirname, '..', '..', '..', '..', 'apps', 'api', 'prisma', 'templates');

const TEMPLATES: Array<{ name: string; circuit: CircuitJson }> = readdirSync(TEMPLATE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
        const raw = JSON.parse(readFileSync(join(TEMPLATE_DIR, f), 'utf8')) as {
            circuitJson?: CircuitJson;
        } & CircuitJson;
        return { name: f.replace('.json', ''), circuit: raw.circuitJson ?? raw };
    })
    .filter((t) => (t.circuit.components ?? []).length > 0);

/** A seeded generator, so a failure names a reproducible case. */
const rng = (seed: number) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);

/** Apply a wire plan the way the studio does: one commit, edits and drawing together. */
function run(h: History, plan: WirePlan): ReturnType<typeof commit> {
    return commit(h, plan.label, plan.edits, plan.drawing);
}

/** A tiny design: a source, two resistors, ground. */
const DIVIDER: CircuitJson = {
    version: '1.0',
    components: [
        {
            id: 'v1',
            type: 'voltage_source',
            designator: 'V1',
            value: 'DC 5',
            pins: [
                { pinId: '+', netId: 'vin' },
                { pinId: '-', netId: 'gnd' },
            ],
        },
        {
            id: 'r1',
            type: 'resistor',
            designator: 'R1',
            value: '1k',
            pins: [
                { pinId: '1', netId: 'vin' },
                { pinId: '2', netId: 'mid' },
            ],
        },
        {
            id: 'r2',
            type: 'resistor',
            designator: 'R2',
            value: '2k',
            pins: [
                { pinId: '1', netId: 'n9' },
                { pinId: '2', netId: 'gnd' },
            ],
        },
    ],
    nets: [
        { id: 'vin', name: 'VIN' },
        { id: 'mid', name: 'MID' },
        { id: 'n9', name: 'N9' },
        { id: 'gnd', name: 'GND', isGround: true },
    ],
};

const positionsOf = (ui: UiJson): Record<string, Position> => ui.positions ?? {};
const wiresById = (ui: UiJson): Map<string, Wire> => new Map((ui.wires ?? []).map((w, i) => [wireKey(w, i), w]));

describe('a design is drawn ONCE, and then it is the user’s', () => {
    it('freezes every template into stored positions and wires that agree with the netlist', () => {
        for (const { name, circuit } of TEMPLATES) {
            const ui = freezeDrawing(circuit, {});
            expect({ name, owned: Array.isArray(ui.wires), problems: drawingProblems(circuit, ui) }).toEqual({
                name,
                owned: true,
                problems: [],
            });
            // Frozen means frozen: freezing again changes nothing.
            expect(freezeDrawing(circuit, ui)).toBe(ui);
        }
    });

    it('shows NO dashed line on a freshly drawn template — everything the netlist has is drawn', () => {
        for (const { name, circuit } of TEMPLATES) {
            const ui = freezeDrawing(circuit, {});
            const missing = airwires(circuit, ui).filter((a) => a.from[0] !== a.to[0] || a.from[1] !== a.to[1]);
            expect({ name, missing: missing.length }).toEqual({ name, missing: 0 });
        }
    });
});

describe('an edit never moves what it did not touch (review: 49% of parts moved, 72% of wires rerouted)', () => {
    it('connecting two pins moves NO part and changes NO other wire, on every template', () => {
        let edits = 0;
        for (const { name, circuit } of TEMPLATES) {
            const next = rng(42);
            let h = beginHistory({ circuit, ui: {} });
            for (let k = 0; k < 12; k++) {
                const pins = sheetPins(h.present.circuit, freezeDrawing(h.present.circuit, h.present.ui).positions);
                const a = pins[next() % pins.length]!;
                const b = pins[next() % pins.length]!;
                const before = freezeDrawing(h.present.circuit, h.present.ui);
                const r = commit(h, 'join', [(c) => connectPins(c, a, b)]);
                if (!r.ok || !r.changed) continue;
                edits++;
                const after = r.history.present.ui;
                expect({ name, positions: positionsOf(after) }).toEqual({ name, positions: positionsOf(before) });
                const was = wiresById(before);
                for (const [id, w] of wiresById(after)) {
                    const old = was.get(id);
                    // A surviving wire keeps its exact geometry; at most its net is relabelled by a merge.
                    if (old) expect({ name, id, points: w.points }).toEqual({ name, id, points: old.points });
                }
                expect({ name, problems: drawingProblems(r.history.present.circuit, after) }).toEqual({
                    name,
                    problems: [],
                });
                h = r.history;
            }
        }
        expect(edits).toBeGreaterThan(100);
    });

    it('a value edit changes nothing in the drawing at all', () => {
        for (const { name, circuit } of TEMPLATES) {
            const owned = freezeDrawing(circuit, {});
            const h = beginHistory({ circuit, ui: owned });
            const part = (circuit.components ?? []).find((c) => c.type === 'resistor');
            if (!part) continue;
            const r = commit(h, 'value', [(c) => setValue(c, part.id, '4k7')]);
            if (!r.ok || !r.changed) continue;
            expect({ name, same: r.history.present.ui === owned }).toEqual({ name, same: true });
        }
    });

    it('adding a part puts it on the sheet without moving anything else (review: 20 of 21 templates shifted)', () => {
        for (const { name, circuit } of TEMPLATES) {
            const owned = freezeDrawing(circuit, {});
            const r = commit(beginHistory({ circuit, ui: owned }), 'add', [
                (c) => addComponent(c, { type: 'resistor' }),
            ]);
            if (!r.ok || !r.changed) throw new Error(`${name}: add refused`);
            const after = r.history.present.ui;
            const added = r.history.present.circuit.components!.at(-1)!.id;
            const { [added]: placed, ...rest } = positionsOf(after);
            expect({ name, rest, wires: after.wires }).toEqual({ name, rest: positionsOf(owned), wires: owned.wires });
            expect({ name, placed: placed !== undefined }).toEqual({ name, placed: true });
        }
    });
});

describe('drawing a wire, KiCad style', () => {
    /** The divider with R2 pin 1 still loose, drawn and owned. */
    const start = (): History => beginHistory({ circuit: DIVIDER, ui: freezeDrawing(DIVIDER, {}) });
    const pinAt = (h: History, componentId: string, pinId: string) =>
        sheetPins(h.present.circuit, h.present.ui.positions).find(
            (p) => p.componentId === componentId && p.pinId === pinId,
        )!;

    it('stays exactly where it was drawn, and joins the two terminals in the same revision', () => {
        const h = start();
        const [a, b] = [pinAt(h, 'r1', '2'), pinAt(h, 'r2', '1')];
        const corner = { x: b.x, y: a.y };
        const points = [{ x: a.x, y: a.y }, corner, { x: b.x, y: b.y }].filter(
            (p, i, all) => i === 0 || p.x !== all[i - 1]!.x || p.y !== all[i - 1]!.y,
        );
        const r = run(h, planWire(h.present.circuit, h.present.ui, { points, from: a, to: b }));
        if (!r.ok || !r.changed) throw new Error('refused');
        const net = (id: string, pin: string) =>
            r.history.present.circuit.components!.find((c) => c.id === id)!.pins.find((p) => p.pinId === pin)!.netId;
        expect(net('r1', '2')).toBe(net('r2', '1'));
        const drawn = r.history.present.ui.wires!.at(-1)!;
        expect(drawn.points).toEqual(points);
        // Stored ends are EXACTLY PinRefs, though a richer SheetPin was handed in: the server is strict.
        expect({ from: drawn.from, to: drawn.to }).toEqual({
            from: { componentId: 'r1', pinId: '2' },
            to: { componentId: 'r2', pinId: '1' },
        });
        expect(drawingProblems(r.history.present.circuit, r.history.present.ui)).toEqual([]);
        // ONE undo takes back the wire AND the connection.
        expect(undo(r.history).present).toBe(h.present);
    });

    it('refuses a diagonal, and a wire that touches nothing', () => {
        const h = start();
        const a = pinAt(h, 'r1', '2');
        const diagonal = planWire(h.present.circuit, h.present.ui, {
            points: [
                { x: a.x, y: a.y },
                { x: a.x + 30, y: a.y + 40 },
            ],
            from: a,
            to: null,
        });
        expect(run(h, diagonal).ok).toBe(false);
        const floating = planWire(h.present.circuit, h.present.ui, {
            points: [
                { x: -900, y: -900 },
                { x: -800, y: -900 },
            ],
            from: null,
            to: null,
        });
        expect(run(h, floating).ok).toBe(false);
    });

    it('refuses a short from ground to a supply rail, as connectPins always has', () => {
        const railed: CircuitJson = {
            ...DIVIDER,
            nets: DIVIDER.nets!.map((n) => (n.id === 'vin' ? { ...n, isPower: true } : n)),
        };
        const h = beginHistory({ circuit: railed, ui: freezeDrawing(railed, {}) });
        const [a, b] = [pinAt(h, 'r1', '1'), pinAt(h, 'r2', '2')];
        const plan = planWire(h.present.circuit, h.present.ui, {
            points: [
                { x: a.x, y: a.y },
                { x: b.x, y: a.y },
                { x: b.x, y: b.y },
            ],
            from: a,
            to: b,
        });
        const r = run(h, plan);
        expect(r.ok).toBe(false);
    });

    it('deleting the only wire between two terminals parts them again', () => {
        const h = start();
        const [a, b] = [pinAt(h, 'r1', '2'), pinAt(h, 'r2', '1')];
        const drawn = run(
            h,
            planWire(h.present.circuit, h.present.ui, {
                points: [
                    { x: a.x, y: a.y },
                    { x: b.x, y: a.y },
                    { x: b.x, y: b.y },
                ],
                from: a,
                to: b,
            }),
        );
        if (!drawn.ok || !drawn.changed) throw new Error('refused');
        const doc = drawn.history.present;
        const key = wireKey(doc.ui.wires!.at(-1)!, doc.ui.wires!.length - 1);
        const r = run(drawn.history, planWireDeletion(doc.circuit, doc.ui, [key]));
        if (!r.ok || !r.changed) throw new Error('refused');
        const net = (id: string, pin: string) =>
            r.history.present.circuit.components!.find((c) => c.id === id)!.pins.find((p) => p.pinId === pin)!.netId;
        expect(net('r1', '2')).not.toBe(net('r2', '1'));
        expect(drawingProblems(r.history.present.circuit, r.history.present.ui)).toEqual([]);
    });
});

describe('dragging a part (review: 48% of previews differed from the result)', () => {
    it('what the drag shows is exactly what it commits, and only wires on the moved part change', () => {
        let wiresChecked = 0;
        for (const { name, circuit } of TEMPLATES) {
            const ui = freezeDrawing(circuit, {});
            const ids = Object.keys(ui.positions!);
            const next = rng(7);
            for (let k = 0; k < 6; k++) {
                const id = ids[next() % ids.length]!;
                const to = {
                    ...ui.positions![id]!,
                    x: ui.positions![id]!.x + 20 * ((next() % 5) - 2),
                    y: ui.positions![id]!.y + 20 * ((next() % 5) - 2),
                };
                const preview = withPositions(circuit, ui, { ...ui.positions, [id]: to });
                const h = beginHistory({ circuit, ui });
                const r = commit(h, 'move', [], (u) => withPositions(circuit, u, { ...u.positions, [id]: to }));
                // THE SAME DRAWING the preview showed is what the release commits.
                const committed = r.ok && r.changed ? r.history.present.ui : ui; // a zero move commits nothing
                expect({ name, committed }).toEqual({ name, committed: preview });
                const was = wiresById(ui);
                for (const [wid, w] of wiresById(preview)) {
                    const old = was.get(wid)!;
                    const onMoved = [old.from, old.to].some((e) => e?.componentId === id);
                    if (!onMoved) expect({ name, wid, points: w.points }).toEqual({ name, wid, points: old.points });
                    wiresChecked++;
                }
                const { [id]: _moved, ...others } = preview.positions!;
                const { [id]: _was, ...before } = ui.positions!;
                expect({ name, others }).toEqual({ name, others: before });
                expect({ name, problems: drawingProblems(circuit, preview) }).toEqual({ name, problems: [] });
            }
        }
        expect(wiresChecked).toBeGreaterThan(1000);
    });
});

describe('an edit no longer routes the sheet (review: 3–4.5 s per value edit on the 135-part ALU)', () => {
    it('a value edit on the ALU commits in well under a frame’s worth of a second', () => {
        const alu = TEMPLATES.find((t) => t.name.includes('alu'))!;
        const owned = freezeDrawing(alu.circuit, {});
        const part = alu.circuit.components!.find((c) => c.type === 'resistor' || c.value)!;
        let h = beginHistory({ circuit: alu.circuit, ui: owned });
        const started = performance.now();
        for (let i = 0; i < 20; i++) {
            const r = commit(h, 'value', [(c) => setValue(c, part.id, `${10 + i}k`)]);
            if (r.ok && r.changed) h = r.history;
        }
        const perEdit = (performance.now() - started) / 20;
        // Measured ~1 ms here. The bound is loose on purpose: it is a smoke alarm for a whole-sheet route
        // sneaking back into the edit path, which would cost three orders of magnitude, not a benchmark.
        expect(perEdit).toBeLessThan(100);
        expect(h.present.ui.wires).toBe(owned.wires);
    });
});

describe('the drawing and the netlist never disagree, over a long random session', () => {
    it('holds across thousands of mixed edits on every template — draw, delete, move, connect, AI-style edits', () => {
        let applied = 0;
        for (const { name, circuit } of TEMPLATES) {
            const next = rng(1234567);
            let h = beginHistory({ circuit, ui: {} });
            for (let step = 0; step < 150; step++) {
                const doc = h.present;
                const ui = freezeDrawing(doc.circuit, doc.ui);
                const pins = sheetPins(doc.circuit, ui.positions);
                const parts = (doc.circuit.components ?? []).filter((c) => ui.positions?.[c.id]);
                const roll = next() % 8;
                let r: ReturnType<typeof commit> | null = null;
                if (roll === 0 && pins.length > 1) {
                    // Draw an L between two terminals, the way the canvas reports it.
                    const [a, b] = [pins[next() % pins.length]!, pins[next() % pins.length]!];
                    const points = [
                        { x: a.x, y: a.y },
                        { x: b.x, y: a.y },
                        { x: b.x, y: b.y },
                    ];
                    r = run(h, planWire(doc.circuit, doc.ui, { points, from: a, to: b }));
                } else if (roll === 1 && (ui.wires ?? []).length > 0) {
                    const i = next() % ui.wires!.length;
                    r = run(h, planWireDeletion(doc.circuit, ui, [wireKey(ui.wires![i]!, i)]));
                } else if (roll === 2 && parts.length > 0) {
                    const id = parts[next() % parts.length]!.id;
                    const at = ui.positions![id]!;
                    const to = { ...at, x: at.x + 10 * ((next() % 7) - 3), y: at.y + 10 * ((next() % 7) - 3) };
                    r = commit(h, 'move', [], (u) => withPositions(doc.circuit, u, { ...u.positions, [id]: to }));
                } else if (roll === 3 && pins.length > 1) {
                    // An AI-style netlist edit: join two pins without drawing anything.
                    const [a, b] = [pins[next() % pins.length]!, pins[next() % pins.length]!];
                    r = commit(h, 'ai join', [(c) => connectPins(c, a, b)]);
                } else if (roll === 4 && pins.length > 0) {
                    r = commit(h, 'ai disconnect', [(c) => disconnectPin(c, pins[next() % pins.length]!)]);
                } else if (roll === 5 && parts.length > 2) {
                    r = commit(h, 'delete', [(c) => deleteComponent(c, parts[next() % parts.length]!.id)]);
                } else if (roll === 6) {
                    r = commit(h, 'add', [(c) => addComponent(c, { type: 'capacitor' })]);
                } else {
                    h = undo(h);
                }
                if (r?.ok && r.changed) {
                    h = r.history;
                    applied++;
                }
                const problems = drawingProblems(h.present.circuit, h.present.ui);
                if (problems.length > 0) throw new Error(`${name} step ${step}: ${problems.join('; ')}`);
                // And every drawing the session produces is one the SERVER would store.
                const valid = safeValidateUiJson(h.present.ui);
                if (!valid.success)
                    throw new Error(`${name} step ${step}: ${JSON.stringify(valid.error).slice(0, 300)}`);
            }
        }
        expect(applied).toBeGreaterThan(1000);
    });
});
