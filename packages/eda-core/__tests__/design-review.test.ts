/**
 * Pre-layout design-review graph check — orientation ROLE-consistency. Pure function over OUR CircuitJson;
 * no mocks. Locks the HONEST CEILING (diode/zener/LED role-level only; polarized caps unrepresentable →
 * never evaluated) and the case-SENSITIVE contract (it must match the netlist generator exactly).
 *
 * (Decoupling presence was deferred — the model has no power-rail marking to identify a rail without false
 * positives on DC signal/reference nets and `generic` connectors; disclosed not-run in the manifest.)
 */
import type { CircuitJson } from '../src/types/circuit';
import { checkOrientationConsistency } from '../src/verification/design-review';

const nets = (...ids: string[]): CircuitJson['nets'] =>
    ids.map((id) => ({ id, name: id.toUpperCase(), ...(id === 'gnd' ? { isGround: true } : {}) }));
const diode = (id: string, p1: [string, string], p2: [string, string]): CircuitJson['components'][number] =>
    ({
        id,
        type: 'diode',
        designator: id.toUpperCase(),
        model: 'led_red',
        pins: [
            { pinId: p1[0], netId: p1[1] },
            { pinId: p2[0], netId: p2[1] },
        ],
    }) as CircuitJson['components'][number];
const cap = (id: string, a: string, b: string): CircuitJson['components'][number] =>
    ({
        id,
        type: 'capacitor',
        designator: id.toUpperCase(),
        value: '100n',
        pins: [
            { pinId: '1', netId: a },
            { pinId: '2', netId: b },
        ],
    }) as CircuitJson['components'][number];

describe('checkOrientationConsistency — role-consistency for diode/zener/LED only', () => {
    it('a diode declaring anode + cathode is consistent (no issue)', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [diode('d1', ['anode', 'a'], ['cathode', 'k'])],
            nets: nets('a', 'k'),
        };
        const r = checkOrientationConsistency(c);
        expect(r.checked).toBe(true);
        expect(r.issues).toEqual([]);
        expect(r.manifestEntry).toMatchObject({ status: 'run' });
        expect(r.manifestEntry.detail).toMatch(/NOT polarized/i);
    });

    it('flags a diode authored with bare 1/2 pins (orientation unspecified)', () => {
        const c: CircuitJson = {
            version: '1.0',
            components: [diode('d1', ['1', 'a'], ['2', 'k'])],
            nets: nets('a', 'k'),
        };
        const r = checkOrientationConsistency(c);
        expect(r.issues).toHaveLength(1);
        expect(r.issues[0]!.designator).toBe('D1');
        expect(r.issues[0]!.issue).toMatch(/anode and cathode/);
    });

    it('flags a MIS-CASED role (Anode/CATHODE) — matches the generator’s case-sensitive contract', () => {
        // the netlist generator binds `pins.find(p => p.pinId === 'anode')`; a lowercase-normalized check
        // would pass this and then the generator would throw — so the check must flag it here.
        const c: CircuitJson = {
            version: '1.0',
            components: [diode('d1', ['Anode', 'a'], ['CATHODE', 'k'])],
            nets: nets('a', 'k'),
        };
        expect(checkOrientationConsistency(c).issues).toHaveLength(1);
    });

    it('does NOT cover a polarized capacitor (no polarity role in the schema)', () => {
        const c: CircuitJson = { version: '1.0', components: [cap('c1', 'vplus', 'gnd')], nets: nets('vplus', 'gnd') };
        const r = checkOrientationConsistency(c);
        expect(r.checked).toBe(false); // capacitors are never evaluated for polarity
        expect(r.issues).toEqual([]);
        expect(r.manifestEntry.status).toBe('not-run');
    });
});
