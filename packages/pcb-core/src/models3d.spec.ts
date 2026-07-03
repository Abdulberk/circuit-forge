import { resolveModel, injectModels, KICAD_3DMODEL_BASE } from './models3d';

describe('resolveModel — tscircuit footprint id -> KiCad bundled 3D model', () => {
    it('maps size-parametric passives per family + imperial size (harvested ids)', () => {
        expect(resolveModel('tscircuit:resistor_res0603')).toBe(`${KICAD_3DMODEL_BASE}Resistor_SMD.3dshapes/R_0603_1608Metric.step`);
        expect(resolveModel('tscircuit:capacitor_0402')).toBe(`${KICAD_3DMODEL_BASE}Capacitor_SMD.3dshapes/C_0402_1005Metric.step`);
        expect(resolveModel('tscircuit:inductor_0805')).toBe(`${KICAD_3DMODEL_BASE}Inductor_SMD.3dshapes/L_0805_2012Metric.step`);
        expect(resolveModel('tscircuit:led_1206')).toBe(`${KICAD_3DMODEL_BASE}LED_SMD.3dshapes/LED_1206_3216Metric.step`);
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
        expect(resolveModel('chip_soic8', '/models/')).toBe('/models/Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step');
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
