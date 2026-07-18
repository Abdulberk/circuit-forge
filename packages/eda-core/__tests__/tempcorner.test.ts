import { runTempCorner, hasTemperatureResponsiveDevice, type TempRunner } from '../src/tempcorner';
import type { CircuitJson } from '../src/types/circuit';
import type { SimMeasurement } from '../src/analysis/measurements';
import type { AcceptanceCriterion } from '../src/analysis/assertions';

/** A source→resistor→diode string. The diode makes the circuit temperature-responsive (applicable). */
const DIODE: CircuitJson = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: '0' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'd1', type: 'diode', designator: 'D1', pins: [{ pinId: 'anode', netId: 'out' }, { pinId: 'cathode', netId: '0' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: '0', name: '0', isGround: true }],
} as unknown as CircuitJson;

/** Only passives → temperature-flat (not-applicable). */
const PASSIVE: CircuitJson = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: '0' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '1k', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: '0' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: '0', name: '0', isGround: true }],
} as unknown as CircuitJson;

/** Active device is ONLY a behavioral subckt (temp-flat macromodel) → not-applicable, with the subckt reason. */
const SUBCKT: CircuitJson = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: '0' }] },
        { id: 'u1', type: 'subckt', designator: 'U1', model: 'OPAMP', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }, { pinId: '3', netId: '0' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: '0', name: '0', isGround: true }],
} as unknown as CircuitJson;

const meas = (node: string, value: number): SimMeasurement => ({
    node, min: value, max: value, final: value, pp: 0, avg: value, rms: Math.abs(value),
    raw: { min: value, max: value, final: value, pp: 0, avg: value, rms: Math.abs(value) },
});

/** A diode Vf that drops ~2 mV/°C — the classic temperature drift. At 25 °C = 0.70 V. */
const vf = (T: number): number => 0.7 - 0.002 * (T - 25);
const okRunner: TempRunner = async (T) => [meas('out', vf(T))];
const TEMPS = [0, 25, 70]; // consumer profile

describe('hasTemperatureResponsiveDevice', () => {
    it('true when a diode/BJT/MOSFET/JFET/zener is present', () => {
        expect(hasTemperatureResponsiveDevice(DIODE)).toBe(true);
    });
    it('false for a passive-only circuit', () => {
        expect(hasTemperatureResponsiveDevice(PASSIVE)).toBe(false);
    });
    it('false when the only active device is a behavioral subckt', () => {
        expect(hasTemperatureResponsiveDevice(SUBCKT)).toBe(false);
    });
});

describe('runTempCorner — not-applicable (temperature-flat)', () => {
    it('passive-only → applicable:false with the passive reason, never runs, never "passed"', async () => {
        const r = await runTempCorner(PASSIVE, [], { temperaturesC: TEMPS }, okRunner);
        expect(r.applicable).toBe(false);
        expect(r.notApplicableReason).toMatch(/passive-only/i);
        expect(r.points).toHaveLength(0);
        expect(r.passAllTemps).toBe(false);
        expect(r.drift).toHaveLength(0);
    });
    it('subckt-only → applicable:false with the SUBCKT reason (visible, not silent)', async () => {
        const r = await runTempCorner(SUBCKT, [], { temperaturesC: TEMPS }, okRunner);
        expect(r.applicable).toBe(false);
        expect(r.notApplicableReason).toMatch(/subckt|behavioral|model artifact/i);
    });
});

describe('runTempCorner — drift capture (informational, no criteria)', () => {
    it('captures per-node drift: baseline at the temp closest to 25 °C, worst = largest deviation', async () => {
        const r = await runTempCorner(DIODE, [], { temperaturesC: TEMPS }, okRunner);
        expect(r.applicable).toBe(true);
        expect(r.hasLimits).toBe(false);
        expect(r.points.map((p) => p.outcome)).toEqual(['no-limit', 'no-limit', 'no-limit']);
        expect(r.passAllTemps).toBe(false); // nothing to pass without criteria

        const out = r.drift.find((d) => d.metric === 'out');
        expect(out).toBeDefined();
        expect(out!.baselineTempC).toBe(25);
        expect(out!.baselineValue).toBeCloseTo(0.7, 6);
        expect(out!.worstTempC).toBe(70); // |0.61-0.7|=0.09 > |0.75-0.7|=0.05
        expect(out!.worstValue).toBeCloseTo(0.61, 6);
        expect(out!.deltaAbs).toBeCloseTo(-0.09, 6);
        expect(out!.deltaPct).toBeCloseTo((0.09 / 0.7) * 100, 4);
    });
});

describe('runTempCorner — pass/fail against supplied criteria', () => {
    it('passAllTemps when every temperature meets the spec', async () => {
        const crit: AcceptanceCriterion[] = [{ probe: 'out', metric: 'final', op: 'gte', value: 0.5 }];
        const r = await runTempCorner(DIODE, crit, { temperaturesC: TEMPS }, okRunner);
        expect(r.hasLimits).toBe(true);
        expect(r.points.map((p) => p.outcome)).toEqual(['pass', 'pass', 'pass']);
        expect(r.passAllTemps).toBe(true);
        expect(r.failed).toBe(0);
    });
    it('fails at the hot corner when the spec is violated there — passAllTemps false', async () => {
        const crit: AcceptanceCriterion[] = [{ probe: 'out', metric: 'final', op: 'gte', value: 0.65 }];
        const r = await runTempCorner(DIODE, crit, { temperaturesC: TEMPS }, okRunner);
        expect(r.points.find((p) => p.temperatureC === 70)!.outcome).toBe('fail'); // 0.61 < 0.65
        expect(r.points.find((p) => p.temperatureC === 0)!.outcome).toBe('pass'); // 0.75 >= 0.65
        expect(r.failed).toBe(1);
        expect(r.passAllTemps).toBe(false);
    });
});

describe('runTempCorner — a temperature that cannot be evaluated is errored (≠ fail)', () => {
    it('counts a null-returning temperature as errored and defeats passAllTemps', async () => {
        const flaky: TempRunner = async (T) => (T === 70 ? null : [meas('out', vf(T))]);
        const crit: AcceptanceCriterion[] = [{ probe: 'out', metric: 'final', op: 'gte', value: 0.5 }];
        const r = await runTempCorner(DIODE, crit, { temperaturesC: TEMPS }, flaky);
        expect(r.points.find((p) => p.temperatureC === 70)!.outcome).toBe('errored');
        expect(r.errored).toBe(1);
        expect(r.failed).toBe(0); // errored is NOT a failure
        expect(r.passAllTemps).toBe(false); // an unevaluated corner means no full guarantee
    });
});
