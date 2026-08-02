/**
 * Connectivity, which is the only kind of edit that changes what the circuit IS.
 *
 * A wrong value simulates to the wrong number and someone notices. A wrong connection produces a different
 * circuit, and every stage after this one — simulation, routing, DRC, the fab — will faithfully build it.
 * So these tests are less about the happy path than about the four ways this can quietly go wrong: a merge
 * that loses a net without saying so, a rail short that is perfectly representable, a "disconnect" that
 * leaves a pin nowhere in a schema with no nowhere, and generated ids that differ between undo and redo.
 */
import type { CircuitJson } from '@circuit-forge/eda-core';

import { connectPins, disconnectPin, splitNet } from './nets';

/** Two resistors and a source. R1.2 and R2.1 share MID; everything else is on its own net. */
const CIRCUIT: CircuitJson = {
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
                { pinId: '1', netId: 'mid' },
                { pinId: '2', netId: 'out' },
            ],
        },
    ],
    nets: [
        { id: 'vin', name: 'VIN', isPower: true },
        { id: 'mid', name: 'MID' },
        { id: 'out', name: 'OUT' },
        { id: 'gnd', name: 'GND', isGround: true },
    ],
};

const netOf = (c: CircuitJson, componentId: string, pinId: string): string | undefined =>
    c.components.find((x) => x.id === componentId)?.pins.find((p) => p.pinId === pinId)?.netId;
const netNames = (c: CircuitJson): string[] => (c.nets ?? []).map((n) => n.name).sort();
const ok = (r: ReturnType<typeof connectPins>) => {
    if (!r.ok) throw new Error(`expected success, got refusal: ${r.message}`);
    return r;
};

describe('putting two pins on the same net', () => {
    it('merges the two nets and moves EVERY pin, not just the one clicked', () => {
        // The bug this prevents: repointing only the clicked pin leaves the other members of the absorbed
        // net behind on a net that no longer exists, and the netlist silently loses connections.
        const r = ok(connectPins(CIRCUIT, { componentId: 'r2', pinId: '2' }, { componentId: 'r1', pinId: '2' }));
        expect(r.changed).toBe(true);
        expect(netOf(r.circuit, 'r2', '2')).toBe('mid');
        expect(netOf(r.circuit, 'r2', '1')).toBe('mid'); // was already MID, still is
        expect(netNames(r.circuit)).toEqual(['GND', 'MID', 'VIN']); // OUT is gone
    });

    it('SAYS which net ceased to exist', () => {
        // Merging is lossy and silence about it is how an editor earns a reputation for losing things.
        const r = ok(connectPins(CIRCUIT, { componentId: 'r2', pinId: '2' }, { componentId: 'r1', pinId: '2' }));
        expect(r.changed && r.note).toBe('OUT merged into MID.');
    });

    it('keeps the net that carries a DECLARED ROLE, whichever pin was clicked first', () => {
        // A name can be retyped; "this net is ground" drives rail checks and pour assignment downstream.
        // The rule must not depend on click order, or the same action gives different documents.
        const a = ok(connectPins(CIRCUIT, { componentId: 'r2', pinId: '2' }, { componentId: 'v1', pinId: '-' }));
        const b = ok(connectPins(CIRCUIT, { componentId: 'v1', pinId: '-' }, { componentId: 'r2', pinId: '2' }));
        expect(netOf(a.circuit, 'r2', '2')).toBe('gnd');
        expect(netOf(b.circuit, 'r2', '2')).toBe('gnd');
        expect((a.circuit.nets ?? []).find((n) => n.id === 'gnd')?.isGround).toBe(true);
    });

    it('REFUSES to short a declared ground to a declared power rail', () => {
        // Representable, and never an intention. Refused here rather than found in copper.
        const r = connectPins(CIRCUIT, { componentId: 'v1', pinId: '-' }, { componentId: 'r1', pinId: '1' });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('unreachable');
        expect(r.reason).toBe('rail-short');
        // The remedy has to be in the message, or the user is stuck with a refusal and no way forward.
        expect(r.message).toMatch(/GND/);
        expect(r.message).toMatch(/VIN/);
        expect(r.message).toMatch(/change its role first/i);
    });

    it('is a NO-OP, not an error, when the two pins already share a net', () => {
        // Re-drawing a connection that exists must not become an undo step to press twice past.
        const r = ok(connectPins(CIRCUIT, { componentId: 'r1', pinId: '2' }, { componentId: 'r2', pinId: '1' }));
        expect(r.changed).toBe(false);
        expect(r.circuit).toBe(CIRCUIT); // same reference: nothing was rebuilt
    });

    it('refuses a pin that does not exist, naming which half was missing', () => {
        const noComponent = connectPins(
            CIRCUIT,
            { componentId: 'nope', pinId: '1' },
            { componentId: 'r1', pinId: '1' },
        );
        expect(noComponent.ok).toBe(false);
        if (!noComponent.ok) expect(noComponent.message).toMatch(/No component with id "nope"/);

        const noPin = connectPins(CIRCUIT, { componentId: 'r1', pinId: '7' }, { componentId: 'r2', pinId: '1' });
        expect(noPin.ok).toBe(false);
        if (!noPin.ok) expect(noPin.message).toMatch(/R1 has no pin "7"/);
    });

    it('refuses a pin connected to itself', () => {
        const r = connectPins(CIRCUIT, { componentId: 'r1', pinId: '1' }, { componentId: 'r1', pinId: '1' });
        expect(r.ok).toBe(false);
    });

    it('leaves the original document untouched', () => {
        const before = JSON.stringify(CIRCUIT);
        connectPins(CIRCUIT, { componentId: 'r2', pinId: '2' }, { componentId: 'r1', pinId: '2' });
        expect(JSON.stringify(CIRCUIT)).toBe(before);
    });
});

describe('taking a pin off its net', () => {
    it('moves it to a NEW net, because the schema has no "unconnected"', () => {
        const r = ok(disconnectPin(CIRCUIT, { componentId: 'r1', pinId: '2' }));
        const moved = netOf(r.circuit, 'r1', '2');
        expect(moved).not.toBe('mid');
        expect((r.circuit.nets ?? []).some((n) => n.id === moved)).toBe(true);
        // …and the pin it used to share with is left where it was.
        expect(netOf(r.circuit, 'r2', '1')).toBe('mid');
    });

    it('warns when the net it left is now a single dangling pin', () => {
        const r = ok(disconnectPin(CIRCUIT, { componentId: 'r1', pinId: '2' }));
        expect(r.changed && r.note).toMatch(/MID is left with a single pin/);
    });

    it('is a NO-OP for a pin that is already alone', () => {
        // Moving it to another one-pin net would rename its node and change nothing electrical.
        const alone = ok(disconnectPin(CIRCUIT, { componentId: 'r1', pinId: '2' }));
        const again = disconnectPin(alone.circuit, { componentId: 'r1', pinId: '2' });
        expect(again.ok && again.changed).toBe(false);
    });

    it('generates the SAME net for the same document every time — undo and redo must agree', () => {
        // A random id would make history unreplayable: undo, redo, and the document differs from the one
        // the user saw.
        const a = ok(disconnectPin(CIRCUIT, { componentId: 'r1', pinId: '2' }));
        const b = ok(disconnectPin(CIRCUIT, { componentId: 'r1', pinId: '2' }));
        expect(JSON.stringify(a.circuit)).toBe(JSON.stringify(b.circuit));
    });

    it('never generates an id or a name something else is already using', () => {
        const crowded: CircuitJson = {
            ...CIRCUIT,
            nets: [...(CIRCUIT.nets ?? []), { id: 'n1', name: 'N1' }, { id: 'n2', name: 'n2' }],
        };
        const r = ok(disconnectPin(crowded, { componentId: 'r1', pinId: '2' }));
        const fresh = netOf(r.circuit, 'r1', '2')!;
        expect(['n1', 'n2']).not.toContain(fresh);
        // Case-insensitively, because setNetName treats a name collision that way and two rules that
        // disagreed would let one create what the other refuses.
        const names = (r.circuit.nets ?? []).map((n) => n.name.toLowerCase());
        expect(new Set(names).size).toBe(names.length);
    });
});

describe('splitting one net into two', () => {
    /** Four pins on one net — the shape where a split is the only sane repair. */
    const JOINED: CircuitJson = {
        ...CIRCUIT,
        components: CIRCUIT.components.map((c) => ({ ...c, pins: c.pins.map((p) => ({ ...p, netId: 'mid' })) })),
        nets: [{ id: 'mid', name: 'MID' }],
    };

    it('moves the chosen pins and leaves the rest', () => {
        const r = ok(
            splitNet(JOINED, 'mid', [
                { componentId: 'r1', pinId: '1' },
                { componentId: 'r1', pinId: '2' },
            ]),
        );
        const fresh = netOf(r.circuit, 'r1', '1');
        expect(fresh).not.toBe('mid');
        expect(netOf(r.circuit, 'r1', '2')).toBe(fresh);
        expect(netOf(r.circuit, 'r2', '1')).toBe('mid');
        expect(r.changed && r.note).toMatch(/2 of 6 pins moved from MID/);
    });

    it('does NOT carry a declared role onto the new half', () => {
        // A role is a declaration about a node, and the split half is a different node. Inheriting it would
        // silently declare a second ground.
        const grounded: CircuitJson = { ...JOINED, nets: [{ id: 'mid', name: 'MID', isGround: true }] };
        const r = ok(splitNet(grounded, 'mid', [{ componentId: 'r1', pinId: '1' }]));
        const fresh = (r.circuit.nets ?? []).find((n) => n.id !== 'mid');
        expect(fresh?.isGround).toBeUndefined();
    });

    it('refuses a split that takes every pin — that is a rename', () => {
        const all = JOINED.components.flatMap((c) => c.pins.map((p) => ({ componentId: c.id, pinId: p.pinId })));
        const r = splitNet(JOINED, 'mid', all);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('pointless-split');
    });

    it('refuses a split that takes none', () => {
        const r = splitNet(JOINED, 'mid', []);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('pointless-split');
    });

    it('counts a pin named twice ONCE, so "every pin" cannot be faked', () => {
        // Without dedup, naming one pin six times would read as "all six" and be refused, or as six of six
        // and pass — either way the count and reality disagree.
        const twice = [
            { componentId: 'r1', pinId: '1' },
            { componentId: 'r1', pinId: '1' },
        ];
        const r = ok(splitNet(JOINED, 'mid', twice));
        expect(r.changed && r.note).toMatch(/1 of 6 pins/);
    });

    it('refuses a pin that is on a DIFFERENT net, naming where it actually is', () => {
        const r = splitNet(CIRCUIT, 'mid', [{ componentId: 'v1', pinId: '+' }]);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.reason).toBe('pin-not-on-net');
            expect(r.message).toMatch(/is on VIN, not on MID/);
        }
    });

    it('refuses a net that does not exist', () => {
        const r = splitNet(CIRCUIT, 'nope', [{ componentId: 'r1', pinId: '1' }]);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('no-such-net');
    });
});

describe('ids that are not identifiers', () => {
    it('keeps pins apart even when an id contains the characters a separator would use', () => {
        // Ids are free-form strings. A key built as `${componentId} ${pinId}` collides for
        // ("a b","c") and ("a","b c"), and the first version of this module reached for a null byte to
        // dodge that — which made the source file read as binary to every tool that touched it.
        const odd: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'a b', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: 'c', netId: 'net' }] },
                { id: 'a', type: 'resistor', designator: 'R2', value: '1k', pins: [{ pinId: 'b c', netId: 'net' }] },
            ],
            nets: [{ id: 'net', name: 'NET' }],
        };
        const r = ok(splitNet(odd, 'net', [{ componentId: 'a b', pinId: 'c' }]));
        expect(netOf(r.circuit, 'a b', 'c')).not.toBe('net');
        expect(netOf(r.circuit, 'a', 'b c')).toBe('net'); // the other pin did NOT move
    });
});
