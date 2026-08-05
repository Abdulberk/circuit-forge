/**
 * LIVE: spec-satisfaction over REAL ngspice (no mocks).
 *
 * The other spec-satisfaction tests mock the simulation to exercise the LOOP logic deterministically.
 * THIS one closes the integration gap: it runs the REAL inline CircuitSimulatorService (which spawns the
 * REAL ngspice binary), parses the REAL output, and runs the REAL evaluateAssertions over the REAL
 * measurements — proving the verdict ("verified means meets-the-spec") is correct on actual simulation
 * numbers, not hand-fed ones.
 *
 * Gated on a WORKING ngspice, found the way every live spec here finds one — not on NGSPICE_PATH having been
 * exported by hand. This file used to demand the variable while its sibling searched the install locations,
 * so on a developer machine with ngspice present one of them ran and this one reported itself skipped: three
 * tests over real simulator output, quietly not running, on a machine that could run them.
 */
import type { CircuitJson } from '@circuit-forge/eda-core';
import type { ConfigService } from '@nestjs/config';

import { evaluateAssertions } from '../assertions';
import { CircuitSimulatorService } from '../circuit-simulator.service';

import { describeWithNgspice, ngspiceBinary } from './ngspice';

const NGSPICE_PATH = ngspiceBinary();
const live = describeWithNgspice('spec-satisfaction over REAL ngspice');

// SIM_SANDBOX=none → spawn ngspice directly (no bash/rlimit wrapper) so this runs on the dev host (Windows).
const cfg = {
    get: (k: string) => (({ NGSPICE_PATH, SIM_SANDBOX: 'none' }) as Record<string, string | undefined>)[k],
} as unknown as ConfigService;

/** 10V across two equal 1k resistors → out sits at exactly 5V (the canonical "is the number right" circuit). */
const DIVIDER_5V: CircuitJson = {
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

/** SIN(0 5 1k) across the same divider → out is a ±2.5V sine → peak-to-peak ≈ 5V (the "amplitude/gain" case). */
const DIVIDER_SINE: CircuitJson = {
    ...DIVIDER_5V,
    components: DIVIDER_5V.components.map((c) => (c.id === 'v1' ? { ...c, value: 'SIN(0 5 1k)' } : c)),
};

/** 5V through a single 300Ω resistor to ground → i(R1) = 5/300 = 16.67 mA exactly (the "current spec" case). */
const CURRENT_300: CircuitJson = {
    version: '1.0',
    components: [
        {
            id: 'v1',
            type: 'voltage_source',
            designator: 'V1',
            value: 'DC 5',
            pins: [
                { pinId: '+', netId: 'n1' },
                { pinId: '-', netId: 'gnd' },
            ],
        },
        {
            id: 'r1',
            type: 'resistor',
            designator: 'R1',
            value: '300',
            pins: [
                { pinId: '1', netId: 'n1' },
                { pinId: '2', netId: 'gnd' },
            ],
        },
        { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [
        { id: 'n1', name: 'n1' },
        { id: 'gnd', name: 'gnd', isGround: true },
    ],
};

live('spec-satisfaction over REAL ngspice', () => {
    it('OP: a MET criterion passes and an UNMET one fails — with the real measured value + correct distance', async () => {
        const sim = new CircuitSimulatorService(cfg);
        const summary = await sim.simulate(DIVIDER_5V, { type: 'op' });
        expect(summary.simStatus).toBe('ok'); // real ngspice actually ran
        const m = summary.measurements.find((x) => x.node.includes('out'));
        expect(m).toBeDefined();
        expect(m!.final).toBeCloseTo(5, 1); // ngspice really computed out = 5V

        // "out ≈ 5V" → MET; "out ≈ 10V" (the gain-10-but-got-5 analog) → UNMET, off by ~5
        const met = evaluateAssertions(summary.measurements, [
            { probe: 'out', metric: 'final', op: 'approx', value: 5, tol: 0.2 },
        ]);
        const unmet = evaluateAssertions(summary.measurements, [
            { probe: 'out', metric: 'final', op: 'approx', value: 10, tol: 0.2 },
        ]);
        expect(met[0]!.pass).toBe(true);
        expect(unmet[0]!.pass).toBe(false);
        expect(unmet[0]!.distance).toBeCloseTo(-5, 1); // measured 5 − wanted 10
    }, 30000);

    it('TRAN: amplitude (pp) criterion is checked against real waveform peaks', async () => {
        const sim = new CircuitSimulatorService(cfg);
        const summary = await sim.simulate(DIVIDER_SINE, { type: 'tran', stopTime: '5m', stepTime: '20u' });
        expect(summary.simStatus).toBe('ok');
        const m = summary.measurements.find((x) => x.node.includes('out'));
        expect(m).toBeDefined();
        expect(m!.pp).toBeGreaterThan(4.5); // ±2.5V sine → ~5V peak-to-peak from real ngspice

        const met = evaluateAssertions(summary.measurements, [{ probe: 'out', metric: 'pp', op: 'gte', value: 4 }]);
        const unmet = evaluateAssertions(summary.measurements, [{ probe: 'out', metric: 'pp', op: 'gte', value: 8 }]); // "gain too low"
        expect(met[0]!.pass).toBe(true);
        expect(unmet[0]!.pass).toBe(false);
    }, 30000);

    it('CURRENT: an i(R1) criterion is saved (extraProbes), measured by REAL ngspice, and matched (i(R1) ↔ @r1[i])', async () => {
        const sim = new CircuitSimulatorService(cfg);
        // The voltage-only defaults never save a branch current; extraProbes UNIONs i(R1) in (→ @R1[i] +
        // .options savecurrents). This is the exact gap that let an LED "≈10mA" spec be "verified" by a
        // voltage proxy — here we prove the current itself is measurable end-to-end on the real binary.
        const summary = await sim.simulate(CURRENT_300, { type: 'op' }, ['i(R1)']);
        expect(summary.simStatus).toBe('ok');
        const m = summary.measurements.find((x) => x.node.toLowerCase().includes('r1'));
        expect(m).toBeDefined();
        expect(m!.final).toBeCloseTo(5 / 300, 4); // 16.67 mA, computed by real ngspice

        // The criterion "i(R1)" must resolve to that "@r1[i]" series (currentKey) — NOT read "probe not found".
        const met = evaluateAssertions(summary.measurements, [
            { probe: 'i(R1)', metric: 'final', op: 'approx', value: 5 / 300, tol: 0.001 },
        ]);
        const unmet = evaluateAssertions(summary.measurements, [
            { probe: 'i(R1)', metric: 'final', op: 'approx', value: 0.05, tol: 0.005 },
        ]);
        expect(met[0]!.actual).toBeCloseTo(5 / 300, 4); // matched, not null
        expect(met[0]!.pass).toBe(true);
        expect(unmet[0]!.pass).toBe(false);
        expect(unmet[0]!.distance).toBeCloseTo(5 / 300 - 0.05, 3); // signed gap from the real current
    }, 30000);
});
