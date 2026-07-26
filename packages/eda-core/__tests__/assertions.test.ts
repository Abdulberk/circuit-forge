/**
 * Verdict-path regression tests (audit batch D):
 *   #5 — a current spec compares the PEAK magnitude max(|min|,|max|), not |max| alone, so a large NEGATIVE
 *        excursion can't sneak under a ceiling.
 *   #8 — the pass/fail decision uses FULL-PRECISION measurements; the 4-sig-fig rounding is display-only and
 *        must not flip a marginal relational check.
 * Plus summarizeSeries now carries the full-precision `raw` the evaluator reads.
 */
import {
    evaluateAssertions,
    extraProbesForCriteria,
    netIdByRef,
    type AcceptanceCriterion,
} from '../src/analysis/assertions';
import { summarizeSeries, type SimMeasurement } from '../src/analysis/measurements';

const crit = (
    c: Partial<AcceptanceCriterion> & Pick<AcceptanceCriterion, 'probe' | 'metric' | 'op' | 'value'>,
): AcceptanceCriterion => c;

describe('evaluateAssertions — current ceiling uses peak magnitude (audit #5)', () => {
    it('fails a ceiling when the dangerous excursion is NEGATIVE (|max| alone would pass)', () => {
        // ngspice reports a signed branch current; here R1 swings to −5 A while its most-positive sample is
        // only +0.1 A. The old |max| read 0.1 A and passed "< 1 A"; the peak magnitude is 5 A → must FAIL.
        const m: SimMeasurement = {
            node: '@r1[i]',
            min: -5,
            max: 0.1,
            final: 0.1,
            pp: 5.1,
            avg: -2,
            rms: 3.5,
            raw: { min: -5, max: 0.1, final: 0.1, pp: 5.1, avg: -2, rms: 3.5 },
        };
        const [r] = evaluateAssertions([m], [crit({ probe: 'i(R1)', metric: 'max', op: 'lt', value: 1 })]);
        expect(r!.pass).toBe(false);
        expect(r!.actual).toBe(5); // peak magnitude, not |max|=0.1
    });

    it('passes when every excursion is within the ceiling', () => {
        const m: SimMeasurement = {
            node: '@r1[i]',
            min: 0.05,
            max: 0.1,
            final: 0.1,
            pp: 0.05,
            avg: 0.08,
            rms: 0.08,
            raw: { min: 0.05, max: 0.1, final: 0.1, pp: 0.05, avg: 0.08, rms: 0.08 },
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
            node: 'out',
            min: 0,
            max: 5.0,
            final: 5.0,
            pp: 5.0,
            avg: 2.5,
            rms: 3,
            raw: { min: 0, max: 5.0004, final: 5.0004, pp: 5.0004, avg: 2.5, rms: 3 },
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
        const sm = summarizeSeries({
            name: 'out',
            points: [
                { x: 0, y: 1.23456789 },
                { x: 1, y: 2.3456789 },
            ],
        });
        expect(sm.raw).toBeDefined();
        expect(sm.raw!.max).toBeCloseTo(2.3456789, 9);
        expect(sm.raw!.min).toBeCloseTo(1.23456789, 9);
        expect(sm.max).toBe(Number((2.3456789).toPrecision(4))); // 2.346
        expect(sm.raw!.avg).toBeCloseTo(1.79012, 4); // (1.2346+2.3457)/2 over a unit span (trapezoid of a line)
        expect(sm.raw!.rms).toBeCloseTo(Math.sqrt((1.23456789 ** 2 + 2.3456789 ** 2) / 2), 4);
    });
});

describe('summarizeSeries — time-weighted avg / rms', () => {
    it('constant series → avg = rms = the value', () => {
        const sm = summarizeSeries({
            name: 'out',
            points: [
                { x: 0, y: 5 },
                { x: 1, y: 5 },
                { x: 2, y: 5 },
            ],
        });
        expect(sm.avg).toBeCloseTo(5, 6);
        expect(sm.rms).toBeCloseTo(5, 6);
    });

    it('finely-sampled ramp 0→10 over [0,1] → avg=5, rms=10/√3 (the time integral, not a sample mean)', () => {
        const points = Array.from({ length: 201 }, (_, i) => ({ x: i / 200, y: 10 * (i / 200) }));
        const sm = summarizeSeries({ name: 'out', points });
        expect(sm.avg).toBeCloseTo(5, 2); // ∫10x dx / 1 = 5
        expect(sm.rms).toBeCloseTo(10 / Math.sqrt(3), 2); // sqrt(∫(10x)² dx) = 10/√3 ≈ 5.774
    });

    it('finely-sampled sine (amp 4) → avg≈0, rms≈4/√2 = 2.828', () => {
        const points = Array.from({ length: 1001 }, (_, i) => {
            const t = i / 1000;
            return { x: t, y: 4 * Math.sin(2 * Math.PI * t) };
        });
        const sm = summarizeSeries({ name: 'out', points });
        expect(Math.abs(sm.avg)).toBeLessThan(0.02);
        expect(sm.rms).toBeCloseTo(4 / Math.SQRT2, 2);
    });

    it('TIME-weights, not sample-counts: a long-quiet signal densely sampled only during a late spike', () => {
        // 0 V held over [0,0.9] (2 samples), then a 0→10→0 triangle over [0.9,1.0] with 100 dense samples.
        // A naive SAMPLE mean is dominated by the ~100 spike samples (biased high); the time-weighted average
        // is the triangle area (½·0.1·10 = 0.5) over the 1 s window = 0.5.
        const points: { x: number; y: number }[] = [
            { x: 0, y: 0 },
            { x: 0.9, y: 0 },
        ];
        for (let i = 1; i <= 100; i++) {
            const t = 0.9 + 0.1 * (i / 100);
            const u = (t - 0.9) / 0.1;
            points.push({ x: t, y: u < 0.5 ? 20 * u : 20 * (1 - u) });
        }
        const sm = summarizeSeries({ name: 'out', points });
        const sampleMean = points.reduce((s, p) => s + p.y, 0) / points.length;
        expect(sampleMean).toBeGreaterThan(2); // the biased number a sample-mean would report
        expect(sm.avg).toBeCloseTo(0.5, 1); // the correct time-weighted average
    });

    it('single point → avg = value, rms = |value|', () => {
        const sm = summarizeSeries({ name: 'out', points: [{ x: 0, y: -3 }] });
        expect(sm.avg).toBeCloseTo(-3, 6);
        expect(sm.rms).toBeCloseTo(3, 6);
        expect(sm.raw!.rms).toBeCloseTo(3, 9);
    });
});

describe('evaluateAssertions — avg / rms metrics', () => {
    it('verifies an rms spec and a (signed) avg spec from the measurement', () => {
        const m: SimMeasurement = {
            node: 'out',
            min: -4,
            max: 4,
            final: 0,
            pp: 8,
            avg: 0,
            rms: 2.828,
            raw: { min: -4, max: 4, final: 0, pp: 8, avg: 0, rms: 2.828 },
        };
        expect(
            evaluateAssertions([m], [crit({ probe: 'out', metric: 'rms', op: 'approx', value: 2.83, tol: 0.05 })])[0]!
                .pass,
        ).toBe(true);
        expect(evaluateAssertions([m], [crit({ probe: 'out', metric: 'avg', op: 'lt', value: 0.1 })])[0]!.pass).toBe(
            true,
        );
    });

    it('a current rms spec compares magnitude (sign-agnostic)', () => {
        const m: SimMeasurement = {
            node: '@r1[i]',
            min: -0.01,
            max: 0.01,
            final: 0,
            pp: 0.02,
            avg: 0,
            rms: 0.00707,
            raw: { min: -0.01, max: 0.01, final: 0, pp: 0.02, avg: 0, rms: 0.00707 },
        };
        expect(
            evaluateAssertions(
                [m],
                [crit({ probe: 'i(R1)', metric: 'rms', op: 'approx', value: 0.00707, tol: 1e-4 })],
            )[0]!.pass,
        ).toBe(true);
    });
});

describe('extraProbesForCriteria — the ONE criterion→extra-probe seam (shared by nominal + MC/corner/sweep)', () => {
    it('returns exactly the branch-CURRENT probes (the default sweep never saves a current)', () => {
        const criteria = [
            crit({ probe: 'v(out)', metric: 'max', op: 'gt', value: 4 }), // voltage → auto-probed, no extra
            crit({ probe: 'i(R1)', metric: 'max', op: 'lt', value: 0.1 }), // current → MUST be unioned in
            crit({ probe: '@r1[i]', metric: 'rms', op: 'approx', value: 0.01 }), // measured-form current too
        ];
        expect(extraProbesForCriteria(criteria)).toEqual(['i(R1)', '@r1[i]']);
    });

    it('a frequency (cutoff) / thd / gain criterion needs NO extra probe (it rides on the analysis request)', () => {
        const criteria = [
            crit({ probe: 'out', metric: 'cutoff', op: 'approx', value: 1000 }),
            crit({ probe: 'out', metric: 'thd', op: 'lt', value: 5 }),
            crit({ probe: 'out', metric: 'gain', op: 'gt', value: 10 }),
        ];
        expect(extraProbesForCriteria(criteria)).toEqual([]);
    });

    it('empty / voltage-only criteria yield an empty probe set', () => {
        expect(extraProbesForCriteria([])).toEqual([]);
        expect(extraProbesForCriteria([crit({ probe: 'v(n1)', metric: 'final', op: 'gte', value: 3 })])).toEqual([]);
    });
});

describe('evaluateAssertions — resolves a NAME-based criterion to the id-derived node (arch-review debt #6)', () => {
    // A net whose ID ("n_mid") differs from its NAME ("out"): the generator keys the SPICE node off the ID, so
    // the measurement carries node "n_mid", while the user's criterion names the net — "v(out)". Legal today,
    // universal once the frontend mints UUID ids. Without net context the name can't reach the id-derived node.
    const meas: SimMeasurement = {
        node: 'n_mid',
        min: 2.5,
        max: 2.5,
        final: 2.5,
        pp: 0,
        avg: 2.5,
        rms: 2.5,
        raw: { min: 2.5, max: 2.5, final: 2.5, pp: 0, avg: 2.5, rms: 2.5 },
    };
    const nets = [{ id: 'n_mid', name: 'out' }];
    const cOut = crit({ probe: 'v(out)', metric: 'final', op: 'approx', value: 2.5, tol: 0.05 });

    it('WITHOUT nets: a name-based probe cannot reach the id-derived node → "probe not found" (the latent bug)', () => {
        const [r] = evaluateAssertions([meas], [cOut]);
        expect(r!.pass).toBe(false);
        expect(r!.actual).toBeNull();
    });

    it('WITH nets: the name resolves to the net id → matches the measurement', () => {
        const [r] = evaluateAssertions([meas], [cOut], true, nets);
        expect(r!.pass).toBe(true);
        expect(r!.actual).toBe(2.5);
    });

    it('a probe given by the raw net ID matches too (with nets)', () => {
        expect(
            evaluateAssertions(
                [meas],
                [crit({ probe: 'v(n_mid)', metric: 'final', op: 'approx', value: 2.5, tol: 0.05 })],
                true,
                nets,
            )[0]!.pass,
        ).toBe(true);
    });

    it('id === name (today) is unaffected — passing nets never breaks the current path', () => {
        const m: SimMeasurement = {
            node: 'out',
            min: 2.5,
            max: 2.5,
            final: 2.5,
            pp: 0,
            avg: 2.5,
            rms: 2.5,
            raw: { min: 2.5, max: 2.5, final: 2.5, pp: 0, avg: 2.5, rms: 2.5 },
        };
        expect(evaluateAssertions([m], [cOut], true, [{ id: 'out', name: 'out' }])[0]!.pass).toBe(true);
        expect(evaluateAssertions([m], [cOut])[0]!.pass).toBe(true); // no nets → still matches (id===name)
    });

    it('a current criterion is unaffected by net resolution (keyed by device, not node)', () => {
        const im: SimMeasurement = {
            node: '@r1[i]',
            min: 0.01,
            max: 0.01,
            final: 0.01,
            pp: 0,
            avg: 0.01,
            rms: 0.01,
            raw: { min: 0.01, max: 0.01, final: 0.01, pp: 0, avg: 0.01, rms: 0.01 },
        };
        expect(
            evaluateAssertions(
                [im],
                [crit({ probe: 'i(R1)', metric: 'final', op: 'approx', value: 0.01, tol: 1e-3 })],
                true,
                nets,
            )[0]!.pass,
        ).toBe(true);
    });
});

describe('netIdByRef — {net reference → canonical id}, ids authoritative', () => {
    it('maps name→id and id→id', () => {
        const m = netIdByRef([
            { id: 'n_mid', name: 'out' },
            { id: '0', name: 'gnd' },
        ]);
        expect(m.get('out')).toBe('n_mid');
        expect(m.get('n_mid')).toBe('n_mid');
        expect(m.get('gnd')).toBe('0');
    });

    it('an ID wins when another net NAME collides with it (ids are unique + authoritative)', () => {
        // net A id="x" name="y"; net B id="y". A ref "y" must resolve to B's id "y", not A (via name "y"→"x").
        const m = netIdByRef([
            { id: 'x', name: 'y' },
            { id: 'y', name: 'z' },
        ]);
        expect(m.get('y')).toBe('y');
    });
});

describe('evaluateAssertions — a no-data (empty / all-NaN) series is UNMEASURABLE, never a silent pass (debt #8)', () => {
    it('an EMPTY series → summarizeSeries NaN → assertion actual:null (a 0 would have passed "v(out) < 1")', () => {
        const m = summarizeSeries({ name: 'out', points: [] });
        const [r] = evaluateAssertions([m], [crit({ probe: 'out', metric: 'final', op: 'lt', value: 1 })]);
        expect(r!.pass).toBe(false);
        expect(r!.actual).toBeNull();
    });

    it('an ALL-NaN series (points present, none finite) is likewise unmeasurable, not a 0-pass', () => {
        const m = summarizeSeries({
            name: 'out',
            points: [
                { x: 0, y: Number.NaN },
                { x: 1, y: Number.NaN },
            ],
        });
        const [r] = evaluateAssertions([m], [crit({ probe: 'out', metric: 'max', op: 'gte', value: 0 })]);
        expect(r!.pass).toBe(false);
        expect(r!.actual).toBeNull();
    });
});
