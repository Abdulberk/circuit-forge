import type { CircuitJson } from '@circuit-forge/eda-core';
import { BadRequestException } from '@nestjs/common';

import { NetlistService } from './netlist.service';

const svc = new NetlistService();

const divider: CircuitJson = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 10', pins: [
            { pinId: '+', netId: 'vin' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [
            { pinId: '1', netId: 'vin' }, { pinId: '2', netId: 'mid' }] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '1k', pins: [
            { pinId: '1', netId: 'mid' }, { pinId: '2', netId: 'gnd' }] },
    ],
    nets: [
        { id: 'vin', name: 'VIN' }, { id: 'mid', name: 'MID' }, { id: 'gnd', name: 'GND', isGround: true },
    ],
};

describe('NetlistService', () => {
    it('exports a self-contained deck with the analysis card and probes', () => {
        const deck = svc.export(divider, { type: 'tran', stopTime: '1m' }, ['v(mid)']);
        expect(deck).toContain('R1 ');
        expect(deck).toContain('.tran');
        expect(deck).toContain('wrdata output.csv v(nmid)'); // probe remapped to the sanitized node
        expect(deck).toContain('.end');
    });

    it('inlines generic model bodies on export (self-contained deck)', () => {
        const withLed: CircuitJson = {
            ...divider,
            components: [
                ...divider.components,
                { id: 'd1', type: 'diode', designator: 'DA1', model: 'LEDRED', pins: [
                    { pinId: 'anode', netId: 'mid' }, { pinId: 'cathode', netId: 'gnd' }] },
            ],
        };
        const deck = svc.export(withLed);
        expect(deck).toContain('.model LEDRED D('); // body attached by name, like the sim path
    });

    it('round-trips: an exported deck imports back to the same topology', () => {
        const deck = svc.export(divider, { type: 'tran', stopTime: '1m' });
        const back = svc.import(deck);
        expect(back.errors).toEqual([]);
        expect(back.schemaValid).toBe(true);
        const types = back.circuit.components.map((c) => c.type).sort();
        // the parser synthesizes a ground symbol for the '0' net (so the editor renders one)
        expect(types).toEqual(['ground', 'resistor', 'resistor', 'voltage_source']);
        expect(back.analysis?.type).toBe('tran');
        // ground survives as the '0' net
        expect(back.circuit.nets.some((n) => n.isGround)).toBe(true);
    });

    it('imports a foreign (LTspice-style) deck and reports the analysis', () => {
        const ltspice = `* RC low-pass
V1 in 0 SIN(0 5 1k)
R1 in out 1k
C1 out 0 100n
.tran 10u 5m
.end`;
        const r = svc.import(ltspice);
        expect(r.errors).toEqual([]);
        expect(r.schemaValid).toBe(true);
        expect(r.circuit.components).toHaveLength(4); // V1 + R1 + C1 + the synthesized ground symbol
        expect(r.analysis).toMatchObject({ type: 'tran', stopTime: '5m' });
    });

    it('rejects an invalid circuit on export with a 400 naming the issue', () => {
        expect(() => svc.export({ version: '1.0', components: [], nets: [] })).toThrow(BadRequestException);
        expect(() => svc.export(divider, { type: 'nope' })).toThrow(/AnalysisConfig/);
    });

    it('surfaces generator authoring errors as 400 (e.g. AC analysis without an AC source)', () => {
        expect(() => svc.export(divider, { type: 'ac', variation: 'dec', points: 10, startFreq: '1', stopFreq: '1k' }))
            .toThrow(/AC magnitude/);
    });
});
