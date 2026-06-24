/**
 * Monte-Carlo / tolerance tests (Faz B-2 foundation). Pure + seeded — deterministic, no ngspice. Proves the
 * perturbation stays within tolerance, only touches toleranced numeric components, and is reproducible.
 */
import { perturbValue, perturbCircuit, monteCarloVariants, computeYield } from '../src/montecarlo';
import { mulberry32 } from '../src/utils/prng';
import { parseSpiceValue } from '../src/utils/unit-parser';
import type { CircuitJson } from '../src/types/circuit';

describe('perturbValue', () => {
    it('keeps a gaussian sample within ±tolerance (hard-clamped) over many draws', () => {
        const rand = mulberry32(7);
        for (let i = 0; i < 5000; i++) {
            const v = perturbValue(1000, 0.05, rand, 'gaussian');
            expect(v).toBeGreaterThanOrEqual(950 - 1e-9);
            expect(v).toBeLessThanOrEqual(1050 + 1e-9);
        }
    });
    it('keeps a uniform sample within ±tolerance', () => {
        const rand = mulberry32(7);
        for (let i = 0; i < 5000; i++) {
            const v = perturbValue(1000, 0.05, rand, 'uniform');
            expect(v).toBeGreaterThanOrEqual(950 - 1e-9);
            expect(v).toBeLessThanOrEqual(1050 + 1e-9);
        }
    });
    it('is centered near nominal on average (gaussian, large N)', () => {
        const rand = mulberry32(123);
        let sum = 0;
        const N = 20000;
        for (let i = 0; i < N; i++) sum += perturbValue(1000, 0.05, rand, 'gaussian');
        expect(sum / N).toBeGreaterThan(995);
        expect(sum / N).toBeLessThan(1005);
    });
    it('returns the nominal unchanged for zero/negative tolerance', () => {
        const rand = mulberry32(1);
        expect(perturbValue(1000, 0, rand)).toBe(1000);
        expect(perturbValue(1000, -0.1, rand)).toBe(1000);
    });
});

const RC: CircuitJson = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'SIN(0 5 1k)', tolerance: 0.05, pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: '0' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', tolerance: 0.05, pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'c1', type: 'capacitor', designator: 'C1', value: '100n', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: '0' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: '0', name: '0', isGround: true }],
};

describe('perturbCircuit', () => {
    it('perturbs a toleranced numeric value, leaves a no-tolerance and a non-numeric value alone', () => {
        const c = perturbCircuit(RC, mulberry32(3));
        const r1 = c.components.find((x) => x.id === 'r1')!;
        const c1 = c.components.find((x) => x.id === 'c1')!;
        const v1 = c.components.find((x) => x.id === 'v1')!;
        const rOhms = parseSpiceValue(r1.value!).value;
        expect(rOhms).toBeGreaterThanOrEqual(950 - 1e-6);
        expect(rOhms).toBeLessThanOrEqual(1050 + 1e-6);
        expect(rOhms).not.toBe(1000); // actually moved
        expect(c1.value).toBe('100n'); // no tolerance → untouched
        expect(v1.value).toBe('SIN(0 5 1k)'); // toleranced but non-numeric value → untouched (can't perturb)
    });
});

describe('monteCarloVariants', () => {
    it('is reproducible for a seed and differs across seeds', () => {
        const a = monteCarloVariants(RC, 10, 42);
        const b = monteCarloVariants(RC, 10, 42);
        const c = monteCarloVariants(RC, 10, 43);
        expect(a).toEqual(b); // same seed → identical set
        expect(a).not.toEqual(c); // different seed → different draws
        expect(a).toHaveLength(10);
    });
    it('every variant keeps R within ±5% of nominal', () => {
        for (const variant of monteCarloVariants(RC, 50, 99)) {
            const r = parseSpiceValue(variant.components.find((x) => x.id === 'r1')!.value!).value;
            expect(r).toBeGreaterThanOrEqual(950 - 1e-6);
            expect(r).toBeLessThanOrEqual(1050 + 1e-6);
        }
    });
});

describe('computeYield', () => {
    it('counts the passing fraction (boolean form) with a Wilson CI bracketing the point estimate', () => {
        const y = computeYield([true, true, true, false]);
        expect(y).toMatchObject({ total: 4, evaluated: 4, passed: 3, failed: 1, errored: 0, yield: 0.75 });
        expect(y.ci95.low).toBeGreaterThan(0);
        expect(y.ci95.low).toBeLessThanOrEqual(0.75);
        expect(y.ci95.high).toBeGreaterThanOrEqual(0.75);
        expect(y.ci95.high).toBeLessThanOrEqual(1);
    });
    it('EXCLUDES errored variants from the yield denominator (infra blip ≠ a spec failure)', () => {
        // 3 pass, 1 fail, 2 errored → yield = 3/4 = 0.75 (NOT 3/6), evaluated = 4.
        const y = computeYield(['pass', 'pass', 'pass', 'fail', 'errored', 'errored']);
        expect(y).toMatchObject({ total: 6, evaluated: 4, passed: 3, failed: 1, errored: 2, yield: 0.75 });
    });
    it('a tighter CI for more runs (300 vs 30 at the same proportion)', () => {
        const few = computeYield(Array(30).fill('pass').concat(Array(3).fill('fail')));
        const many = computeYield(Array(300).fill('pass').concat(Array(30).fill('fail')));
        const width = (s: { ci95: { low: number; high: number } }) => s.ci95.high - s.ci95.low;
        expect(width(many)).toBeLessThan(width(few)); // more runs → narrower interval
    });
    it('empty input → zero yield, full [0,1] interval', () => {
        expect(computeYield([])).toMatchObject({ total: 0, evaluated: 0, passed: 0, yield: 0, ci95: { low: 0, high: 1 } });
    });
});
