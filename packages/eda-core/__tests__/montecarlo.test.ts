/**
 * Monte-Carlo / tolerance tests (Faz B-2 foundation). Pure + seeded — deterministic, no ngspice. Proves the
 * perturbation stays within tolerance, only touches toleranced numeric components, and is reproducible.
 */
import {
    perturbValue,
    perturbCircuit,
    monteCarloVariants,
    computeYield,
    classifyRobustness,
    ROBUSTNESS_PROFILES,
} from '../src/montecarlo';
import type { CircuitJson } from '../src/types/circuit';
import { mulberry32 } from '../src/utils/prng';
import { parseSpiceValue } from '../src/utils/unit-parser';

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
        {
            id: 'v1',
            type: 'voltage_source',
            designator: 'V1',
            value: 'SIN(0 5 1k)',
            tolerance: 0.05,
            pins: [
                { pinId: '+', netId: 'in' },
                { pinId: '-', netId: '0' },
            ],
        },
        {
            id: 'r1',
            type: 'resistor',
            designator: 'R1',
            value: '1k',
            tolerance: 0.05,
            pins: [
                { pinId: '1', netId: 'in' },
                { pinId: '2', netId: 'out' },
            ],
        },
        {
            id: 'c1',
            type: 'capacitor',
            designator: 'C1',
            value: '100n',
            pins: [
                { pinId: '1', netId: 'out' },
                { pinId: '2', netId: '0' },
            ],
        },
    ],
    nets: [
        { id: 'in', name: 'in' },
        { id: 'out', name: 'out' },
        { id: '0', name: '0', isGround: true },
    ],
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

    it("perturbs a 'DC 5' toleranced SUPPLY and keeps the DC form (regression: was skipped → rail never varied)", () => {
        // The exact false-"verified" bug: parseSpiceValue('DC 5') is invalid, so a toleranced rail was
        // silently held at nominal across every variant → the reported yield ignored supply variation.
        const supply: CircuitJson = {
            version: '1.0',
            components: [
                {
                    id: 'v1',
                    type: 'voltage_source',
                    designator: 'V1',
                    value: 'DC 5',
                    tolerance: 0.05,
                    pins: [
                        { pinId: '+', netId: 'in' },
                        { pinId: '-', netId: '0' },
                    ],
                },
            ],
            nets: [
                { id: 'in', name: 'in' },
                { id: '0', name: '0', isGround: true },
            ],
        };
        // Across many seeds the supply must actually move (and stay within ±5%), and re-emit as 'DC <x>'.
        const seen = new Set<string>();
        for (let s = 1; s <= 40; s++) {
            const v1 = perturbCircuit(supply, mulberry32(s)).components[0]!;
            expect(v1.value!.startsWith('DC ')).toBe(true); // keyword preserved (not bare '<x>')
            const volts = parseSpiceValue(v1.value!.slice(3)).value;
            expect(volts).toBeGreaterThanOrEqual(4.75 - 1e-6);
            expect(volts).toBeLessThanOrEqual(5.25 + 1e-6);
            seen.add(v1.value!);
        }
        expect(seen.size).toBeGreaterThan(1); // BEFORE the fix: always exactly 'DC 5' (zero variation)
        expect(seen.has('DC 5')).toBe(false); // never left at the untouched nominal
    });

    it('perturbs a SCIENTIFIC-NOTATION toleranced value (regression: was skipped → MC yield inflated)', () => {
        const sci: CircuitJson = {
            version: '1.0',
            components: [
                {
                    id: 'r1',
                    type: 'resistor',
                    designator: 'R1',
                    value: '1e3',
                    tolerance: 0.05,
                    pins: [
                        { pinId: '1', netId: 'in' },
                        { pinId: '2', netId: 'out' },
                    ],
                },
            ],
            nets: [
                { id: 'in', name: 'in' },
                { id: 'out', name: 'out' },
            ],
        };
        const r = perturbCircuit(sci, mulberry32(5)).components[0]!;
        const ohms = parseSpiceValue(r.value!).value;
        expect(ohms).toBeGreaterThanOrEqual(950 - 1e-6);
        expect(ohms).toBeLessThanOrEqual(1050 + 1e-6);
        expect(ohms).not.toBe(1000); // BEFORE the fix: parseSpiceValue('1e3') was invalid → value left at exactly 1e3
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

describe('classifyRobustness — yield → tier on the Wilson LOWER bound', () => {
    const rep = (yld: number, low: number, evaluated = 300) => ({ yield: yld, ci95: { low, high: 1 }, evaluated });

    it('grades on ci95.low, not the point estimate: high yield but a low CI floor is NOT robust', () => {
        // 100% observed but only 30 runs → Wilson low well under 0.99 → not robust (honest about sample size)
        expect(classifyRobustness(rep(1.0, 0.88)).tier).toBe('at-risk');
        expect(classifyRobustness(rep(1.0, 0.995)).tier).toBe('robust');
    });

    it('consumer bars: >=0.99 robust, 0.90-0.99 marginal, <0.90 at-risk', () => {
        expect(classifyRobustness(rep(1, 0.99)).tier).toBe('robust');
        expect(classifyRobustness(rep(0.97, 0.95)).tier).toBe('marginal');
        expect(classifyRobustness(rep(0.85, 0.8)).tier).toBe('at-risk');
    });

    it('automotive/medical bars are stricter (0.999 / 0.99)', () => {
        expect(classifyRobustness(rep(1, 0.992), 'automotive').tier).toBe('marginal'); // 0.992 < 0.999
        expect(classifyRobustness(rep(1, 0.9995), 'automotive').tier).toBe('robust');
        expect(ROBUSTNESS_PROFILES.automotive!.robustMin).toBe(0.999);
    });

    it("no Monte-Carlo (no ci95.low) → 'unknown', with an honest NOMINAL-only note", () => {
        const v = classifyRobustness(undefined);
        expect(v.tier).toBe('unknown');
        expect(v.note).toMatch(/NOMINAL/i);
    });

    it('carries the honest disclosure fields (yieldLowerBound + evaluated + note)', () => {
        const v = classifyRobustness(rep(0.8, 0.72, 200));
        expect(v.tier).toBe('at-risk');
        expect(v.yieldLowerBound).toBe(0.72);
        expect(v.evaluated).toBe(200);
        expect(v.note).toMatch(/at risk/i);
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
        expect(computeYield([])).toMatchObject({
            total: 0,
            evaluated: 0,
            passed: 0,
            yield: 0,
            ci95: { low: 0, high: 1 },
        });
    });
});
