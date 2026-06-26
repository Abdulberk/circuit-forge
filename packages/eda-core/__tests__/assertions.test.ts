/**
 * Verdict-path regression tests (audit batch D):
 *   #5 — a current spec compares the PEAK magnitude max(|min|,|max|), not |max| alone, so a large NEGATIVE
 *        excursion can't sneak under a ceiling.
 *   #8 — the pass/fail decision uses FULL-PRECISION measurements; the 4-sig-fig rounding is display-only and
 *        must not flip a marginal relational check.
 * Plus summarizeSeries now carries the full-precision `raw` the evaluator reads.
 */
import { evaluateAssertions, type AcceptanceCriterion } from '../src/analysis/assertions';
import { summarizeSeries, type SimMeasurement } from '../src/analysis/measurements';

const crit = (c: Partial<AcceptanceCriterion> & Pick<AcceptanceCriterion, 'probe' | 'metric' | 'op' | 'value'>): AcceptanceCriterion => c;

describe('evaluateAssertions — current ceiling uses peak magnitude (audit #5)', () => {
    it('fails a ceiling when the dangerous excursion is NEGATIVE (|max| alone would pass)', () => {
        // ngspice reports a signed branch current; here R1 swings to −5 A while its most-positive sample is
        // only +0.1 A. The old |max| read 0.1 A and passed "< 1 A"; the peak magnitude is 5 A → must FAIL.
        const m: SimMeasurement = {
            node: '@r1[i]', min: -5, max: 0.1, final: 0.1, pp: 5.1,
            raw: { min: -5, max: 0.1, final: 0.1, pp: 5.1 },
        };
        const [r] = evaluateAssertions([m], [crit({ probe: 'i(R1)', metric: 'max', op: 'lt', value: 1 })]);
        expect(r!.pass).toBe(false);
        expect(r!.actual).toBe(5); // peak magnitude, not |max|=0.1
    });

    it('passes when every excursion is within the ceiling', () => {
        const m: SimMeasurement = {
            node: '@r1[i]', min: 0.05, max: 0.1, final: 0.1, pp: 0.05,
            raw: { min: 0.05, max: 0.1, final: 0.1, pp: 0.05 },
        };
        const [r] = evaluateAssertions([m], [crit({ probe: 'i(R1)', metric: 'max', op: 'lt', value: 1 })]);
        expect(r!.pass).toBe(true);
        expect(r!.actual).toBe(0.1);
    });
});

describe('evaluateAssertions — verdict on full precision, rounding is display-only (audit #8)', () => {
    it('fails a marginal lte when the TRUE value is just over the target', () => {
        // raw.max = 5.0004 (> 5). The rounded display field is 5.000 — comparing THAT to 5 would pass. The
        // verdict must read raw and FAIL, while `actual` is still shown rounded.
        const m: SimMeasurement = {
            node: 'out', min: 0, max: 5.0, final: 5.0, pp: 5.0,
            raw: { min: 0, max: 5.0004, final: 5.0004, pp: 5.0004 },
        };
        const [r] = evaluateAssertions([m], [crit({ probe: 'out', metric: 'max', op: 'lte', value: 5 })]);
        expect(r!.pass).toBe(false); // full-precision 5.0004 > 5
        expect(r!.actual).toBe(5); // display rounded to 4 sig figs
    });

    it('falls back to the rounded fields when no `raw` is present (older measurement)', () => {
        const m = { node: 'out', min: 0, max: 5, final: 5, pp: 5 } as SimMeasurement;
        const [r] = evaluateAssertions([m], [crit({ probe: 'out', metric: 'max', op: 'lte', value: 5 })]);
        expect(r!.pass).toBe(true);
    });
});

describe('summarizeSeries — carries full-precision raw alongside the rounded display fields', () => {
    it('rounds the display fields to 4 sig figs but keeps raw at full precision', () => {
        const sm = summarizeSeries({ name: 'out', points: [{ x: 0, y: 1.23456789 }, { x: 1, y: 2.3456789 }] });
        expect(sm.raw).toBeDefined();
        expect(sm.raw!.max).toBeCloseTo(2.3456789, 9);
        expect(sm.raw!.min).toBeCloseTo(1.23456789, 9);
        expect(sm.max).toBe(Number((2.3456789).toPrecision(4))); // 2.346
    });
});
