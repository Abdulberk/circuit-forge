/**
 * Every generic part can be placed, and arrives as a part the rest of the system accepts.
 *
 * The defect this library closes: a palette part arrived with no value, so it was an ERC finding and a
 * netlist the simulator refused until somebody typed a number. Asserted against the REAL kernel, ERC and
 * netlist generator, not against a copy of their rules.
 */
import { generateNetlist, genericModelByName, runErc, type CircuitJson } from '@circuit-forge/eda-core';

import { addComponent } from '../document/parts';

import { GENERIC_PARTS, defaultPartFor, genericPart, isPlaceableType, searchGenericParts } from './generic';

const EMPTY: CircuitJson = { version: '1.0', components: [], nets: [] };

describe('the generic part library', () => {
    it('has unique ids, and every part is a fixed-arity type the kernel can create blank', () => {
        expect(new Set(GENERIC_PARTS.map((p) => p.id)).size).toBe(GENERIC_PARTS.length);
        for (const p of GENERIC_PARTS)
            expect({ id: p.id, placeable: isPlaceableType(p.part.type) }).toEqual({ id: p.id, placeable: true });
    });

    it('never places a valueless part: each one carries a value or a model', () => {
        for (const p of GENERIC_PARTS)
            expect({ id: p.id, ok: Boolean(p.part.value || p.part.model) }).toEqual({ id: p.id, ok: true });
    });

    it('names only models eda-core actually has (or its built-in diode)', () => {
        for (const p of GENERIC_PARTS) {
            const model = p.part.model;
            if (!model) continue;
            expect({ id: p.id, known: model === 'DDEFAULT' || genericModelByName(model) !== undefined }).toEqual({
                id: p.id,
                known: true,
            });
        }
    });

    it('every part is accepted by the kernel, raises no value/model ERC error, and netlists', () => {
        for (const p of GENERIC_PARTS) {
            const added = addComponent(EMPTY, p.part);
            if (!added.ok || !added.changed) throw new Error(`${p.id}: ${added.ok ? 'nothing added' : added.message}`);
            const errors = runErc(added.circuit)
                .issues.filter((i) => i.severity === 'error')
                .filter((i) => /value|model/i.test(i.message));
            expect({ id: p.id, errors: errors.map((e) => e.message) }).toEqual({ id: p.id, errors: [] });
            expect(() => generateNetlist(added.circuit, { type: 'op' })).not.toThrow();
        }
    });

    it('finds parts by name, designator letter and common word', () => {
        expect(searchGenericParts('').length).toBe(GENERIC_PARTS.length);
        expect(searchGenericParts('cap').map((p) => p.id)).toContain('generic:capacitor');
        expect(searchGenericParts('q').map((p) => p.id)).toEqual(
            expect.arrayContaining(['generic:npn', 'generic:pnp', 'generic:nmos', 'generic:pmos']),
        );
        expect(searchGenericParts('LED').map((p) => p.id)).toEqual(['generic:led-red']);
        expect(searchGenericParts('zzz')).toEqual([]);
    });

    it('resolves a definition by id and a default by type', () => {
        expect(genericPart('generic:resistor')?.part.value).toBe('10k');
        expect(defaultPartFor('capacitor')?.part.value).toBe('100n');
        expect(defaultPartFor('bjt')?.id).toBe('generic:npn');
        expect(genericPart('nope')).toBeUndefined();
    });
});
