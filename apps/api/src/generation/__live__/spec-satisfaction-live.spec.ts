/**
 * LIVE: spec-satisfaction over REAL ngspice (no mocks).
 *
 * The other spec-satisfaction tests mock the simulation to exercise the LOOP logic deterministically.
 * THIS one closes the integration gap: it runs the REAL inline CircuitSimulatorService (which spawns the
 * REAL ngspice binary), parses the REAL output, and runs the REAL evaluateAssertions over the REAL
 * measurements — proving the verdict ("verified means meets-the-spec") is correct on actual simulation
 * numbers, not hand-fed ones.
 *
 * Gated on NGSPICE_PATH (skips in CI / when ngspice isn't configured). Run locally with, e.g.:
 *   NGSPICE_PATH="C:/.../ngspice_con.exe" pnpm --filter api test -- spec-satisfaction-live
 */
import type { ConfigService } from '@nestjs/config';
import { CircuitSimulatorService } from '../circuit-simulator.service';
import { evaluateAssertions } from '../assertions';
import type { CircuitJson } from '@circuit-forge/eda-core';

const NGSPICE_PATH = process.env.NGSPICE_PATH;
const live = NGSPICE_PATH ? describe : describe.skip;

// SIM_SANDBOX=none → spawn ngspice directly (no bash/rlimit wrapper) so this runs on the dev host (Windows).
const cfg = {
    get: (k: string) => (({ NGSPICE_PATH, SIM_SANDBOX: 'none' }) as Record<string, string | undefined>)[k],
} as unknown as ConfigService;

/** 10V across two equal 1k resistors → out sits at exactly 5V (the canonical "is the number right" circuit). */
const DIVIDER_5V: CircuitJson = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 10', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '1k', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: 'gnd', name: 'gnd', isGround: true }],
};

/** SIN(0 5 1k) across the same divider → out is a ±2.5V sine → peak-to-peak ≈ 5V (the "amplitude/gain" case). */
const DIVIDER_SINE: CircuitJson = {
    ...DIVIDER_5V,
    components: DIVIDER_5V.components.map((c) => (c.id === 'v1' ? { ...c, value: 'SIN(0 5 1k)' } : c)),
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
        const met = evaluateAssertions(summary.measurements, [{ probe: 'out', metric: 'final', op: 'approx', value: 5, tol: 0.2 }]);
        const unmet = evaluateAssertions(summary.measurements, [{ probe: 'out', metric: 'final', op: 'approx', value: 10, tol: 0.2 }]);
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
});
