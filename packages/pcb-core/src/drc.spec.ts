import { parseDrcReport, drcCategory, drcToChecks, airwiresFromDrc } from './drc';
import type { LayoutGeometry } from './layout-result';

// The REAL unconnected_items entry captured from kicad-cli 10 (7 Tem 2026) — net in "[A]", designators in "of LED1".
const realUnconnected = {
    description: 'Missing connection between items',
    severity: 'error',
    type: 'unconnected_items',
    items: [
        { description: 'Pad 1 [A] of LED1 on F.Cu', pos: { x: 94.175, y: 95 }, uuid: 'u1' },
        { description: 'Pad 1 [A] of R1 on F.Cu', pos: { x: 94.175, y: 105 }, uuid: 'u2' },
    ],
};
// A clearance violation — SAME entry shape as unconnected (verified structure), different `type`.
const clearanceViolation = {
    type: 'clearance',
    severity: 'error',
    description: 'Clearance violation (0.15mm < 0.2mm)',
    items: [
        { description: 'Track [B] of R2 on F.Cu', pos: { x: 90, y: 100 }, uuid: 'v1' },
        { description: 'Pad 2 [B] of R2 on F.Cu', pos: { x: 91, y: 100 }, uuid: 'v2' },
    ],
};

describe('parseDrcReport — normalize kicad-cli DRC json', () => {
    it('is clean only when both violations and unconnected are empty', () => {
        expect(parseDrcReport({ violations: [], unconnected_items: [] }).clean).toBe(true);
        expect(parseDrcReport({ violations: [], unconnected_items: [realUnconnected] }).clean).toBe(false);
        expect(parseDrcReport({ violations: [clearanceViolation], unconnected_items: [] }).clean).toBe(false);
    });
    it('defaults missing arrays safely (garbage/empty input → clean, no crash)', () => {
        expect(parseDrcReport(undefined)).toEqual({ clean: true, violations: [], unconnected: [] });
        expect(parseDrcReport({}).clean).toBe(true);
    });
});

describe('drcCategory — coarse grouping with verbatim pass-through', () => {
    it('groups known KiCad types', () => {
        expect(drcCategory('unconnected_items')).toBe('unconnected');
        expect(drcCategory('clearance')).toBe('clearance');
        expect(drcCategory('annular_width')).toBe('via_drill');
        expect(drcCategory('courtyards_overlap')).toBe('placement');
    });
    it('passes unknown types through as "other" (no hand-table to maintain)', () => {
        expect(drcCategory('some_future_kicad_check')).toBe('other');
    });
});

describe('drcToChecks — categorized checks for the contract', () => {
    it('maps a violation to {category,type,severity,message,location,refs}', () => {
        const report = parseDrcReport({ violations: [clearanceViolation], unconnected_items: [realUnconnected] });
        const checks = drcToChecks(report);
        expect(checks).toHaveLength(1); // unconnected is NOT a violation → surfaces as airwires, not checks
        expect(checks[0]).toMatchObject({
            category: 'clearance',
            type: 'clearance',
            severity: 'error',
            location: { x: 90, y: 100 },
            refs: ['R2'],
        });
    });
});

describe('airwiresFromDrc — ratsnest from unconnected_items, drawn on OUR pad coords', () => {
    const geo: LayoutGeometry = {
        board: { widthMm: 30, heightMm: 30, outline: [] },
        layers: [{ name: 'top' }, { name: 'bottom' }],
        components: [
            { id: 'led1', designator: 'LED1', x: 0, y: 0, rotation: 0, footprint: '0603', bodyWmm: 1.6, bodyHmm: 0.8, heightMm: 0.7, courtyard: [], layer: 'top' },
            { id: 'r1', designator: 'R1', x: 8, y: 0, rotation: 0, footprint: 'res0603', bodyWmm: 1.6, bodyHmm: 0.8, heightMm: 0.5, courtyard: [], layer: 'top' },
        ],
        pads: [
            { id: 'p1', componentId: 'led1', pin: 'anode', net: 'A', x: -0.8, y: 0, layers: ['top'], shape: 'rect', wMm: 1, hMm: 0.6, drillMm: null },
            { id: 'p2', componentId: 'r1', pin: '1', net: 'A', x: 7.2, y: 0, layers: ['top'], shape: 'rect', wMm: 1, hMm: 0.6, drillMm: null },
        ],
        traces: [],
        vias: [],
    };

    it('draws an airwire between the two named pads using OUR coordinates (not the DRC page frame)', () => {
        const report = parseDrcReport({ violations: [], unconnected_items: [realUnconnected] });
        const { airwires, unmatched } = airwiresFromDrc(report, geo);
        expect(unmatched).toBe(0);
        expect(airwires).toEqual([{ net: 'A', from: { x: -0.8, y: 0 }, to: { x: 7.2, y: 0 } }]); // NOT (94.175, 95/105)
    });

    it('skips (does not fake) an unconnected entry whose pads are not in the geometry', () => {
        const orphan = { ...realUnconnected, items: [
            { description: 'Pad 1 [Z] of X9 on F.Cu', pos: { x: 0, y: 0 } },
            { description: 'Pad 1 [Z] of X8 on F.Cu', pos: { x: 1, y: 1 } },
        ] };
        const { airwires, unmatched } = airwiresFromDrc(parseDrcReport({ unconnected_items: [orphan] }), geo);
        expect(airwires).toEqual([]);
        expect(unmatched).toBe(1);
    });
});
