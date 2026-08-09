/**
 * What a copy MEANS, which is three decisions the word "duplicate" does not settle.
 *
 * Copying is the gesture people reach for when they want another of something they have already got right —
 * a divider, a filter stage, a decoupling pair. So the answers below are about that: keep what makes the
 * copied group a group, drop what would silently attach it to the rest of the design, and share the one
 * node that is shared by definition.
 */

import type { CircuitJson } from '@circuit-forge/eda-core';

import { duplicateComponents } from './parts';

const R = (id: string, a: string, b: string) => ({
    id,
    type: 'resistor' as const,
    designator: id.toUpperCase(),
    value: '1k',
    pins: [
        { pinId: '1', netId: a },
        { pinId: '2', netId: b },
    ],
});

/** A divider hanging off a rail: two resistors joined to each other, one to the rail, one to ground. */
const CIRCUIT: CircuitJson = {
    version: '1.0',
    components: [R('r1', 'rail', 'mid'), R('r2', 'mid', 'gnd'), R('r3', 'rail', 'other')] as never,
    nets: [
        { id: 'rail', name: 'RAIL' },
        { id: 'mid', name: 'MID' },
        { id: 'other', name: 'OTHER' },
        { id: 'gnd', name: 'GND', isGround: true },
    ],
};

const netsOf = (c: CircuitJson, id: string): string[] =>
    c.components!.find((x) => x.id === id)!.pins.map((p) => p.netId);

describe('copying parts', () => {
    it('keeps the wiring that is ENTIRELY among the copies', () => {
        // The whole point of the gesture. Copying a divider and getting two loose resistors would make it
        // useless for the thing people actually copy.
        const out = duplicateComponents(CIRCUIT, ['r1', 'r2']);
        expect(out.ok && out.changed).toBe(true);
        if (!out.ok || !out.changed) return;

        const [a, b] = out.created!;
        // The copies share a net where the originals did — and it is a NEW net, not the original's.
        const shared = netsOf(out.circuit, a!).filter((n) => netsOf(out.circuit, b!).includes(n));
        expect(shared).toHaveLength(1);
        expect(shared[0]).not.toBe('mid');
        // …and the originals are untouched.
        expect(netsOf(out.circuit, 'r1')).toEqual(['rail', 'mid']);
        expect(netsOf(out.circuit, 'r2')).toEqual(['mid', 'gnd']);
    });

    it('does NOT attach the copies to the rest of the design', () => {
        // A copied terminal whose net reaches outside the selection arrives unconnected. Keeping it would
        // make five pasted parts into five connections nobody asked for — and in a document where a
        // connection is the entire meaning, a user cannot undo what they cannot see they did.
        const out = duplicateComponents(CIRCUIT, ['r1', 'r2']);
        if (!out.ok || !out.changed) throw new Error('expected a change');
        const [a] = out.created!;
        expect(netsOf(out.circuit, a!)).not.toContain('rail');
    });

    it('SHARES the reference rather than copying it', () => {
        // Ground is one node for the whole design. A second ground net would be drawn identically to the
        // first — every ground symbol looks like every other — and no reader could tell them apart.
        const out = duplicateComponents(CIRCUIT, ['r2']);
        if (!out.ok || !out.changed) throw new Error('expected a change');
        expect(netsOf(out.circuit, out.created![0]!)).toContain('gnd');
        expect((out.circuit.nets ?? []).filter((n) => n.isGround)).toHaveLength(1);
    });

    it('carries the part’s identity, not just its type', () => {
        // MPN, footprint and tolerance are what the package check compares, what the robustness verdict
        // spreads over, and what the BOM is ordered from. A copy that lost them would turn a real part into
        // a generic without saying so.
        const withIdentity: CircuitJson = {
            ...CIRCUIT,
            components: [
                { ...R('r1', 'rail', 'mid'), mpn: 'RC0603FR-0710KL', footprint: '0603', tolerance: 0.01 },
            ] as never,
        };
        const out = duplicateComponents(withIdentity, ['r1']);
        if (!out.ok || !out.changed) throw new Error('expected a change');
        const copy = out.circuit.components!.find((c) => c.id === out.created![0])!;
        expect(copy).toEqual(
            expect.objectContaining({ mpn: 'RC0603FR-0710KL', footprint: '0603', tolerance: 0.01, value: '1k' }),
        );
    });

    it('names the copies, in the order they were asked for', () => {
        // A caller that has just pasted five parts has to select and place them, and cannot work out which
        // ones they are: designators are allocated against a document that changes as each one lands.
        const out = duplicateComponents(CIRCUIT, ['r1', 'r3']);
        if (!out.ok || !out.changed) throw new Error('expected a change');
        expect(out.created).toHaveLength(2);
        expect(out.created).not.toContain('r1');
        const designators = out.created!.map((id) => out.circuit.components!.find((c) => c.id === id)!.designator);
        expect(new Set(designators).size).toBe(2);
    });

    it('refuses a part that is not there, rather than copying what it can', () => {
        const out = duplicateComponents(CIRCUIT, ['r1', 'nope']);
        expect(out.ok).toBe(false);
        // And the document is untouched — a partial copy is a document nobody asked for.
        expect(CIRCUIT.components).toHaveLength(3);
    });

    it('copying nothing is not a change', () => {
        const out = duplicateComponents(CIRCUIT, []);
        expect(out).toEqual({ ok: true, circuit: CIRCUIT, changed: false });
    });

    it('leaves no net behind that nothing is on', () => {
        // `addComponent` gives every new pin its own net, and re-pointing the copies leaves some of those
        // unreferenced. A net with no pins is not a node, and one in the document invites a reader to look
        // for the connection it implies.
        const out = duplicateComponents(CIRCUIT, ['r1', 'r2']);
        if (!out.ok || !out.changed) throw new Error('expected a change');
        const used = new Set(out.circuit.components!.flatMap((c) => c.pins.map((p) => p.netId)));
        expect((out.circuit.nets ?? []).filter((n) => !used.has(n.id) && !n.isGround)).toEqual([]);
    });
});

describe('what a copy must not lose or invent', () => {
    /** A diode whose pins are listed CATHODE FIRST — legal, and not the order the type declares. */
    const REVERSED: CircuitJson = {
        version: '1.0',
        components: [
            {
                id: 'd1',
                type: 'diode',
                designator: 'D1',
                model: '1N4148',
                pins: [
                    { pinId: 'cathode', netId: 'mid' },
                    { pinId: 'anode', netId: 'a' },
                ],
            },
            R('r9', 'mid', 'b'),
        ] as never,
        nets: [
            { id: 'a', name: 'A' },
            { id: 'b', name: 'B' },
            { id: 'mid', name: 'MID' },
        ],
    };

    it('does not turn a polarised part AROUND', () => {
        // The defect this test exists for: the copy's pins were matched to the original BY POSITION, and
        // `addComponent` builds them in the type's CANONICAL order — so a diode STORED cathode-first came back
        // with its anode where its cathode had been. The same part, wired backwards, drawn identically.
        //
        // Two parts are copied together on purpose. A lone part's copy is left unconnected either way, so a
        // one-part test cannot tell the two rules apart — it would report green while the bug sat there.
        const out = duplicateComponents(REVERSED, ['d1', 'r9']);
        expect(out.ok && out.changed).toBe(true);
        if (!out.ok || !out.changed) return;

        const copy = out.circuit.components!.find((c) => c.id === out.created![0])!;
        const copiedR = out.circuit.components!.find((c) => c.id === out.created![1])!;

        // `mid` was the node BETWEEN the two originals, so it travels with them onto a fresh node of its own.
        // In the original it is the diode's CATHODE that sits there — so it must be the copy's cathode too.
        const joint = copiedR.pins.find((q) => q.pinId === '1')!.netId;
        expect(copy.pins.find((q) => q.pinId === 'cathode')!.netId).toBe(joint);
        expect(copy.pins.find((q) => q.pinId === 'anode')!.netId).not.toBe(joint);
        // And it is genuinely a NEW node, not the original's — the copies are separate from what they copy.
        expect(joint).not.toBe('mid');
    });

    it('carries the fields a netlist needs and the palette does not know about', () => {
        // `properties` is where a transmission line's impedance and delay live. A copy without them is a part
        // the generator cannot emit at all — and the copy looked fine on the sheet, so the first sign of it
        // would have been a simulation failing on a board the user believed they had duplicated.
        const withProps: CircuitJson = {
            version: '1.0',
            components: [
                {
                    ...R('r1', 'a', 'b'),
                    properties: { z0: '50', td: '10n' },
                } as never,
            ],
            nets: [
                { id: 'a', name: 'A' },
                { id: 'b', name: 'B' },
            ],
        };
        const out = duplicateComponents(withProps, ['r1']);
        expect(out.ok && out.changed).toBe(true);
        if (!out.ok || !out.changed) return;
        const copy = out.circuit.components!.find((c) => c.id === out.created![0])! as unknown as {
            properties?: Record<string, string>;
        };
        expect(copy.properties).toEqual({ z0: '50', td: '10n' });
    });

    it('does not carry a key that has no value', () => {
        // The working copy is compared by value to decide what is unsaved. A field written as `undefined`
        // is a key that exists and says nothing — it survives the comparison as a difference, so a copy
        // would mark the document dirty the instant it landed, over a change nobody made.
        const sloppy: CircuitJson = {
            version: '1.0',
            components: [{ ...R('r1', 'a', 'b'), footprint: undefined, properties: undefined } as never],
            nets: [
                { id: 'a', name: 'A' },
                { id: 'b', name: 'B' },
            ],
        };
        const out = duplicateComponents(sloppy, ['r1']);
        expect(out.ok && out.changed).toBe(true);
        if (!out.ok || !out.changed) return;
        const copy = out.circuit.components!.find((c) => c.id === out.created![0])!;
        expect(Object.keys(copy)).not.toContain('footprint');
        expect(Object.keys(copy)).not.toContain('properties');
    });

    it('does not delete a net somebody NAMED and has not wired yet', () => {
        // Copying is an addition. It used to prune every net no component referenced, which swept away a net
        // the user had created and left for later — a part of the design lost as a side effect of an
        // unrelated gesture, with an undo step recorded as though nothing had gone missing.
        const withSpare: CircuitJson = {
            ...CIRCUIT,
            nets: [...CIRCUIT.nets!, { id: 'spare', name: 'SPARE' }],
        };
        const out = duplicateComponents(withSpare, ['r3']);
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.circuit.nets!.map((n) => n.id)).toContain('spare');
    });

    it('still drops the private nets it minted itself', () => {
        // The other half of that bargain: narrowing the prune must not turn it off. A copy's unconnected pin
        // gets a fresh net from `addComponent`, and if the pin is then re-pointed at a shared net, the fresh
        // one is a node with nothing on it.
        const out = duplicateComponents(CIRCUIT, ['r1', 'r2']);
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        const referenced = new Set(out.circuit.components!.flatMap((c) => c.pins.map((q) => q.netId)));
        const orphans = out.circuit.nets!.filter(
            (n) => !referenced.has(n.id) && !CIRCUIT.nets!.some((o) => o.id === n.id),
        );
        expect(orphans).toEqual([]);
    });

    it('copies the parts in a selection that also caught a GROUND SYMBOL', () => {
        // A box selection catches whatever it encloses, and a ground marker has no designator prefix — so
        // `addComponent` could not name a copy of one and refused the ENTIRE gesture with "no designator
        // could be derived". The user's parts were not copied and the message named nothing they had done.
        // A marker is notation: the drawing marks every ground terminal for itself, so it is skipped.
        const withMarker: CircuitJson = {
            ...CIRCUIT,
            components: [
                ...CIRCUIT.components!,
                { id: 'gm1', type: 'ground', designator: '', pins: [{ pinId: '1', netId: 'gnd' }] } as never,
            ],
        };
        const out = duplicateComponents(withMarker, ['r1', 'gm1']);
        expect(out.ok && out.changed).toBe(true);
        if (!out.ok || !out.changed) return;
        expect(out.created).toHaveLength(1);
        expect(out.circuit.components!.find((c) => c.id === out.created![0])!.type).toBe('resistor');
    });

    it('says which copy came from which part, so a caller need not guess', () => {
        // The caller places each copy relative to the part it was copied FROM. It used to pair the two lists
        // up by position, which held only while every selected thing was copied — a box that caught a ground
        // marker shifted the lists by one and the offset landed on the wrong part. Silently, and only on the
        // sheets where it happened.
        const withMarker: CircuitJson = {
            ...CIRCUIT,
            components: [
                ...CIRCUIT.components!,
                { id: 'gm1', type: 'ground', designator: '', pins: [{ pinId: '1', netId: 'gnd' }] } as never,
            ],
        };
        const out = duplicateComponents(withMarker, ['gm1', 'r1', 'r3']);
        expect(out.ok && out.changed).toBe(true);
        if (!out.ok || !out.changed) return;
        expect(out.derivedFrom).toEqual(['r1', 'r3']);
        expect(out.created).toHaveLength(2);
        // The pairing is by INDEX between these two lists, so they have to be the same length — a caller
        // reading past the end would get `undefined` and skip the offset without saying so.
        expect(out.derivedFrom!.length).toBe(out.created!.length);
        // And each copy really is a copy of the part it names.
        const typeOf = (id: string) => out.circuit.components!.find((c) => c.id === id)!.type;
        out.created!.forEach((id, k) => expect(typeOf(id)).toBe(typeOf(out.derivedFrom![k]!)));
    });

    it('is not a revision when the selection was ONLY markers', () => {
        const withMarker: CircuitJson = {
            ...CIRCUIT,
            components: [
                ...CIRCUIT.components!,
                { id: 'gm1', type: 'ground', designator: '', pins: [{ pinId: '1', netId: 'gnd' }] } as never,
            ],
        };
        const out = duplicateComponents(withMarker, ['gm1']);
        expect(out.ok && out.changed).toBe(false);
    });
});

describe('the shapes a part can actually have', () => {
    const GATE: CircuitJson = {
        version: '1.0',
        components: [
            {
                id: 'u1',
                type: 'logic_and',
                designator: 'U1',
                pins: [
                    { pinId: 'in1', netId: 'a' },
                    { pinId: 'in2', netId: 'b' },
                    { pinId: 'in3', netId: 'c' },
                    { pinId: 'out', netId: 'y' },
                ],
            },
            {
                // A flip-flop authored WITHOUT set/rst, which is legal: the generator ties an omitted one to
                // the inactive rail for you.
                id: 'u2',
                type: 'dff',
                designator: 'U2',
                pins: [
                    { pinId: 'd', netId: 'a' },
                    { pinId: 'clk', netId: 'clk' },
                    { pinId: 'q', netId: 'y' },
                    { pinId: 'qb', netId: 'yb' },
                ],
            },
        ] as never,
        nets: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'y' }, { id: 'clk' }, { id: 'yb' }] as never,
    };

    it('copies a part whose pin count is its own business', () => {
        // A logic gate, a subckt and a catalogue generic have no canonical pin list — their shape IS the
        // design. Building the copy from the canonical list meant there was nothing to build from, so
        // copying one was refused outright with a message about the part palette, which the user was not in.
        const out = duplicateComponents(GATE, ['u1']);
        expect(out.ok && out.changed).toBe(true);
        if (!out.ok || !out.changed) return;
        const copy = out.circuit.components!.find((c) => c.id === out.created![0])!;
        expect(copy.pins.map((q) => q.pinId)).toEqual(['in1', 'in2', 'in3', 'out']);
    });

    it('does not GIVE a copy pins the original chose to leave off', () => {
        // The quietest defect in this file. `set` and `rst` are optional, and the netlist generator ties an
        // omitted one to the inactive rail. Hand the copy those pins on fresh private nets and they become
        // real floating inputs — a part that is drawn identically to the one it was copied from and does not
        // behave like it. Nothing on the sheet would show the difference.
        const out = duplicateComponents(GATE, ['u2']);
        expect(out.ok && out.changed).toBe(true);
        if (!out.ok || !out.changed) return;
        const copy = out.circuit.components!.find((c) => c.id === out.created![0])!;
        expect(copy.pins.map((q) => q.pinId)).toEqual(['d', 'clk', 'q', 'qb']);
    });

    it('keeps a copy ON the supply rail, the way it keeps it on ground', () => {
        // A rail is a net the sheet MARKS rather than wires — global by definition, exactly like ground. A
        // copy pushed onto a fresh private net comes back unpowered, and unmarked too, because the marker
        // follows the net's own flag. Only ground was shared, so "copy this stage" meant two different
        // things at the two ends of the same part.
        const POWERED: CircuitJson = {
            version: '1.0',
            components: [R('r1', 'vcc', 'out')] as never,
            nets: [
                { id: 'vcc', name: 'VCC', isPower: true },
                { id: 'out', name: 'OUT' },
            ] as never,
        };
        const out = duplicateComponents(POWERED, ['r1']);
        expect(out.ok && out.changed).toBe(true);
        if (!out.ok || !out.changed) return;
        const copy = out.circuit.components!.find((c) => c.id === out.created![0])!;
        expect(copy.pins.find((q) => q.pinId === '1')!.netId).toBe('vcc');
        // ...and the signal end is still cut, which is the whole reason copying is not just re-instancing.
        expect(copy.pins.find((q) => q.pinId === '2')!.netId).not.toBe('out');
    });
});

describe('a value that is also wiring', () => {
    /**
     * A behavioural source's value is an expression over NODES — `V=v(mid)*2` — and the netlist generator
     * resolves those names against the circuit's nets. Copied verbatim, the copy's pins were correctly cut
     * onto fresh private nets while its expression went on reading the ORIGINAL's nodes: silently joined to
     * the rest of the design, which is the one thing this function's header promises never to do.
     */
    const B = (id: string, value: string, a: string, b: string) => ({
        id,
        type: 'bsource',
        designator: id.toUpperCase(),
        value,
        pins: [
            { pinId: '+', netId: a },
            { pinId: '-', netId: b },
        ],
    });

    const withSource = (value: string): CircuitJson =>
        ({
            version: '1.0',
            components: [R('r1', 'in', 'mid'), R('r2', 'mid', 'gnd'), B('b1', value, 'mid', 'gnd')],
            nets: [{ id: 'in' }, { id: 'mid' }, { id: 'gnd', isGround: true }],
        }) as unknown as CircuitJson;

    it('re-points a reference to a node that TRAVELLED with the selection', () => {
        // `mid` has two terminals inside the selection, so it is copied — and the expression must follow the
        // copy exactly as the pins do.
        const out = duplicateComponents(withSource('V=v(mid)*2'), ['r1', 'r2', 'b1']);
        expect(out.ok && out.changed).toBe(true);
        if (!out.ok || !out.changed) return;
        const copy = out.circuit.components!.find((c) => c.designator === 'B2')! as {
            value?: string;
            pins: Array<{ netId: string }>;
        };
        expect(copy.value).not.toContain('v(mid)');
        // It reads the node its own + pin is on, which is what the original did.
        expect(copy.value).toContain(`v(${copy.pins[0]!.netId})`);
    });

    it('REPORTS a reference it cannot re-point, rather than leaving it silent', () => {
        // Copy the source alone: there is no copy of `mid` to point at, so the expression still reads the
        // original's node. That is a connection to the rest of the design, and the user cannot undo what
        // nobody told them about.
        const out = duplicateComponents(withSource('V=v(mid)*2'), ['b1']);
        expect(out.ok && out.changed).toBe(true);
        if (!out.ok || !out.changed) return;
        expect(out.note ?? '').toContain('reads node mid');
    });

    it('leaves a RAIL reference alone and says nothing about it', () => {
        // Ground is shared by definition — the pins are shared too — so reading it is not a connection the
        // copy acquired, and reporting it would be noise on every copy of every source.
        const out = duplicateComponents(withSource('V=v(gnd)*2'), ['b1']);
        expect(out.ok && out.changed).toBe(true);
        if (!out.ok || !out.changed) return;
        const copy = out.circuit.components!.find((c) => c.designator === 'B2')! as { value?: string };
        expect(copy.value).toBe('V=v(gnd)*2');
        expect(out.note ?? '').not.toContain('reads node');
    });

    it('touches nothing on a part whose value is not an expression', () => {
        // A resistor's `1k` must not be mangled by a rule about node references.
        const out = duplicateComponents(withSource('V=v(mid)*2'), ['r1']);
        expect(out.ok && out.changed).toBe(true);
        if (!out.ok || !out.changed) return;
        const copy = out.circuit.components!.find((c) => c.id === out.created![0])! as { value?: string };
        expect(copy.value).toBe('1k');
    });
});
