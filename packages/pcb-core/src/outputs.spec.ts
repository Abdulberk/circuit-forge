import type { CircuitJson } from '@circuit-forge/eda-core';

import { classifyCircuit } from './layoutability';
import { buildBomCsv, buildPnpCsv } from './outputs';
import type { TscElement } from './parity';

const circuit: CircuitJson = {
    version: '1.0',
    components: [
        {
            id: 'r1',
            type: 'resistor',
            designator: 'R1',
            value: '10k',
            mpn: 'RC0603FR-0710KL',
            manufacturer: 'YAGEO, Inc.',
            pins: [
                { pinId: '1', netId: 'a' },
                { pinId: '2', netId: 'b' },
            ],
        },
        { id: 'g1', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'b' }] },
    ],
    nets: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B', isGround: true },
    ],
};

describe('buildBomCsv', () => {
    it('lists only physical components, carries catalog fields, escapes commas', () => {
        const csv = buildBomCsv(classifyCircuit(circuit));
        const lines = csv.trim().split('\n');
        expect(lines[0]).toBe('Designator,Type,Value,Footprint,MPN,Manufacturer');
        expect(lines).toHaveLength(2); // ground is net-only, not a BOM line
        expect(lines[1]).toBe('R1,resistor,10k,0603,RC0603FR-0710KL,"YAGEO, Inc."');
    });
});

describe('buildPnpCsv', () => {
    it('joins pcb_component placements back to designators', () => {
        const evaluated: TscElement[] = [
            { type: 'source_component', source_component_id: 'sc1', name: 'R1' },
            { type: 'pcb_component', source_component_id: 'sc1', center: { x: 1.5, y: -2 }, rotation: 90, layer: 'top' },
        ];
        const csv = buildPnpCsv(evaluated);
        expect(csv).toContain('R1,1.5,-2,90,top');
    });
});
