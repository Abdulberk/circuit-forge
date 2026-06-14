/**
 * Pure assertion evaluation — the shared rubric used by BOTH verify-design and the AI design loop.
 * No mocks, no ngspice: operates on already-summarized measurements.
 */
import { evaluateAssertions, describeFailure, compareAssertion, isCurrentProbe } from './assertions';
import type { SimMeasurement } from './circuit-simulator.service';
import type { AssertionDto } from './dto';
import { sanitizeNodeName } from '@circuit-forge/eda-core';

const OUT = `v(${sanitizeNodeName('out')})`; // the SPICE node a probe "out" resolves to
const meas = (node: string, over: Partial<SimMeasurement>): SimMeasurement => ({ node, min: 0, max: 0, final: 0, pp: 0, ...over });

describe('evaluateAssertions', () => {
    it('passes a met criterion and reports zero distance', () => {
        const [r] = evaluateAssertions([meas(OUT, { final: 5 })], [{ probe: 'out', metric: 'final', op: 'approx', value: 5, tol: 0.1 }]);
        expect(r!.pass).toBe(true);
        expect(r!.actual).toBe(5);
        expect(r!.distance).toBe(0);
    });

    it('fails an unmet criterion with a SIGNED distance — catastrophic vs marginal are distinguishable', () => {
        // gain ~3 against a "gain 10" spec (pp ≥ 9.5-ish) → catastrophic
        const cat = evaluateAssertions([meas(OUT, { pp: 3 })], [{ probe: 'out', metric: 'pp', op: 'gte', value: 10, label: 'gain' }])[0]!;
        expect(cat.pass).toBe(false);
        expect(cat.distance).toBe(-7);
        // 4.99 against ≥ 5 → marginal
        const marg = evaluateAssertions([meas(OUT, { final: 4.99 })], [{ probe: 'out', metric: 'final', op: 'gte', value: 5 }])[0]!;
        expect(marg.pass).toBe(false);
        expect(marg.distance).toBeCloseTo(-0.01, 5);
        // describeFailure surfaces the magnitude so the AI fix loop can tell them apart
        expect(describeFailure(cat)).toMatch(/-7/);
        expect(Math.abs(cat.distance!)).toBeGreaterThan(Math.abs(marg.distance!));
    });

    it('a probe not present in the output is unmet (actual + distance null), not silently passed', () => {
        const [r] = evaluateAssertions([meas(OUT, { final: 5 })], [{ probe: 'nope', metric: 'final', op: 'gt', value: 0 }]);
        expect(r!.actual).toBeNull();
        expect(r!.distance).toBeNull();
        expect(r!.pass).toBe(false);
        expect(r!.detail).toMatch(/not found/);
    });

    it('simOk=false → every criterion is unmet (you cannot certify an unmeasured spec)', () => {
        const [r] = evaluateAssertions([meas(OUT, { final: 5 })], [{ probe: 'out', metric: 'final', op: 'approx', value: 5 }], false);
        expect(r!.pass).toBe(false);
        expect(r!.actual).toBeNull();
    });

    it('matches a probe with or without the v() wrapper, case-insensitively', () => {
        const a: AssertionDto[] = [{ probe: 'V(OUT)', metric: 'final', op: 'approx', value: 5, tol: 0.01 }];
        expect(evaluateAssertions([meas(OUT, { final: 5 })], a)[0]!.pass).toBe(true);
    });
});

describe('compareAssertion operators', () => {
    it('covers lt/lte/gt/gte/approx', () => {
        expect(compareAssertion(4, 'lt', 5)).toBe(true);
        expect(compareAssertion(5, 'lt', 5)).toBe(false);
        expect(compareAssertion(5, 'lte', 5)).toBe(true);
        expect(compareAssertion(6, 'gt', 5)).toBe(true);
        expect(compareAssertion(5, 'gte', 5)).toBe(true);
        expect(compareAssertion(5.04, 'approx', 5, 0.05)).toBe(true);
        expect(compareAssertion(5.2, 'approx', 5, 0.05)).toBe(false);
        expect(compareAssertion(5.2, 'approx', 5)).toBe(true); // default tol = 5% of 5 = 0.25
    });
});

describe('evaluateAssertions — edge cases', () => {
    it('evaluates each criterion INDEPENDENTLY (mixed pass/fail in one call)', () => {
        const rs = evaluateAssertions([meas(OUT, { final: 5, pp: 0 })], [
            { probe: 'out', metric: 'final', op: 'approx', value: 5, tol: 0.1 }, // pass
            { probe: 'out', metric: 'pp', op: 'gte', value: 10 }, // fail
        ]);
        expect(rs.map((r) => r.pass)).toEqual([true, false]);
    });

    it('approx with target 0 uses the 1e-9 floor (no false pass on a tiny value)', () => {
        expect(compareAssertion(0, 'approx', 0)).toBe(true);
        expect(compareAssertion(1e-8, 'approx', 0)).toBe(false);
    });

    it('negative target → signed distance is still correct', () => {
        const r = evaluateAssertions([meas(OUT, { final: -3 })], [{ probe: 'out', metric: 'final', op: 'lte', value: -5 }])[0]!;
        // -3 <= -5 is false; distance = actual - target = -3 - (-5) = +2
        expect(r.pass).toBe(false);
        expect(r.distance).toBe(2);
    });

    it('a flat DC node (pp = 0) fails an amplitude/pp criterion cleanly', () => {
        const r = evaluateAssertions([meas(OUT, { pp: 0 })], [{ probe: 'out', metric: 'pp', op: 'gt', value: 1 }])[0]!;
        expect(r.pass).toBe(false);
        expect(r.actual).toBe(0);
        expect(r.distance).toBe(-1);
    });

    it('describeFailure on a not-found probe does not crash or emit NaN', () => {
        const r = evaluateAssertions([], [{ probe: 'ghost', metric: 'final', op: 'gt', value: 0 }])[0]!;
        const s = describeFailure(r);
        expect(s).toContain('ghost');
        expect(s).not.toMatch(/NaN/);
    });
});

describe('isCurrentProbe', () => {
    it('flags current/power probes the voltage-only sim cannot measure', () => {
        expect(isCurrentProbe('i(R1)')).toBe(true);
        expect(isCurrentProbe('@r1[i]')).toBe(true);
        expect(isCurrentProbe('out')).toBe(false);
        expect(isCurrentProbe('v(out)')).toBe(false);
    });
});
