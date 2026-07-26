import { parseDrcReport } from '@circuit-forge/pcb-core';

import { assessManufacturability } from './outcome';

// Real parse path: build the verdict from parseDrcReport's output on the exact JSON shapes kicad-cli emits
// (violations[] + unconnected_items[]). No mocks — the gate logic is exercised on real DRC report structures.
describe('assessManufacturability — the manufacturability delivery gate', () => {
    const clean = parseDrcReport({ violations: [], unconnected_items: [] });

    it('a DRC-clean board is manufacturable, with no reason', () => {
        const v = assessManufacturability(clean);
        expect(v).toEqual({ manufacturable: true, violations: 0, unrouted: 0, reason: null });
    });

    it('rule violations block manufacturability (the local-router undersized-via case)', () => {
        // The exact signature the local-router fallback produced: annular_width + clearance errors.
        const parsed = parseDrcReport({
            violations: [
                { type: 'annular_width', severity: 'error', description: 'Annular width', items: [] },
                { type: 'annular_width', severity: 'error', description: 'Annular width', items: [] },
                { type: 'clearance', severity: 'error', description: 'Clearance', items: [] },
            ],
            unconnected_items: [],
        });
        const v = assessManufacturability(parsed);
        expect(v.manufacturable).toBe(false);
        expect(v.violations).toBe(3);
        expect(v.unrouted).toBe(0);
        expect(v.reason).toContain('3 DRC violation(s)');
        expect(v.reason).not.toContain('unrouted'); // no unconnected nets → don't mention them
    });

    it('unconnected nets alone block manufacturability and are named in the reason', () => {
        const parsed = parseDrcReport({
            violations: [],
            unconnected_items: [
                { type: 'unconnected_items', severity: 'error', description: 'Missing connection', items: [] },
                { type: 'unconnected_items', severity: 'error', description: 'Missing connection', items: [] },
            ],
        });
        const v = assessManufacturability(parsed);
        expect(v.manufacturable).toBe(false);
        expect(v.violations).toBe(0);
        expect(v.unrouted).toBe(2);
        expect(v.reason).toContain('0 DRC violation(s)');
        expect(v.reason).toContain('2 unrouted net(s)');
    });

    it('both violations and unconnected nets are reported together', () => {
        const parsed = parseDrcReport({
            violations: [{ type: 'clearance', severity: 'error', description: 'Clearance', items: [] }],
            unconnected_items: [{ type: 'unconnected_items', severity: 'error', description: 'Missing', items: [] }],
        });
        const v = assessManufacturability(parsed);
        expect(v.manufacturable).toBe(false);
        expect(v.reason).toContain('1 DRC violation(s)');
        expect(v.reason).toContain('1 unrouted net(s)');
    });

    it('agrees with ParsedDrc.clean — the gate never disagrees with the DRC verdict', () => {
        expect(assessManufacturability(clean).manufacturable).toBe(clean.clean);
        const dirty = parseDrcReport({ violations: [{ type: 'clearance', severity: 'error', description: 'x', items: [] }], unconnected_items: [] });
        expect(assessManufacturability(dirty).manufacturable).toBe(dirty.clean);
    });
});
