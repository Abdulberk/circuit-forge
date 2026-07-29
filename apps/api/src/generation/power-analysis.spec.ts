import { sanitizeNodeName, type CircuitJson } from '@circuit-forge/eda-core';

import type { SimMeasurement } from './circuit-simulator.service';
import { computeResistorPower } from './power-analysis';

/** Build a node-voltage measurement keyed the way the simulator reports it: v(<sanitized node>). */
const v = (netId: string, final: number): SimMeasurement => ({
    node: `v(${sanitizeNodeName(netId)})`,
    min: final,
    max: final,
    final,
    pp: 0,
    avg: final,
    rms: Math.abs(final),
});

/** 10V across R1(in→out) and R2(out→gnd); divider sets out=5V. P_R = ΔV²/R = 25/1000 = 0.025 W each. */
const DIVIDER: CircuitJson = {
    version: '1.0',
    components: [
        {
            id: 'v1',
            type: 'voltage_source',
            designator: 'V1',
            value: 'DC 10',
            pins: [
                { pinId: '+', netId: 'in' },
                { pinId: '-', netId: 'gnd' },
            ],
        },
        {
            id: 'r1',
            type: 'resistor',
            designator: 'R1',
            value: '1k',
            pins: [
                { pinId: '1', netId: 'in' },
                { pinId: '2', netId: 'out' },
            ],
        },
        {
            id: 'r2',
            type: 'resistor',
            designator: 'R2',
            value: '1k',
            pins: [
                { pinId: '1', netId: 'out' },
                { pinId: '2', netId: 'gnd' },
            ],
        },
        { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [
        { id: 'in', name: 'in' },
        { id: 'out', name: 'out' },
        { id: 'gnd', name: 'gnd', isGround: true },
    ],
};
const DIVIDER_MEAS = [v('in', 10), v('out', 5)]; // ground (0V) is not probed

describe('computeResistorPower', () => {
    it('computes exact steady-state dissipation from node voltages + R (ΔV²/R), ground = 0V', () => {
        const rep = computeResistorPower(DIVIDER, DIVIDER_MEAS)!;
        expect(rep.basis).toBe('operating-point');
        const r1 = rep.components.find((c) => c.designator === 'R1')!;
        const r2 = rep.components.find((c) => c.designator === 'R2')!;
        expect(r1.dissipationW).toBeCloseTo(0.025, 6); // (10-5)²/1000
        expect(r2.dissipationW).toBeCloseTo(0.025, 6); // (5-0)²/1000 — R2 to ground
        expect(rep.anyOverRating).toBe(false); // both under the 0.25W default
        expect(r1.ratingSource).toBe('default');
    });

    it('flags a resistor over its rating; an explicit properties.powerRating overrides the default', () => {
        const c: CircuitJson = {
            ...DIVIDER,
            components: DIVIDER.components.map((comp) =>
                comp.designator === 'R1' ? { ...comp, properties: { powerRating: 0.01 } } : comp,
            ),
        };
        const rep = computeResistorPower(c, DIVIDER_MEAS)!;
        const r1 = rep.components.find((x) => x.designator === 'R1')!;
        expect(r1.ratingW).toBe(0.01);
        expect(r1.ratingSource).toBe('declared');
        expect(r1.overRating).toBe(true); // 0.025 > 0.01
        expect(rep.anyOverRating).toBe(true);
    });

    it('takes the rating from the PACKAGE when the part declares none — an 0603 is 0.1W, not 0.25W', () => {
        // The regression this pins, exactly: R1 is a 100Ω 0603 dropping 5V, so it dissipates 0.25W. Against
        // the old flat 0.25W default that is not "over" (0.25 > 0.25 is false) and the report called it
        // fine — while the part it is actually specified as is rated 0.1W and would be running at 2.5× its
        // limit on a real board. Same circuit, same measurements; only the rating was wrong.
        const c: CircuitJson = {
            ...DIVIDER,
            components: DIVIDER.components.map((comp) =>
                comp.designator === 'R1'
                    ? { ...comp, value: '100', footprint: '0603' }
                    : { ...comp, footprint: '1206' },
            ),
        };
        const rep = computeResistorPower(c, DIVIDER_MEAS)!;
        const r1 = rep.components.find((x) => x.designator === 'R1')!;
        const r2 = rep.components.find((x) => x.designator === 'R2')!;
        expect(r1).toMatchObject({ dissipationW: 0.25, ratingW: 0.1, ratingSource: 'footprint', overRating: true });
        expect(r2).toMatchObject({ ratingW: 0.25, ratingSource: 'footprint', overRating: false });
        expect(rep.anyOverRating).toBe(true);
    });

    it('reads the IMPERIAL code when a footprint name carries both spellings', () => {
        // "R_0201_0603Metric" is an 0201 (0.05W) written with its metric alias. Matching "0603" anywhere in
        // the string would rate it 0.1W — double — and quietly clear a resistor that is over its limit.
        const c: CircuitJson = {
            ...DIVIDER,
            components: DIVIDER.components.map((comp) => ({ ...comp, footprint: 'R_0201_0603Metric' })),
        };
        const rep = computeResistorPower(c, DIVIDER_MEAS)!;
        expect(rep.components.every((x) => x.ratingW === 0.05)).toBe(true);
    });

    it('keeps the default for a package it does not recognise (never guesses from a name)', () => {
        const c: CircuitJson = {
            ...DIVIDER,
            components: DIVIDER.components.map((comp) => ({
                ...comp,
                footprint: 'R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal',
            })),
        };
        const rep = computeResistorPower(c, DIVIDER_MEAS)!;
        expect(rep.components.every((x) => x.ratingSource === 'default' && x.ratingW === 0.25)).toBe(true);
    });

    it('skips resistors whose nodes were not measured or whose value is unparseable (never guesses)', () => {
        const rep = computeResistorPower(DIVIDER, [v('in', 10)]); // 'out' missing → R1 & R2 both unresolvable
        expect(rep).toBeUndefined(); // nothing computable → no report

        const badVal: CircuitJson = {
            ...DIVIDER,
            components: DIVIDER.components.map((comp) => (comp.designator === 'R1' ? { ...comp, value: 'wat' } : comp)),
        };
        const rep2 = computeResistorPower(badVal, DIVIDER_MEAS)!;
        expect(rep2.components.map((c) => c.designator)).toEqual(['R2']); // R1 skipped (bad value), R2 kept
    });

    it('labels the basis honestly: operating-point for op/dc, last-timestep for tran/ac', () => {
        expect(computeResistorPower(DIVIDER, DIVIDER_MEAS, 'op')!.basis).toBe('operating-point');
        expect(computeResistorPower(DIVIDER, DIVIDER_MEAS, 'dc')!.basis).toBe('operating-point');
        expect(computeResistorPower(DIVIDER, DIVIDER_MEAS, 'tran')!.basis).toBe('last-timestep');
        expect(computeResistorPower(DIVIDER, DIVIDER_MEAS, 'ac')!.basis).toBe('last-timestep');
    });

    it('uses TRUE average heating (Vrms²/R) for a grounded resistor in a transient, not the last-timestep snapshot', () => {
        // R2 (out→gnd) carries 5 Vrms, but the run's LAST sample landed at a zero crossing (final=0). The
        // snapshot power would read 0 W (wrong); the rms basis reports the real 5²/1k = 25 mW.
        const meas: SimMeasurement[] = [
            { node: 'v(in)', min: -10, max: 10, final: 0, pp: 20, avg: 0, rms: 7.07 },
            { node: 'v(out)', min: -5, max: 5, final: 0, pp: 10, avg: 0, rms: 5 },
        ];
        const rep = computeResistorPower(DIVIDER, meas, 'tran')!;
        const r2 = rep.components.find((c) => c.designator === 'R2')!;
        expect(r2.basis).toBe('rms');
        expect(r2.dissipationW).toBeCloseTo(0.025, 4); // 5²/1000 — NOT 0, which the final=0 snapshot would give
        // R1 (in→out) floats — differential Vrms isn't recoverable from per-node RMS → honest snapshot fallback.
        const r1 = rep.components.find((c) => c.designator === 'R1')!;
        expect(r1.basis).toBe('last-timestep');
    });

    it('op/dc keeps the operating-point basis (rms not applied to a steady operating point)', () => {
        const rep = computeResistorPower(DIVIDER, DIVIDER_MEAS, 'op')!;
        expect(rep.components.every((c) => c.basis === 'operating-point')).toBe(true);
    });

    it('returns undefined when the circuit has no resistors', () => {
        const noR: CircuitJson = {
            version: '1.0',
            components: [
                {
                    id: 'v1',
                    type: 'voltage_source',
                    designator: 'V1',
                    value: 'DC 5',
                    pins: [
                        { pinId: '+', netId: 'a' },
                        { pinId: '-', netId: 'gnd' },
                    ],
                },
            ],
            nets: [
                { id: 'a', name: 'a' },
                { id: 'gnd', name: 'gnd', isGround: true },
            ],
        };
        expect(computeResistorPower(noR, [v('a', 5)])).toBeUndefined();
    });
});
