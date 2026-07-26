import { KICAD_ANCHORS } from './kicad-anchors.generated';
import { resolveModel, injectModels, solveAlignment, KICAD_3DMODEL_BASE } from './models3d';

describe('resolveModel — tscircuit footprint id -> KiCad bundled 3D model', () => {
    it('maps size-parametric passives per family + imperial size (harvested ids)', () => {
        expect(resolveModel('tscircuit:resistor_res0603')).toBe(
            `${KICAD_3DMODEL_BASE}Resistor_SMD.3dshapes/R_0603_1608Metric.step`,
        );
        expect(resolveModel('tscircuit:capacitor_0402')).toBe(
            `${KICAD_3DMODEL_BASE}Capacitor_SMD.3dshapes/C_0402_1005Metric.step`,
        );
        expect(resolveModel('tscircuit:inductor_0805')).toBe(
            `${KICAD_3DMODEL_BASE}Inductor_SMD.3dshapes/L_0805_2012Metric.step`,
        );
        // LEDs deliberately get the ICONIC 5mm domed THT body (founder decision, 5 Tem 2026): the SMD
        // block model reads as "some square chip", not an LED. Centroid-aligned (substituted package).
        expect(resolveModel('tscircuit:led_1206')).toBe(`${KICAD_3DMODEL_BASE}LED_THT.3dshapes/LED_D5.0mm.step`);
        expect(resolveModel('tscircuit:led_0603')).toBe(`${KICAD_3DMODEL_BASE}LED_THT.3dshapes/LED_D5.0mm.step`);
    });

    it('maps the SOIC ladder by pin count and the fixed packages', () => {
        expect(resolveModel('tscircuit:chip_soic8')).toContain('Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step');
        expect(resolveModel('tscircuit:chip_soic14')).toContain('SOIC-14_3.9x8.7mm_P1.27mm.step');
        expect(resolveModel('tscircuit:chip_soic16')).toContain('SOIC-16_3.9x9.9mm_P1.27mm.step');
        expect(resolveModel('tscircuit:diode_sod123')).toContain('Diode_SMD.3dshapes/D_SOD-123.step');
        expect(resolveModel('tscircuit:transistor_sot23')).toContain('Package_TO_SOT_SMD.3dshapes/SOT-23.step');
        expect(resolveModel('tscircuit:mosfet_sot23')).toContain('Package_TO_SOT_SMD.3dshapes/SOT-23.step'); // MOSFET too
        expect(resolveModel('tscircuit:transistor_to92')).toContain('Package_TO_SOT_THT.3dshapes/TO-92.step');
        expect(resolveModel('tscircuit:chip_to220')).toContain('Package_TO_SOT_THT.3dshapes/TO-220-3_Vertical.step'); // regulators
        expect(resolveModel('tscircuit:pin_header_pinrow2')).toContain('PinHeader_1x02_P2.54mm_Vertical.step');
        expect(resolveModel('tscircuit:pin_header_pinrow6')).toContain('PinHeader_1x06_P2.54mm_Vertical.step'); // parametric N
    });

    it('accepts a bare id (no tscircuit: prefix) and honours a custom base', () => {
        expect(resolveModel('chip_soic8', '/models/')).toBe(
            '/models/Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step',
        );
    });

    it('returns null for an unknown footprint (caller reports; never guesses a body)', () => {
        expect(resolveModel('tscircuit:chip_dip40')).toBeNull(); // beyond the SOIC ladder
        expect(resolveModel('tscircuit:exotic_bga256')).toBeNull();
    });
});

describe('injectModels — one (model ...) per matched footprint, unmatched surfaced', () => {
    const board = [
        '(kicad_pcb',
        '  (footprint',
        '    "tscircuit:chip_soic8"',
        '    (layer "F.Cu"))',
        '  (footprint',
        '    "tscircuit:resistor_res0603"',
        '    (layer "F.Cu"))',
        '  (footprint',
        '    "tscircuit:resistor_res0603"',
        '    (layer "F.Cu"))',
        '  (footprint',
        '    "tscircuit:chip_dip40"', // unmatched
        '    (layer "F.Cu"))',
        ')',
    ].join('\n');

    it('injects a body into every matched footprint and reports the unmatched one', () => {
        const r = injectModels(board);
        expect(r.injected).toBe(3); // soic8 + 2x res0603
        expect(r.kicadPcb.match(/\(model /g)?.length).toBe(3);
        expect(r.kicadPcb).toContain('SOIC-8_3.9x4.9mm_P1.27mm.step');
        expect(r.kicadPcb).toContain('R_0603_1608Metric.step');
        expect(r.unmatched).toEqual([{ id: 'tscircuit:chip_dip40', count: 1 }]);
    });

    it('injects the model INSIDE the footprint block (right after the id), keeps the document closed', () => {
        const r = injectModels(board);
        expect(r.kicadPcb).toMatch(/"tscircuit:chip_soic8"\s*\n\s*\(model /);
        expect(r.kicadPcb.trimEnd().endsWith(')')).toBe(true);
    });

    it('is a no-op on a board with no tscircuit footprints', () => {
        const r = injectModels('(kicad_pcb\n  (segment (start 0 0) (end 1 1))\n)');
        expect(r.injected).toBe(0);
        expect(r.unmatched).toEqual([]);
    });

    it('is IDEMPOTENT — re-running on its own output injects nothing more (no duplicate bodies)', () => {
        const once = injectModels(board);
        const twice = injectModels(once.kicadPcb);
        expect(twice.injected).toBe(0); // everything matched already has a model
        expect(twice.kicadPcb).toBe(once.kicadPcb);
        expect((twice.kicadPcb.match(/\(model /g) ?? []).length).toBe(3); // unchanged, not 6
    });
});

describe('body alignment — solved from pad constellations, never assumed (5 Tem 2026 fix)', () => {
    // Real geometry from a generated board: tscircuit chip_to220 pads are CENTERED (-2.6, 0, +2.6);
    // KiCad's TO-220-3_Vertical (which the STEP is aligned to) anchors at PIN 1 (0, 2.54, 5.08).
    // The old zero-offset injection put the body 2.54mm off — one leg outside its hole. The solver
    // must recover that translation, with the honest 0.06mm/pin pitch residual (2.6 vs 2.54).
    it('TO-220: recovers the pin1→center translation within tolerance', () => {
        const ours = [
            { n: '1', x: -2.6, y: 0 },
            { n: '2', x: 0, y: 0 },
            { n: '3', x: 2.6, y: 0 },
        ];
        const sol = solveAlignment(ours, KICAD_ANCHORS['TO-220-3_Vertical']!.pads)!;
        expect(sol.thetaDeg).toBe(0);
        expect(sol.dx).toBeCloseTo(-2.54, 2);
        expect(sol.dy).toBeCloseTo(0, 3);
        expect(sol.residual).toBeLessThan(0.15);
    });

    // tscircuit pinrow2 is HORIZONTAL (±1.27, 0); KiCad's PinHeader_1x02 is VERTICAL (0,0)-(0,2.54).
    // The old injection left the header body facing 90° the wrong way next to an empty hole.
    it('PinHeader 1x02: solves the 90° rotation + pin1 translation exactly', () => {
        const ours = [
            { n: '1', x: -1.27, y: 0 },
            { n: '2', x: 1.27, y: 0 },
        ];
        const sol = solveAlignment(ours, KICAD_ANCHORS['PinHeader_1x02_P2.54mm_Vertical']!.pads)!;
        expect(sol.thetaDeg).toBe(-90);
        expect(sol.dx).toBeCloseTo(-1.27, 4);
        expect(sol.dy).toBeCloseTo(0, 4);
        expect(sol.residual).toBeLessThan(0.001);
    });

    it('SOIC-8: tscircuit and KiCad are both centered — near-zero transform', () => {
        // shrunk mock of a centered SOIC-8 (exact tscircuit pad coords vary; symmetry is the point)
        const theirs = KICAD_ANCHORS['SOIC-8_3.9x4.9mm_P1.27mm']!.pads;
        const sol = solveAlignment(
            theirs.map((p) => ({ ...p })),
            theirs,
        )!;
        expect(sol.residual).toBeCloseTo(0, 6);
        expect(Math.hypot(sol.dx, sol.dy)).toBeCloseTo(0, 6);
    });

    it('injectModels writes the solved transform into the model ref (y-flip for 3D) + reports it', () => {
        const board = [
            '(kicad_pcb',
            '  (footprint',
            '    "tscircuit:chip_to220"',
            '    (layer "F.Cu")',
            '    (pad "1" thru_hole circle',
            '      (at -2.6 0 0))',
            '    (pad "2" thru_hole circle',
            '      (at 0 0 0))',
            '    (pad "3" thru_hole circle',
            '      (at 2.6 0 0)))',
            ')',
        ].join('\n');
        const r = injectModels(board);
        expect(r.injected).toBe(1);
        expect(r.alignments).toHaveLength(1);
        expect(r.alignments[0]!.mode).toBe('exact');
        expect(r.alignments[0]!.dx).toBeCloseTo(-2.54, 2);
        expect(r.kicadPcb).toMatch(/\(offset \(xyz -2\.54\d* 0 0\)\)/); // dy=0 → y-flip invisible here
        expect(r.warnings).toEqual([]);
    });

    it('LED dome (substituted package): centroid alignment, no false constellation warning', () => {
        const board = [
            '(kicad_pcb',
            '  (footprint',
            '    "tscircuit:led_0603"',
            '    (layer "F.Cu")',
            '    (pad "1" smd rect',
            '      (at -0.775 0 0))',
            '    (pad "2" smd rect',
            '      (at 0.775 0 0)))',
            ')',
        ].join('\n');
        const r = injectModels(board);
        expect(r.alignments[0]!.mode).toBe('centroid');
        expect(r.alignments[0]!.dx).toBeCloseTo(-1.27, 3); // KiCad LED pads centroid (1.27, 0) → ours (0,0)
        expect(r.warnings).toEqual([]);
    });
});
