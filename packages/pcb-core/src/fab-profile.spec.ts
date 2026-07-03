import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JLC_FAB_PROFILE, FAB_TIERS, boardExtraProps, kicadProjectJson, injectZone, reportViaCompliance } from './fab-profile';

const realPcb = readFileSync(join(__dirname, '..', '__fixtures__', 'small.kicad_pcb'), 'utf8');

describe('boardExtraProps', () => {
    it('pins the LOCAL router (network-free determinism) and the min trace width (verified knobs)', () => {
        expect(boardExtraProps(JLC_FAB_PROFILE)).toBe('autorouter={{ local: true }} minTraceWidth={0.2}');
    });
});

describe('kicadProjectJson — the notary judges by OUR rules (single source of truth)', () => {
    it('carries the profile as KiCad design rules, via diameter derived from drill + 2*annular', () => {
        const pro = JSON.parse(kicadProjectJson(JLC_FAB_PROFILE));
        const rules = pro.board.design_settings.rules;
        expect(rules.min_track_width).toBe(0.2);
        expect(rules.min_clearance).toBe(0.2);
        expect(rules.min_via_annular_width).toBe(0.15);
        expect(rules.min_via_diameter).toBeCloseTo(0.6); // 0.3 + 2*0.15
        expect(rules.min_through_hole_diameter).toBe(0.3);
    });

    it('sets the Default net class clearance/width to the profile (what DRC actually checks track↔pad)', () => {
        // A tighter tier must lower the Default netclass, not just min_clearance — else DRC false-fails at
        // KiCad's 0.2mm default netclass (found live 3 Tem 2026).
        const std = JSON.parse(kicadProjectJson(FAB_TIERS.standard));
        const def = std.net_settings.classes.find((c: { name: string }) => c.name === 'Default');
        expect(def.clearance).toBe(0.127);
        expect(def.track_width).toBe(0.127);
        expect(def.via_drill).toBe(0.25);
    });
});

describe('injectZone — the PROVEN pour mechanism (Faz-0 spike) with the un-netted-copper safety gate', () => {
    it('pours onto the REAL converter board (its segments DO carry nets) — polygon + closed document', () => {
        const net = realPcb.match(/\(net \d+ "([^"]+)"\)/)?.[1];
        expect(net).toBeTruthy();
        const out = injectZone(realPcb, net!, 'B.Cu');
        expect(out.kind).toBe('ok');
        const pcb = (out as { kind: 'ok'; kicadPcb: string }).kicadPcb;
        expect(pcb).toContain(`(net_name "${net}")`);
        expect(pcb.trimEnd().endsWith(')')).toBe(true);
    });

    it('REFUSES to pour when copper segments carry no net (safety gate against false shorts)', () => {
        const unnetted = [
            '(kicad_pcb',
            '  (net 1 "GND")',
            '  (gr_line (start 0 0) (end 20 0) (layer "Edge.Cuts")',
            '  )',
            '  (segment (start 1 1) (end 2 2) (width 0.2) (layer "F.Cu")',
            '  )',
            ')',
        ].join('\n');
        expect(injectZone(unnetted, 'GND', 'B.Cu')).toEqual({ kind: 'unsafe-unnetted-copper' });
    });

    it('injects a zone into a NETTED board (polygon from Edge.Cuts bbox, document stays closed)', () => {
        const netted = [
            '(kicad_pcb',
            '  (net 0 "")',
            '  (net 1 "GND")',
            '  (gr_line (start 0 0) (end 20 0) (layer "Edge.Cuts"))',
            '  (gr_line (start 20 0) (end 20 15) (layer "Edge.Cuts")',
            '  )',
            '  (segment (start 1 1) (end 2 2) (width 0.2) (layer "F.Cu") (net 1)',
            '  )',
            ')',
        ].join('\n');
        const out = injectZone(netted, 'GND', 'B.Cu');
        expect(out.kind).toBe('ok');
        const pcb = (out as { kind: 'ok'; kicadPcb: string }).kicadPcb;
        expect(pcb).toContain('(net_name "GND")');
        expect(pcb).toContain('(layer "B.Cu")');
        expect(pcb).toMatch(/\(polygon \(pts \(xy 0 0\) \(xy 20 0\)/); // Edge.Cuts bbox
        expect(pcb.trimEnd().endsWith(')')).toBe(true);
    });

    it("reports 'no-net' for a net that does not exist (caller diagnoses; never a silent no-op)", () => {
        expect(injectZone(realPcb, 'NO_SUCH_NET')).toEqual({ kind: 'no-net' });
    });
});

describe('reportViaCompliance — NON-mutating (post-route enlargement manufactures shorts, proven live)', () => {
    it('counts undersized vias against the profile and NEVER mutates geometry', () => {
        const evaluated = [
            { type: 'pcb_via', hole_diameter: 0.2, outer_diameter: 0.3 }, // tscircuit default (annular 0.05)
            { type: 'pcb_via', hole_diameter: 0.4, outer_diameter: 0.8 }, // compliant
            { type: 'pcb_trace' },
        ];
        const r = reportViaCompliance(evaluated, JLC_FAB_PROFILE);
        expect(r).toEqual({ total: 2, undersized: 1 });
        expect(evaluated[0]).toMatchObject({ hole_diameter: 0.2, outer_diameter: 0.3 }); // untouched
    });
});
