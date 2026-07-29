import type { CircuitJson } from '@circuit-forge/eda-core';

import { classifyCircuit } from './layoutability';
import { buildBomCsv, buildPnpCsv, hasVisibleDesignators } from './outputs';
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

describe('hasVisibleDesignators — the board must SAY which part is which, whichever spelling KiCad uses', () => {
    /** The modern half of what circuit-json-to-kicad emits: hidden, and NOT what gets plotted. */
    const property = (hidden: boolean) =>
        [
            '    (property "Reference" "U1"',
            '      (at 0 -3 0)',
            '      (layer F.SilkS)',
            ...(hidden ? ['      (hide yes)'] : []),
            '      (uuid 65eabe80-6cf1-7821-3fcd-aec212a9e563)',
            '    )',
        ].join('\n');

    /** The legacy half — deprecated, visible, and the one kicad-cli actually plots today. */
    const fpText = (layer = 'F.SilkS') =>
        [
            '    (fp_text',
            '      reference',
            '      "U1"',
            '      (at 0 -2.92 0)',
            `      (layer ${layer})`,
            '    )',
        ].join('\n');

    it('accepts the legacy fp_text — this is why our boards were never actually blank', () => {
        expect(hasVisibleDesignators([property(true), fpText()].join('\n'))).toBe(true);
    });

    it('accepts an unhidden property — the modern spelling, for when the legacy one goes away', () => {
        expect(hasVisibleDesignators(property(false))).toBe(true);
    });

    it('REJECTS a board whose only designator is the hidden property — the blank-silkscreen regression', () => {
        expect(hasVisibleDesignators(property(true))).toBe(false);
    });

    it('REJECTS a board with no designators at all', () => {
        expect(hasVisibleDesignators('(kicad_pcb (version 20241229))')).toBe(false);
    });

    it('counts the BACK silkscreen too — a bottom-side board is still labelled', () => {
        expect(hasVisibleDesignators(fpText('B.SilkS'))).toBe(true);
    });

    it('does NOT count a designator moved to the fabrication layer — F.Fab is never printed', () => {
        expect(hasVisibleDesignators(fpText('F.Fab'))).toBe(false);
    });
});
