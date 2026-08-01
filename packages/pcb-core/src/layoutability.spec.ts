import type { CircuitJson, Component } from '@circuit-forge/eda-core';

import { classifyCircuit } from './layoutability';

/**
 * A pad-count stub, and deliberately so.
 *
 * These tests are about declareNc's ARITHMETIC — pads minus wired pins — not about which strings
 * footprinter accepts. The real vocabulary is checked against the real library in
 * `scripts/pcb-invariants.mjs`, because jest transpiles to CommonJS and footprinter is ESM-only; that
 * split is this package's existing convention (see jest.config.js).
 */
const STUB_PADS: Record<string, number> = { soic8: 8, soic14: 14, soic16: 16, soic20: 20, sot23: 3, to92: 3, sod123: 2, '0402': 2, '0603': 2, '0805': 2, '1206': 2, pinrow2: 2 };
const padCount = (f: string): number | null => STUB_PADS[f] ?? null;


const comp = (over: Partial<Component>): Component => ({
    id: over.designator ?? 'c',
    type: 'resistor',
    designator: 'R1',
    pins: [
        { pinId: '1', netId: 'n1' },
        { pinId: '2', netId: 'n2' },
    ],
    ...over,
});

const circuit = (components: Component[]): CircuitJson => ({
    version: '1.0',
    components,
    nets: [
        { id: 'n1', name: 'N1' },
        { id: 'n2', name: 'N2' },
    ],
});

describe('classifyCircuit — roles', () => {
    it('classifies the v1 palette into the right roles/elements', () => {
        const r = classifyCircuit(circuit([
                comp({ designator: 'R1' }),
                comp({
                    designator: 'D1',
                    type: 'diode',
                    pins: [
                        { pinId: 'anode', netId: 'n1' },
                        { pinId: 'cathode', netId: 'n2' },
                    ],
                }),
                comp({
                    designator: 'LED1',
                    type: 'diode',
                    model: 'led_red',
                    pins: [
                        { pinId: 'anode', netId: 'n1' },
                        { pinId: 'cathode', netId: 'n2' },
                    ],
                }),
                comp({
                    designator: 'Q1',
                    type: 'bjt',
                    model: 'QGENNPN',
                    pins: [
                        { pinId: 'c', netId: 'n1' },
                        { pinId: 'b', netId: 'n2' },
                        { pinId: 'e', netId: 'n1' },
                    ],
                }),
                comp({
                    designator: 'V1',
                    type: 'voltage_source',
                    pins: [
                        { pinId: '+', netId: 'n1' },
                        { pinId: '-', netId: 'n2' },
                    ],
                }),
                comp({ designator: 'GND1', type: 'ground', pins: [{ pinId: '1', netId: 'n2' }] }),
            ]),
        );
        const byDes = Object.fromEntries(r.plans.map((p) => [p.component.designator, p]));
        expect(byDes.R1!.role).toBe('direct');
        expect(byDes.R1!.element).toBe('resistor');
        expect(byDes.D1!.element).toBe('diode');
        expect(byDes.LED1!.element).toBe('led');
        expect(byDes.Q1!.element).toBe('transistor');
        expect(byDes.V1!.role).toBe('connectorized');
        expect(byDes.GND1!.role).toBe('net-only');
        expect(r.completeness).toBe('full');
        expect(r.layoutable).toBe(true);
    });

    it('subckt -> chip-fallback with NC declaration (5 ports on soic8 -> 3 NC pins, condition 3)', () => {
        const pins5 = ['out', 'in+', 'in-', 'vcc', 'vee'].map((p) => ({ pinId: p, netId: 'n1' }));
        const r = classifyCircuit(circuit([
                comp({ designator: 'U1', type: 'subckt', model: 'OPAMPGEN', pins: pins5 }),
                comp({ designator: 'R1' }),
            ]),
            { padCount },
        );
        const u1 = r.plans.find((p) => p.component.designator === 'U1')!;
        expect(u1.role).toBe('chip-fallback');
        expect(u1.ncPinCount).toBe(3);
        expect(r.diagnostics.some((d) => d.code === 'PCB006' && d.message.includes('3 footprint pin'), { padCount })).toBe(true);
    });
});

describe('classifyCircuit — honesty policy (approval condition 2)', () => {
    const withTransformer = circuit([
        comp({ designator: 'R1' }),
        comp({
            designator: 'T1',
            type: 'transformer',
            pins: [
                { pinId: 'p+', netId: 'n1' },
                { pinId: 'p-', netId: 'n2' },
                { pinId: 's+', netId: 'n1' },
                { pinId: 's-', netId: 'n2' },
            ],
        }),
    ]);

    it('a load-bearing exclusion FAILS by default (no silent transformer-less board)', () => {
        const r = classifyCircuit(withTransformer);
        expect(r.layoutable).toBe(false);
        expect(r.completeness).toBe('partial');
        expect(r.diagnostics.some((d) => d.code === 'PCB002' && d.severity === 'error')).toBe(true);
    });

    it('allowPartial downgrades to warning and marks the result PARTIAL', () => {
        const r = classifyCircuit(withTransformer, { allowPartial: true });
        expect(r.layoutable).toBe(true);
        expect(r.completeness).toBe('partial');
        expect(r.diagnostics.some((d) => d.code === 'PCB002' && d.severity === 'warning')).toBe(true);
    });

    it('our 4-pin CONTROLLED switch is a sim primitive, not a pushbutton — excluded', () => {
        const r = classifyCircuit(circuit([
                comp({
                    designator: 'S1',
                    type: 'switch',
                    pins: [
                        { pinId: '+', netId: 'n1' },
                        { pinId: '-', netId: 'n2' },
                        { pinId: 'c+', netId: 'n1' },
                        { pinId: 'c-', netId: 'n2' },
                    ],
                }),
                comp({ designator: 'R1' }),
            ]),
        );
        expect(r.plans.find((p) => p.component.designator === 'S1')!.role).toBe('excluded');
    });

    it('generic without a footprint is excluded loudly; with one it is a chip', () => {
        const g = comp({ designator: 'J1', type: 'generic', pins: [{ pinId: 'p1', netId: 'n1' }] });
        const without = classifyCircuit(circuit([g, comp({ designator: 'R1' })]), { padCount });
        expect(without.diagnostics.some((d) => d.code === 'PCB004')).toBe(true);
        const withFp = classifyCircuit(circuit([{ ...g, footprint: 'SOIC-8' }, comp({ designator: 'R1' })]), { padCount });
        expect(withFp.plans.find((p) => p.component.designator === 'J1')!.role).toBe('chip-fallback');
    });

    it('a board with nothing layoutable fails (PCB001)', () => {
        const r = classifyCircuit(circuit([comp({ designator: 'GND1', type: 'ground', pins: [{ pinId: '1', netId: 'n1' }] })]),
        );
        expect(r.layoutable).toBe(false);
        expect(r.diagnostics.some((d) => d.code === 'PCB001')).toBe(true);
    });

    it('a ZERO-pin physical component is always an error (PCB011) — even with allowPartial', () => {
        const r = classifyCircuit(circuit([
                comp({ designator: 'U1', type: 'generic', footprint: 'SOIC-8', pins: [] }),
                comp({ designator: 'R1' }),
            ]),
            { allowPartial: true },
        );
        expect(r.diagnostics.some((d) => d.code === 'PCB011' && d.severity === 'error')).toBe(true);
        expect(r.layoutable).toBe(false);
    });

    it('MOSFET bulk on a DIFFERENT net than source fails by default; allowPartial downgrades (PCB010)', () => {
        const mos = (bulkNet: string) =>
            comp({
                designator: 'M1',
                type: 'mosfet',
                model: 'NMOS',
                pins: [
                    { pinId: 'd', netId: 'n1' },
                    { pinId: 'g', netId: 'n2' },
                    { pinId: 's', netId: 'n2' },
                    { pinId: 'b', netId: bulkNet },
                ],
            });
        const same = classifyCircuit(circuit([mos('n2')]), { padCount });
        expect(same.diagnostics.some((d) => d.code === 'PCB010')).toBe(false);
        const diff = classifyCircuit(circuit([mos('n1')]), { padCount });
        expect(diff.diagnostics.some((d) => d.code === 'PCB010' && d.severity === 'error')).toBe(true);
        expect(diff.layoutable).toBe(false);
        const partial = classifyCircuit(circuit([mos('n1')]), { allowPartial: true, padCount });
        expect(partial.diagnostics.some((d) => d.code === 'PCB010' && d.severity === 'warning')).toBe(true);
        expect(partial.layoutable).toBe(true);
    });

    it('NC declaration covers GENERIC catalog parts and OVERRIDE footprints (soic20 -> 15 NC; unknown -> honest note)', () => {
        // generic on soic8 with 5 wired pins -> 3 NC declared
        const g = comp({
            designator: 'U2',
            type: 'generic',
            footprint: 'SOIC-8',
            pins: Array.from({ length: 5 }, (_, i) => ({ pinId: String(i + 1), netId: 'n1' })),
        });
        const r1 = classifyCircuit(circuit([g, comp({ designator: 'R1' })]), { padCount });
        expect(r1.plans.find((p) => p.component.designator === 'U2')!.ncPinCount).toBe(3);
        expect(r1.diagnostics.some((d) => d.code === 'PCB006' && d.message.includes('3 footprint pin'))).toBe(true);

        // subckt override 'soic20' (outside the old 6-entry table): 5 ports -> 15 NC, DECLARED
        const s = comp({
            designator: 'U3',
            type: 'subckt',
            model: 'OP',
            footprint: 'soic20',
            pins: Array.from({ length: 5 }, (_, i) => ({ pinId: `p${i}`, netId: 'n1' })),
        });
        const r2 = classifyCircuit(circuit([s, comp({ designator: 'R1' })]), { padCount });
        expect(r2.plans.find((p) => p.component.designator === 'U3')!.ncPinCount).toBe(15);

        // A footprint the renderer cannot build is now REFUSED, not accounted for as "unknowable".
        //
        // This assertion used to expect a PCB006 info note saying the NC count could not be known. That was
        // the honest thing to say while pad counts came from a name pattern that recognised a minority of
        // the vocabulary — but it meant an unbuildable package sailed through classification and died later
        // inside the evaluator, and the customer got a tool-internal string. Measured on real distributor
        // `Case` values, that path took 39% of plausible (type × package) pairs. The oracle now answers
        // from the library that actually builds the package, so "I cannot count its pads" and "it does not
        // exist" are the same answer, and it is an error here rather than a crash there.
        const u = comp({
            designator: 'U4',
            type: 'generic',
            footprint: 'weirdpkg',
            pins: [{ pinId: '1', netId: 'n1' }],
        });
        const r3 = classifyCircuit(circuit([u, comp({ designator: 'R1' })]), { padCount });
        expect(r3.plans.find((p) => p.component.designator === 'U4')!.ncPinCount).toBeUndefined();
        expect(r3.diagnostics.some((d) => d.code === 'PCB012' && d.severity === 'error')).toBe(true);
        expect(r3.layoutable).toBe(false);
    });
});
