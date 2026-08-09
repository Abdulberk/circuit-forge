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

import { setDesignator } from './edits';
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

describe('a part built to an authored shape', () => {
    // The escape hatch a COPY needs: it already knows the shape, because it is looking at one.

    it('builds a variable-arity part, which has no shape of its own to fall back on', () => {
        const r = addComponent(CIRCUIT, { type: 'logic_and', pins: ['in1', 'in2', 'in3', 'out'] });
        expect(r.ok).toBe(true);
        if (!r.ok || !r.changed) return;
        expect(r.circuit.components!.at(-1)!.pins.map((q) => q.pinId)).toEqual(['in1', 'in2', 'in3', 'out']);
    });

    it('still refuses one with NO shape and nowhere to get one', () => {
        const r = addComponent(CIRCUIT, { type: 'logic_and' });
        expect(r.ok).toBe(false);
    });

    it('lets a fixed-arity part leave OPTIONAL pins off', () => {
        // set/rst on a flip-flop. The generator ties an omitted one to the inactive rail; inventing them
        // here would turn them into floating inputs.
        const r = addComponent(CIRCUIT, { type: 'dff', pins: ['d', 'clk', 'q', 'qb'] });
        expect(r.ok).toBe(true);
        if (!r.ok || !r.changed) return;
        expect(r.circuit.components!.at(-1)!.pins).toHaveLength(4);
    });

    it('REFUSES a pin name the type does not have', () => {
        // Everything downstream resolves a fixed-arity part's pins BY NAME — the netlist generator refuses
        // a whole deck over a missing one. A pin called `collector` on a BJT would be a connection the user
        // can see on the sheet and no analysis will ever find, so it is stopped where it is written.
        const r = addComponent(CIRCUIT, { type: 'bjt', model: '2N3904', pins: ['collector', 'b', 'e'] });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.message).toContain('collector');
    });

    it('refuses a pin named twice, and a part with none', () => {
        expect(addComponent(CIRCUIT, { type: 'resistor', value: '1k', pins: ['1', '1'] }).ok).toBe(false);
        expect(addComponent(CIRCUIT, { type: 'resistor', value: '1k', pins: [] }).ok).toBe(false);
    });

    it('gives every authored pin its own net — a shape is not wiring', () => {
        const r = addComponent(CIRCUIT, { type: 'logic_or', pins: ['in1', 'in2', 'out'] });
        expect(r.ok).toBe(true);
        if (!r.ok || !r.changed) return;
        const pins = r.circuit.components!.at(-1)!.pins;
        expect(new Set(pins.map((q) => q.netId)).size).toBe(3);
    });
});

describe('naming a new part', () => {
    /**
     * The id is DERIVED from the designator, so a designator whose id is already taken is not free.
     *
     * Skipping only taken DESIGNATORS produced names the add then refused — permanently, since nothing
     * retried, and with a message naming an internal id the user has never seen. Measured on a shipped
     * template: `01-alu-8bit` names its gates `g0`, `g1`, … with designators `U0`, `U1`, …, and the SPICE
     * prefix for a VCCS is `G` — so the first free designator was `G1`, whose id belonged to a logic gate,
     * and no VCCS could ever be added to that design.
     */
    const withOddIds: CircuitJson = {
        version: '1.0',
        components: [
            // Designator U1, id r1 — legal, and exactly the shape a generated or imported design produces.
            { id: 'r1', type: 'resistor', designator: 'U1', value: '1k', pins: [{ pinId: '1', netId: 'a' }] },
        ] as never,
        nets: [{ id: 'a', name: 'A' }],
    };

    it('skips a designator whose ID is already somebody else’s', () => {
        const r = addComponent(withOddIds, { type: 'resistor', value: '10k' });
        expect(r.ok).toBe(true);
        if (!r.ok || !r.changed) return;
        const made = r.circuit.components!.at(-1)!;
        expect(made.designator).toBe('R2');
        expect(made.id).toBe('r2');
    });

    it('keeps working after a RENAME, which is where this trap closes on any document', () => {
        // Rename R9 to R20 and the id stays r9. The next resistor wants R9 — free as a name, taken as an id.
        let circuit: CircuitJson = { version: '1.0', components: [] as never, nets: [] };
        const first = addComponent(circuit, { type: 'resistor', value: '1k' });
        expect(first.ok).toBe(true);
        if (!first.ok || !first.changed) return;
        circuit = first.circuit;
        const renamed = setDesignator(circuit, first.circuit.components!.at(-1)!.id, 'R20');
        expect(renamed.ok).toBe(true);
        if (!renamed.ok || !renamed.changed) return;

        // Ten in a row: the old rule refused all ten identically.
        let next = renamed.circuit;
        for (let i = 0; i < 10; i++) {
            const r = addComponent(next, { type: 'resistor', value: '1k' });
            expect({ attempt: i, ok: r.ok }).toEqual({ attempt: i, ok: true });
            if (!r.ok || !r.changed) return;
            next = r.circuit;
        }
        expect(next.components!.length).toBe(11);
    });

    it('still never hands out a designator somebody already has', () => {
        // The other half of the bargain: widening what counts as taken must not narrow it. The fixture has
        // to be one where the NAME is taken and its id is not — `withOddIds` is the mirror case and the
        // first version of this test used it, so dropping the name check entirely left the test green.
        const nameTaken: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'x1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'a' }] },
            ] as never,
            nets: [{ id: 'a', name: 'A' }],
        };
        const r = addComponent(nameTaken, { type: 'resistor', value: '10k' });
        expect(r.ok).toBe(true);
        if (!r.ok || !r.changed) return;
        expect(r.circuit.components!.at(-1)!.designator).not.toBe('R1');
        const names = r.circuit.components!.map((c) => c.designator.toUpperCase());
        expect(new Set(names).size).toBe(names.length);
        const ids = r.circuit.components!.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
