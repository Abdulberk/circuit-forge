/**
 * Adding and removing parts — the repair a human makes to a design a machine wrote.
 *
 * The properties that matter are not "did a component appear". They are: a new part invents no wiring, a
 * deleted part takes its orphaned nets with it and SAYS which, and neither operation can produce a document
 * the rest of the pipeline will refuse — a duplicate designator breaks the BOM and the pick-and-place file,
 * and a name this kernel accepts but `ComponentSchema` rejects would surface minutes later as a 400 about a
 * part the user had already forgotten renaming.
 */
import type { CircuitJson } from '@circuit-forge/eda-core';

import { addComponent, deleteComponent } from './parts';

const CIRCUIT: CircuitJson = {
    version: '1.0',
    components: [
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
                { pinId: '1', netId: 'mid' },
                { pinId: '2', netId: 'out' },
            ],
        },
    ],
    nets: [
        { id: 'vin', name: 'VIN' },
        { id: 'mid', name: 'MID' },
        { id: 'out', name: 'OUT' },
    ],
};

const ok = (r: ReturnType<typeof addComponent>) => {
    if (!r.ok) throw new Error(`expected success, got: ${r.message}`);
    return r;
};
const compOf = (c: CircuitJson, id: string) => c.components.find((x) => x.id === id);

describe('adding a part', () => {
    it('takes the next free designator for its type', () => {
        const r = ok(addComponent(CIRCUIT, { type: 'resistor' }));
        expect(compOf(r.circuit, 'r3')?.designator).toBe('R3');
    });

    it('seeds the CANONICAL pins for the type', () => {
        // Not a guess: `COMPONENT_PINS` is the same table the netlist generator and ERC read, so a part
        // created here has the pins every later stage expects to find.
        const bjt = ok(addComponent(CIRCUIT, { type: 'bjt', model: 'QGENNPN' }));
        expect(compOf(bjt.circuit, 'q1')?.pins.map((p) => p.pinId)).toEqual(['c', 'b', 'e']);
    });

    it('gives every new pin its OWN net — a new part invents no wiring', () => {
        // Guessing which net a capacitor belongs on would be inventing a connection nobody asked for, and a
        // wrong connection is a different circuit that every stage after this would faithfully build.
        const r = ok(addComponent(CIRCUIT, { type: 'capacitor', value: '100n' }));
        const pins = compOf(r.circuit, 'c1')!.pins;
        expect(new Set(pins.map((p) => p.netId)).size).toBe(2);
        for (const p of pins) {
            expect(['vin', 'mid', 'out']).not.toContain(p.netId); // touches nothing that was there
            expect((r.circuit.nets ?? []).some((n) => n.id === p.netId)).toBe(true); // …and the net exists
        }
    });

    it('says what it did, including the nets it created', () => {
        const r = ok(addComponent(CIRCUIT, { type: 'capacitor' }));
        expect(r.changed && r.note).toMatch(/C1 added with 2 unconnected pin\(s\)/);
    });

    it('carries value and model through, and omits them when absent', () => {
        const withValue = ok(addComponent(CIRCUIT, { type: 'resistor', value: '10k' }));
        expect(compOf(withValue.circuit, 'r3')?.value).toBe('10k');
        const bare = ok(addComponent(CIRCUIT, { type: 'resistor' }));
        expect('value' in compOf(bare.circuit, 'r3')!).toBe(false);
    });

    it('APPENDS rather than inserting, so a diff stays reviewable', () => {
        const r = ok(addComponent(CIRCUIT, { type: 'resistor' }));
        expect(r.circuit.components.map((c) => c.id)).toEqual(['r1', 'r2', 'r3']);
    });

    it('refuses a designator that already exists, case-insensitively', () => {
        // `r1` and `R1` are the same reference to an engineer and to every piece of fab software.
        const r = addComponent(CIRCUIT, { type: 'resistor', designator: 'r1' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('duplicate-designator');
    });

    it('refuses a designator the PIPELINE would reject, not a looser rule of its own', () => {
        // The grammar is imported, never restated. A second one here would accept names the working copy
        // later refuses, minutes after they were typed.
        const r = addComponent(CIRCUIT, { type: 'resistor', designator: 'not a designator' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('invalid-characters');
    });

    it('REFUSES a type whose pins are authored rather than canonical', () => {
        // A subcircuit's pins are emitted in authored order to match its own port order, so a blank one is
        // a part nothing can ever connect to. Refused with the reason named, not created empty.
        const r = addComponent(CIRCUIT, { type: 'subckt' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.message).toMatch(/no fixed pin list/);
    });

    it('is deterministic — undo and redo must agree', () => {
        const a = ok(addComponent(CIRCUIT, { type: 'capacitor' }));
        const b = ok(addComponent(CIRCUIT, { type: 'capacitor' }));
        expect(JSON.stringify(a.circuit)).toBe(JSON.stringify(b.circuit));
    });

    it('leaves the original document untouched', () => {
        const before = JSON.stringify(CIRCUIT);
        addComponent(CIRCUIT, { type: 'resistor' });
        expect(JSON.stringify(CIRCUIT)).toBe(before);
    });
});

describe('removing a part', () => {
    it('takes the nets it was the last thing holding up, and NAMES them', () => {
        // R1 shares MID with R2, so MID survives; VIN was R1's alone and goes.
        const r = ok(deleteComponent(CIRCUIT, 'r1'));
        expect(r.circuit.components.map((c) => c.id)).toEqual(['r2']);
        expect((r.circuit.nets ?? []).map((n) => n.name).sort()).toEqual(['MID', 'OUT']);
        expect(r.changed && r.note).toMatch(/VIN/);
    });

    it('keeps a net another part still sits on', () => {
        const r = ok(deleteComponent(CIRCUIT, 'r1'));
        expect((r.circuit.nets ?? []).some((n) => n.id === 'mid')).toBe(true);
    });

    it('says so plainly when nothing was orphaned', () => {
        const shared: CircuitJson = {
            ...CIRCUIT,
            components: CIRCUIT.components.map((c) => ({
                ...c,
                pins: c.pins.map((p) => ({ ...p, netId: 'mid' })),
            })),
            nets: [{ id: 'mid', name: 'MID' }],
        };
        const r = ok(deleteComponent(shared, 'r1'));
        expect(r.changed && r.note).toBe('R1 removed.');
    });

    it('refuses a component that is not there', () => {
        const r = deleteComponent(CIRCUIT, 'nope');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('no-such-component');
    });

    it('round-trips: add then delete returns the document to what it was', () => {
        const added = ok(addComponent(CIRCUIT, { type: 'capacitor' }));
        const back = ok(deleteComponent(added.circuit, 'c1'));
        expect(JSON.stringify(back.circuit)).toBe(JSON.stringify(CIRCUIT));
    });
});
