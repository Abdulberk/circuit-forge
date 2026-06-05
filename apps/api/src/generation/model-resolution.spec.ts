import { attachGenericModels } from './model-resolution';
import type { CircuitJson } from '@circuit-forge/eda-core';

describe('attachGenericModels', () => {
    it('injects the body of a referenced generic model into circuit.models', () => {
        const circuit: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'q1', type: 'bjt', designator: 'Q1', model: 'QGENNPN', pins: [
                    { pinId: 'c', netId: 'col' }, { pinId: 'b', netId: 'base' }, { pinId: 'e', netId: '0' }] },
            ],
            nets: [{ id: 'col', name: 'COL' }, { id: 'base', name: 'BASE' }, { id: '0', name: '0', isGround: true }],
        };
        attachGenericModels(circuit);
        const m = circuit.models?.find((x) => x.name === 'QGENNPN');
        expect(m).toBeTruthy();
        expect(m!.body).toContain('.model QGENNPN NPN(');
    });

    it('dedupes a model across components and ignores non-generic (vendor) model names', () => {
        const circuit: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'q1', type: 'bjt', designator: 'Q1', model: 'QGENNPN', pins: [
                    { pinId: 'c', netId: 'a' }, { pinId: 'b', netId: 'b' }, { pinId: 'e', netId: '0' }] },
                { id: 'q2', type: 'bjt', designator: 'Q2', model: 'QGENNPN', pins: [
                    { pinId: 'c', netId: 'c' }, { pinId: 'b', netId: 'b' }, { pinId: 'e', netId: '0' }] },
                { id: 'd1', type: 'diode', designator: 'D1', model: 'SOMEVENDORLIB', pins: [
                    { pinId: 'anode', netId: 'a' }, { pinId: 'cathode', netId: '0' }] },
            ],
            nets: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: '0', name: '0', isGround: true }],
        };
        attachGenericModels(circuit);
        expect(circuit.models!.filter((m) => m.name === 'QGENNPN')).toHaveLength(1);
        // An unknown (vendor) model name is left for an .include lib — never fabricated here.
        expect(circuit.models!.some((m) => m.name === 'SOMEVENDORLIB')).toBe(false);
    });

    it('is idempotent', () => {
        const circuit: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'm1', type: 'mosfet', designator: 'M1', model: 'MGENNMOS', pins: [
                    { pinId: 'd', netId: 'x' }, { pinId: 'g', netId: 'g' }, { pinId: 's', netId: '0' }, { pinId: 'b', netId: '0' }] },
            ],
            nets: [{ id: 'x', name: 'X' }, { id: 'g', name: 'G' }, { id: '0', name: '0', isGround: true }],
        };
        attachGenericModels(circuit);
        const n = circuit.models!.length;
        attachGenericModels(circuit);
        expect(circuit.models!.length).toBe(n);
    });
});
