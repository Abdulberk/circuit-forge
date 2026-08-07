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
