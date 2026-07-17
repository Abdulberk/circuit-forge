import { cornerVariants, runWorstCase } from '../src/corner';
import { parseSpiceValue } from '../src/utils/unit-parser';
import type { CircuitJson } from '../src/types/circuit';
import type { SimMeasurement } from '../src/analysis/measurements';
import type { AcceptanceCriterion } from '../src/analysis/assertions';

/** Divider with two ±10% resistors. out = 5·R2/(R1+R2). */
const DIVIDER = (r1Tol?: number, r2Tol?: number): CircuitJson => ({
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: '0' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', ...(r1Tol ? { tolerance: r1Tol } : {}), pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '1k', ...(r2Tol ? { tolerance: r2Tol } : {}), pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: '0' }] },
        { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: '0' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: '0', name: '0', isGround: true }],
} as unknown as CircuitJson);

const meas = (node: string, value: number): SimMeasurement => ({
    node, min: value, max: value, final: value, pp: 0, avg: value, rms: Math.abs(value),
    raw: { min: value, max: value, final: value, pp: 0, avg: value, rms: Math.abs(value) },
});
const valueOf = (c: CircuitJson, d: string): number => parseSpiceValue(c.components.find((x) => x.designator === d)!.value!).value;

describe('cornerVariants', () => {
    it('enumerates 2^k corners (k toleranced components), each at its ±tol extreme', () => {
        const { variants, componentsCornered, omitted } = cornerVariants(DIVIDER(0.1, 0.1));
        expect(componentsCornered.sort()).toEqual(['R1', 'R2']);
        expect(omitted).toEqual([]);
        expect(variants).toHaveLength(4); // 2^2
        // Every corner sets each cornered component to exactly nominal·(1±tol) = 900 or 1100.
        for (const v of variants) {
            expect([900, 1100]).toContain(Math.round(valueOf(v.circuit, 'R1')));
            expect([900, 1100]).toContain(Math.round(valueOf(v.circuit, 'R2')));
        }
        // The four corners are the four distinct (R1,R2) ∈ {lo,hi}² combinations.
        const combos = variants.map((v) => `${v.corner.R1}${v.corner.R2}`).sort();
        expect(combos).toEqual(['hihi', 'hilo', 'lohi', 'lolo']);
    });

    it('only corners components that declare a positive tolerance + numeric value', () => {
        const { variants, componentsCornered } = cornerVariants(DIVIDER(0.1)); // only R1 toleranced
        expect(componentsCornered).toEqual(['R1']);
        expect(variants).toHaveLength(2); // 2^1
        expect(variants.every((v) => valueOf(v.circuit, 'R2') === 1000)).toBe(true); // R2 untouched
    });

    it("corners a toleranced 'DC <n>' SUPPLY and preserves the DC form (regression: rail was never cornered)", () => {
        const withRail: CircuitJson = {
            version: '1.0',
            components: [
                { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', tolerance: 0.1, pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: '0' }] },
                { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: '0' }] },
            ],
            nets: [{ id: 'in', name: 'in' }, { id: '0', name: '0', isGround: true }],
        } as unknown as CircuitJson;
        const { variants, componentsCornered } = cornerVariants(withRail);
        expect(componentsCornered).toEqual(['V1']);
        expect(variants).toHaveLength(2); // lo / hi
        const values = variants.map((v) => v.circuit.components.find((c) => c.designator === 'V1')!.value).sort();
        expect(values).toEqual(['DC 4.5', 'DC 5.5']); // ±10% AND the 'DC ' keyword kept (not bare 4.5/5.5)
    });

    it('honors an explicit component list', () => {
        const { componentsCornered } = cornerVariants(DIVIDER(0.1, 0.1), { components: ['R2'] });
        expect(componentsCornered).toEqual(['R2']);
    });

    it('caps at maxComponents and reports the omitted toleranced components', () => {
        const { variants, componentsCornered, omitted } = cornerVariants(DIVIDER(0.1, 0.1), { maxComponents: 1 });
        expect(componentsCornered).toEqual(['R1']); // first in circuit order
        expect(omitted).toEqual(['R2']);
        expect(variants).toHaveLength(2);
    });

    it('returns no variants when nothing is toleranced', () => {
        const { variants, componentsCornered } = cornerVariants(DIVIDER());
        expect(variants).toEqual([]);
        expect(componentsCornered).toEqual([]);
    });
});

describe('runWorstCase', () => {
    // out = 5·R2/(R1+R2). Fake ngspice computes it exactly from the cornered variant.
    const runner = (variant: CircuitJson): Promise<SimMeasurement[]> => {
        const r1 = valueOf(variant, 'R1');
        const r2 = valueOf(variant, 'R2');
        return Promise.resolve([meas('v(out)', 5 * r2 / (r1 + r2))]);
    };

    it('passAllCorners=true when the criterion holds at every ±tol corner', async () => {
        // Nominal out = 2.5V; corners span ~2.05..2.95V. "out within 2.5 ±0.6" holds everywhere.
        const crit: AcceptanceCriterion[] = [{ probe: 'out', metric: 'final', op: 'approx', value: 2.5, tol: 0.6 }];
        const res = await runWorstCase(DIVIDER(0.1, 0.1), crit, {}, runner);
        expect(res.evaluated).toBe(4);
        expect(res.passed).toBe(4);
        expect(res.passAllCorners).toBe(true);
        expect(res.worstCorners).toEqual([]);
    });

    it('finds the failing corner (passes at nominal but breaks at an extreme)', async () => {
        // "out ≥ 2.45V": nominal 2.5 passes, but the R1-hi/R2-lo corner (1100/900) gives 5·900/2000=2.25 → fail.
        const crit: AcceptanceCriterion[] = [{ probe: 'out', metric: 'final', op: 'gte', value: 2.45 }];
        const res = await runWorstCase(DIVIDER(0.1, 0.1), crit, {}, runner);
        expect(res.passAllCorners).toBe(false);
        expect(res.failed).toBeGreaterThan(0);
        // The worst corner has R1 high AND R2 low (smallest output).
        expect(res.worstCorners).toContainEqual({ R1: 'hi', R2: 'lo' });
    });

    it('an un-runnable corner is errored (excluded, not a false pass) and blocks passAllCorners', async () => {
        const flaky = (variant: CircuitJson, i: number) => (i === 0 ? Promise.resolve(null) : runner(variant));
        const crit: AcceptanceCriterion[] = [{ probe: 'out', metric: 'final', op: 'approx', value: 2.5, tol: 0.6 }];
        const res = await runWorstCase(DIVIDER(0.1, 0.1), crit, {}, flaky);
        expect(res.errored).toBe(1);
        expect(res.evaluated).toBe(3);
        expect(res.passAllCorners).toBe(false);
    });

    it('passAllCorners is FALSE when a toleranced component was omitted by the cap (honest, not over-claimed)', async () => {
        const crit: AcceptanceCriterion[] = [{ probe: 'out', metric: 'final', op: 'approx', value: 2.5, tol: 0.6 }];
        const res = await runWorstCase(DIVIDER(0.1, 0.1), crit, { maxComponents: 1 }, runner);
        expect(res.omitted).toEqual(['R2']);
        expect(res.passed).toBe(res.evaluated); // the cornered subset all pass...
        expect(res.passAllCorners).toBe(false); // ...but we did NOT corner R2 → cannot claim "all corners"
    });

    it('no toleranced components → nothing to corner, not a spurious pass', async () => {
        const res = await runWorstCase(DIVIDER(), [{ probe: 'out', metric: 'final', op: 'gte', value: 1 }], {}, runner);
        expect(res.points).toHaveLength(0);
        expect(res.passAllCorners).toBe(false);
    });
});
