/**
 * Pure assertion evaluation — the shared rubric used by BOTH verify-design and the AI design loop.
 * No mocks, no ngspice: operates on already-summarized measurements.
 */
import { sanitizeNodeName } from '@circuit-forge/eda-core';

import {
    evaluateAssertions,
    describeFailure,
    compareAssertion,
    isCurrentProbe,
    isObservableCurrentProbe,
    currentKey,
    criterionDimension,
    requiredDimensions,
    uncoveredRequiredDimensions,
} from './assertions';
import type { SimMeasurement } from './circuit-simulator.service';
import type { AssertionDto } from './dto';

const OUT = `v(${sanitizeNodeName('out')})`; // the SPICE node a probe "out" resolves to
const meas = (node: string, over: Partial<SimMeasurement>): SimMeasurement => ({ node, min: 0, max: 0, final: 0, pp: 0, avg: 0, rms: 0, ...over });

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

describe('currentKey — bridges the criterion form i(R1) and the measured form @r1[i]', () => {
    it('extracts the same device key from both forms (case-insensitive)', () => {
        expect(currentKey('i(R1)')).toBe('r1');
        expect(currentKey('I( V1 )')).toBe('v1');
        expect(currentKey('@r1[i]')).toBe('r1');
        expect(currentKey('@R1[ i ]')).toBe('r1');
        expect(currentKey('i(R1)')).toBe(currentKey('@r1[i]')); // the whole point
    });
    it('returns null for a voltage probe', () => {
        expect(currentKey('out')).toBeNull();
        expect(currentKey('v(out)')).toBeNull();
    });
});

describe('evaluateAssertions — current criterion matches its @<dev>[i] measurement', () => {
    it('a criterion probe "i(R1)" resolves to the measured series named "@r1[i]"', () => {
        // This is exactly how ngspice/wrdata names a saved R/C branch current. Before currentKey, this
        // would read as "probe not found" (nodeKey("i(R1)") !== nodeKey("@r1[i]")).
        const r = evaluateAssertions(
            [meas('@r1[i]', { final: 0.0167 })],
            [{ probe: 'i(R1)', metric: 'final', op: 'approx', value: 0.0167, tol: 0.001 }],
        )[0]!;
        expect(r.actual).toBeCloseTo(0.0167, 5);
        expect(r.pass).toBe(true);
    });

    it('a current criterion does NOT accidentally match a voltage node, and vice-versa', () => {
        // voltage node present, but a current criterion has no current measurement → not found
        const cur = evaluateAssertions([meas(OUT, { final: 5 })], [{ probe: 'i(R1)', metric: 'final', op: 'gt', value: 0 }])[0]!;
        expect(cur.actual).toBeNull();
        // current measurement present, but a voltage criterion on "out" has no voltage measurement → not found
        const volt = evaluateAssertions([meas('@r1[i]', { final: 0.01 })], [{ probe: 'out', metric: 'final', op: 'gt', value: 0 }])[0]!;
        expect(volt.actual).toBeNull();
    });

    it('compares the MAGNITUDE of a current (ngspice signs @r1[i] by pin order) — a negative reading still passes a positive target', () => {
        // A correctly-wired resistor can read -10mA depending on pin order; "~10mA" is a magnitude spec.
        const r = evaluateAssertions(
            [meas('@r1[i]', { final: -0.01 })],
            [{ probe: 'i(R1)', metric: 'final', op: 'approx', value: 0.01, tol: 0.001 }],
        )[0]!;
        expect(r.actual).toBeCloseTo(0.01, 5); // |−0.01| reported as the magnitude
        expect(r.pass).toBe(true);
        // a voltage is NOT abs'd — a −5V node stays −5V
        const v = evaluateAssertions([meas(OUT, { final: -5 })], [{ probe: 'out', metric: 'final', op: 'approx', value: 5, tol: 0.1 }])[0]!;
        expect(v.actual).toBe(-5);
        expect(v.pass).toBe(false);
    });
});

describe('isObservableCurrentProbe — which current probes ngspice can actually measure', () => {
    it('accepts R/C/V/L/E/H currents and rejects diode/transistor/subckt terminal currents', () => {
        expect(isObservableCurrentProbe('i(R1)')).toBe(true);
        expect(isObservableCurrentProbe('i(C2)')).toBe(true);
        expect(isObservableCurrentProbe('i(V1)')).toBe(true);
        expect(isObservableCurrentProbe('i(L3)')).toBe(true);
        expect(isObservableCurrentProbe('i(D1)')).toBe(false); // diode — no branch vector
        expect(isObservableCurrentProbe('i(Q1)')).toBe(false); // transistor
        expect(isObservableCurrentProbe('i(X1)')).toBe(false); // subckt
        expect(isObservableCurrentProbe('out')).toBe(false); // not a current probe at all
    });
});

describe('criterionDimension', () => {
    it('classifies a current probe as current, a cutoff metric as frequency, and any other node probe as voltage', () => {
        expect(criterionDimension({ probe: 'i(R1)' })).toBe('current');
        expect(criterionDimension({ probe: '@r1[i]' })).toBe('current');
        expect(criterionDimension({ probe: 'out' })).toBe('voltage');
        expect(criterionDimension({ probe: 'v(out)' })).toBe('voltage');
        // The cutoff metric measures a frequency even though the probe is a plain node voltage.
        expect(criterionDimension({ probe: 'out', metric: 'cutoff' })).toBe('frequency');
        expect(criterionDimension({ probe: 'v(out)', metric: 'final' })).toBe('voltage');
    });
});

describe('evaluateAssertions — the cutoff (−3 dB) metric', () => {
    // An AC magnitude series is summarized with a `cutoff` field (number or null); evaluateAssertions reads it.
    it('passes when the measured −3 dB corner is within tolerance of the target', () => {
        const [r] = evaluateAssertions(
            [meas(OUT, { cutoff: 1020 })],
            [{ probe: 'out', metric: 'cutoff', op: 'approx', value: 1000, tol: 150 }],
        );
        expect(r!.pass).toBe(true);
        expect(r!.actual).toBe(1020);
    });
    it('fails when the measured corner is off-target, with a signed distance the fix loop can read', () => {
        const [r] = evaluateAssertions(
            [meas(OUT, { cutoff: 1700 })],
            [{ probe: 'out', metric: 'cutoff', op: 'approx', value: 1000, tol: 150 }],
        );
        expect(r!.pass).toBe(false);
        expect(r!.distance).toBe(700);
    });
    it('is an honest FAIL (not a pass, not a crash) when the cutoff was not determinable (null)', () => {
        const [r] = evaluateAssertions(
            [meas(OUT, { cutoff: null })],
            [{ probe: 'out', metric: 'cutoff', op: 'approx', value: 1000, tol: 150 }],
        );
        expect(r!.pass).toBe(false);
        expect(r!.actual).toBeNull();
        expect(r!.detail).toMatch(/not determinable/i);
    });
    it('is an honest FAIL when the metric is cutoff but the run was not AC (field absent → treated as null)', () => {
        const [r] = evaluateAssertions(
            [meas(OUT, {})], // no cutoff field, e.g. a tran run
            [{ probe: 'out', metric: 'cutoff', op: 'approx', value: 1000, tol: 150 }],
        );
        expect(r!.pass).toBe(false);
        expect(r!.actual).toBeNull();
    });
});

describe('requiredDimensions — conservative, code-side detection of the user-named quantity', () => {
    it('detects a CURRENT target only when a real magnitude+unit is present', () => {
        expect(requiredDimensions('about 10 mA flows through the LED').has('current')).toBe(true);
        expect(requiredDimensions('limit to 20mA from 5V').has('current')).toBe(true);
        expect(requiredDimensions('bias the transistor at 1 milliamp').has('current')).toBe(true);
    });
    it('does NOT flag current for voltage-only prompts (no false positives on the battery)', () => {
        for (const p of [
            'Design a resistive voltage divider that outputs 5V from a 12V DC supply.',
            'outputs 3.3V from a 5V DC supply, with the output loaded by a 10k resistor',
            'outputs 2V from a 10V DC supply. The output must be within 2% of 2V.',
            'a gain 10 amplifier', // "10 amplifier" must NOT read as amps
        ]) {
            expect(requiredDimensions(p).has('current')).toBe(false);
        }
    });
    it('detects a FREQUENCY target from a unit or a cutoff keyword', () => {
        expect(requiredDimensions('RC low-pass with a 1 kHz cutoff').has('frequency')).toBe(true);
        expect(requiredDimensions('attenuate above 60 Hz').has('frequency')).toBe(true);
        expect(requiredDimensions('a divider that outputs 5V').has('frequency')).toBe(false);
    });
});

describe('uncoveredRequiredDimensions — the verified-coverage gate', () => {
    const voltageCrit = [{ probe: 'out' }];
    const currentCrit = [{ probe: 'i(R1)' }];
    const cutoffCrit = [{ probe: 'out', metric: 'cutoff' }];
    it('flags a current spec checked only by a voltage proxy', () => {
        expect(uncoveredRequiredDimensions('10 mA through the load', voltageCrit)).toEqual(['current']);
    });
    it('is satisfied once a current criterion is present', () => {
        expect(uncoveredRequiredDimensions('10 mA through the load', [...voltageCrit, ...currentCrit])).toEqual([]);
    });
    it('never gates a pure voltage spec', () => {
        expect(uncoveredRequiredDimensions('outputs 5V from 12V', voltageCrit)).toEqual([]);
    });
    it('now HARD-GATES a frequency spec checked only by a voltage proxy (the cutoff metric exists)', () => {
        expect(uncoveredRequiredDimensions('1 kHz cutoff filter', voltageCrit)).toEqual(['frequency']);
    });
    it('is satisfied once a cutoff criterion measures the named frequency', () => {
        expect(uncoveredRequiredDimensions('1 kHz cutoff filter', [...voltageCrit, ...cutoffCrit])).toEqual([]);
    });
    it('flags BOTH a current and a frequency target left to voltage proxies', () => {
        expect(uncoveredRequiredDimensions('20 mA bias and a 1 kHz cutoff', voltageCrit).sort()).toEqual(['current', 'frequency']);
    });
});
