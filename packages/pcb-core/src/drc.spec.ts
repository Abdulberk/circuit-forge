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

// A real warning-severity finding: kicad-cli 10 reports these on every one of our boards (measured
// 30 Tem 2026) because the converter emits designators below the min_text_height we declare ourselves.
const textHeightWarning = {
    type: 'text_height',
    severity: 'warning',
    description: 'Text height out of range (0.75mm < 0.8mm)',
    items: [{ description: 'Reference designator R2', pos: { x: 92, y: 101 }, uuid: 'w1' }],
};

describe('parseDrcReport — normalize kicad-cli DRC json', () => {
    it('is clean only when both violations and unconnected are empty', () => {
        expect(parseDrcReport({ violations: [], unconnected_items: [] }).clean).toBe(true);
        expect(parseDrcReport({ violations: [], unconnected_items: [realUnconnected] }).clean).toBe(false);
        expect(parseDrcReport({ violations: [clearanceViolation], unconnected_items: [] }).clean).toBe(false);
    });
    it('defaults missing arrays safely (garbage/empty input → clean, no crash)', () => {
        expect(parseDrcReport(undefined)).toEqual({ clean: true, violations: [], warnings: [], unconnected: [] });
        expect(parseDrcReport({}).clean).toBe(true);
    });

    it('splits by severity: a warning is REPORTED but does not make the board dirty', () => {
        // Measured on all eight gallery boards: every one reports zero blocking violations while carrying
        // warning-severity findings — designators printed under the minimum text height we declared, silk
        // running off the edge, an isolated copper island. Asking kicad for errors only made those
        // physically absent from the report, so "DRC-clean" read as "nothing to say about this board".
        const r = parseDrcReport({ violations: [textHeightWarning, clearanceViolation], unconnected_items: [] });
        expect(r.clean).toBe(false); // the ERROR still blocks — the gate did not move
        expect(r.violations).toEqual([clearanceViolation]);
        expect(r.warnings).toEqual([textHeightWarning]);

        const w = parseDrcReport({ violations: [textHeightWarning], unconnected_items: [] });
        expect(w.clean).toBe(true); // a warning alone never withholds the fab bundle
        expect(w.warnings).toHaveLength(1);
    });

    it('an UNRECOGNISED severity blocks (an unknown level is an unknown risk)', () => {
        // The direction matters: if KiCad renames a level or a report arrives without one, the board must
        // stop at the gate and be looked at. Guessing "probably harmless" is how a real defect ships.
        const odd = { ...clearanceViolation, severity: 'catastrophic' };
        const none = { ...clearanceViolation, severity: undefined as unknown as string };
        expect(parseDrcReport({ violations: [odd], unconnected_items: [] }).clean).toBe(false);
        expect(parseDrcReport({ violations: [none], unconnected_items: [] }).clean).toBe(false);
    });

    it('drcToChecks carries warnings through, each keeping its own severity', () => {
        const checks = drcToChecks(
            parseDrcReport({ violations: [clearanceViolation, textHeightWarning], unconnected_items: [] }),
        );
        expect(checks.map((c) => c.severity)).toEqual(['error', 'warning']);
        expect(checks.map((c) => c.type)).toEqual(['clearance', 'text_height']);
    });
});

describe('drcCategory — coarse grouping with verbatim pass-through', () => {
    it('groups known KiCad types', () => {
        expect(drcCategory('unconnected_items')).toBe('unconnected');
        expect(drcCategory('clearance')).toBe('clearance');
        expect(drcCategory('annular_width')).toBe('via_drill');
        expect(drcCategory('courtyards_overlap')).toBe('placement');
    });
    it('groups the types the severity split newly surfaced (they would all read as "other")', () => {
        // Measured on a real report: 32 findings on one board, 22 of them text constraints and one an
        // isolated copper island. Left uncategorized, the grouping a consumer relies on would put almost
        // everything in the catch-all bucket and stop being a grouping at all.
        expect(drcCategory('text_height')).toBe('text');
        expect(drcCategory('text_thickness')).toBe('text');
        expect(drcCategory('silk_edge_clearance')).toBe('silk');
        expect(drcCategory('isolated_copper')).toBe('copper');
        expect(drcCategory('lib_footprint_issues')).toBe('footprint');
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
            {
                id: 'led1',
                designator: 'LED1',
                x: 0,
                y: 0,
                rotation: 0,
                footprint: '0603',
                bodyWmm: 1.6,
                bodyHmm: 0.8,
                heightMm: 0.7,
                courtyard: [],
                layer: 'top',
            },
            {
                id: 'r1',
                designator: 'R1',
                x: 8,
                y: 0,
                rotation: 0,
                footprint: 'res0603',
                bodyWmm: 1.6,
                bodyHmm: 0.8,
                heightMm: 0.5,
                courtyard: [],
                layer: 'top',
            },
        ],
        pads: [
            {
                id: 'p1',
                componentId: 'led1',
                sourcePin: '1',
                pin: 'anode',
                net: 'A',
                x: -0.8,
                y: 0,
                layers: ['top'],
                shape: 'rect',
                wMm: 1,
                hMm: 0.6,
                drillMm: null,
            },
            {
                id: 'p2',
                componentId: 'r1',
                sourcePin: '1',
                pin: '1',
                net: 'A',
                x: 7.2,
                y: 0,
                layers: ['top'],
                shape: 'rect',
                wMm: 1,
                hMm: 0.6,
                drillMm: null,
            },
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
        const orphan = {
            ...realUnconnected,
            items: [
                { description: 'Pad 1 [Z] of X9 on F.Cu', pos: { x: 0, y: 0 } },
                { description: 'Pad 1 [Z] of X8 on F.Cu', pos: { x: 1, y: 1 } },
            ],
        };
        const { airwires, unmatched } = airwiresFromDrc(parseDrcReport({ unconnected_items: [orphan] }), geo);
        expect(airwires).toEqual([]);
        expect(unmatched).toBe(1);
    });

    it('resolves a part with 2+ pads on ONE net to the EXACT pad the DRC names (Pad N), not the last same-net pad', () => {
        // U1 has pin 1 @ (0,0) AND pin 4 @ (5,0), both on GND (e.g. an IC with two ground pins). R1 pin 1 @ (10,0)
        // on GND. Keyed only by designator|net, the U1|GND entry is overwritten to whichever pad is inserted last
        // (pin 4 @ (5,0)) — the WRONG endpoint for a "Pad 1 of U1" ratsnest. Keyed by designator|pin, it picks pin 1.
        const multi: LayoutGeometry = {
            board: { widthMm: 20, heightMm: 20, outline: [] },
            layers: [{ name: 'top' }],
            components: [
                {
                    id: 'u1',
                    designator: 'U1',
                    x: 0,
                    y: 0,
                    rotation: 0,
                    footprint: 'soic8',
                    bodyWmm: 4,
                    bodyHmm: 4,
                    heightMm: 1,
                    courtyard: [],
                    layer: 'top',
                },
                {
                    id: 'r1',
                    designator: 'R1',
                    x: 10,
                    y: 0,
                    rotation: 0,
                    footprint: 'res0603',
                    bodyWmm: 1.6,
                    bodyHmm: 0.8,
                    heightMm: 0.5,
                    courtyard: [],
                    layer: 'top',
                },
            ],
            pads: [
                {
                    id: 'u1p1',
                    componentId: 'u1',
                    sourcePin: '1',
                    pin: '1',
                    net: 'GND',
                    x: 0,
                    y: 0,
                    layers: ['top'],
                    shape: 'rect',
                    wMm: 1,
                    hMm: 0.6,
                    drillMm: null,
                },
                {
                    id: 'u1p4',
                    componentId: 'u1',
                    sourcePin: '1',
                    pin: '4',
                    net: 'GND',
                    x: 5,
                    y: 0,
                    layers: ['top'],
                    shape: 'rect',
                    wMm: 1,
                    hMm: 0.6,
                    drillMm: null,
                }, // inserted last → would win the net-only key
                {
                    id: 'r1p1',
                    componentId: 'r1',
                    sourcePin: '1',
                    pin: '1',
                    net: 'GND',
                    x: 10,
                    y: 0,
                    layers: ['top'],
                    shape: 'rect',
                    wMm: 1,
                    hMm: 0.6,
                    drillMm: null,
                },
            ],
            traces: [],
            vias: [],
        };
        const entry = {
            type: 'unconnected_items',
            severity: 'error',
            description: 'Missing connection between items',
            items: [
                { description: 'Pad 1 [GND] of U1 on F.Cu', pos: { x: 0, y: 0 } },
                { description: 'Pad 1 [GND] of R1 on F.Cu', pos: { x: 0, y: 0 } },
            ],
        };
        const { airwires, unmatched } = airwiresFromDrc(parseDrcReport({ unconnected_items: [entry] }), multi);
        expect(unmatched).toBe(0);
        // from = U1 pin 1 @ (0,0) — the EXACT named pad — NOT the last-inserted U1|GND pad (pin 4 @ (5,0)).
        expect(airwires).toEqual([{ net: 'GND', from: { x: 0, y: 0 }, to: { x: 10, y: 0 } }]);
    });
});
