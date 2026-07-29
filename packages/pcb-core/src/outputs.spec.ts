import type { CircuitJson } from '@circuit-forge/eda-core';

import { classifyCircuit } from './layoutability';
import { buildBomCsv, buildPnpCsv, showReferenceDesignators } from './outputs';
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
            {
                type: 'pcb_component',
                source_component_id: 'sc1',
                center: { x: 1.5, y: -2 },
                rotation: 90,
                layer: 'top',
            },
        ];
        const csv = buildPnpCsv(evaluated);
        expect(csv).toContain('R1,1.5,-2,90,top');
    });
});


describe('showReferenceDesignators — the board says which part is which', () => {
    /** The exact block circuit-json-to-kicad emits (copied from a real generated board). */
    const property = (name: string, layer: string) =>
        [
            `    (property "${name}" "U1"`,
            '      (at 0 -3 0)',
            `      (layer ${layer})`,
            '      (hide yes)',
            '      (uuid 65eabe80-6cf1-7821-3fcd-aec212a9e563)',
            '      (effects (font (size 1.27 1.27) (thickness 0.15)))',
            '    )',
        ].join('\n');

    it('unhides the Reference so it is actually printed on silkscreen', () => {
        const out = showReferenceDesignators(property('Reference', 'F.SilkS'));
        expect(out).not.toContain('(hide yes)');
        expect(out).toContain('(property "Reference" "U1"');
        expect(out).toContain('(layer F.SilkS)');
    });

    it.each(['Value', 'Datasheet', 'Description'])('leaves %s hidden — silkscreen is not a dumping ground', (name) => {
        expect(showReferenceDesignators(property(name, 'F.Fab'))).toContain('(hide yes)');
    });

    it('unhides EVERY footprint, not just the first', () => {
        const board = [property('Reference', 'F.SilkS'), property('Reference', 'F.SilkS')].join('\n');
        expect(showReferenceDesignators(board)).not.toContain('(hide yes)');
    });

    it('unhides only the Reference when both properties sit on the same footprint', () => {
        const board = [property('Reference', 'F.SilkS'), property('Value', 'F.Fab')].join('\n');
        const out = showReferenceDesignators(board);
        expect(out.match(/\(hide yes\)/g)).toHaveLength(1);
        expect(out.slice(out.indexOf('"Value"'))).toContain('(hide yes)');
    });

    it('removes the flag and NOTHING else — uuid, position, layer and effects survive', () => {
        const src = property('Reference', 'F.SilkS');
        expect(showReferenceDesignators(src).split('\n')).toEqual(
            src.split('\n').filter((l) => !l.includes('(hide yes)')),
        );
    });

    it('is a no-op on a board that has no hidden references', () => {
        const src = '(kicad_pcb (version 20241229))';
        expect(showReferenceDesignators(src)).toBe(src);
    });
});
