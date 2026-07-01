/**
 * Spec-satisfaction gate + "not-determinable" verdict paths (the uncovered ~28% of assertions.ts).
 *
 * These lock the CODE-side fidelity gate that stops an over-claimed "verified": when the user's prompt names a
 * CURRENT or FREQUENCY target, a criterion MUST actually probe that quantity — a node-voltage proxy is NOT
 * "verified" (requiredDimensions / criterionDimension / uncoveredRequiredDimensions). A false NEGATIVE here is
 * safe (status quo); a false POSITIVE would let an over-claim through — so the conservative detectors below are
 * exercised on BOTH the magnitudes/words that must trip AND the look-alikes (part numbers, bare values) that
 * must NOT. Also covers the metric branches that must return actual:null (never a silent pass) when the quantity
 * wasn't measured, and describeFailure's off-by formatting fed to the AI fix loop.
 */
import {
    requiredDimensions,
    criterionDimension,
    uncoveredRequiredDimensions,
    describeFailure,
    evaluateAssertions,
    type AcceptanceCriterion,
    type AssertionResult,
    type SpecDimension,
} from '../src/analysis/assertions';
import type { SimMeasurement } from '../src/analysis/measurements';

const crit = (c: Partial<AcceptanceCriterion> & Pick<AcceptanceCriterion, 'probe' | 'metric' | 'op' | 'value'>): AcceptanceCriterion => c;
const dims = (p: string): SpecDimension[] => [...requiredDimensions(p)].sort();

describe('requiredDimensions — conservative current/frequency detection from the prompt', () => {
    it.each([
        ['an LED at ≈10mA through R1', 'current'],
        ['bias the base to draw 5 A', 'current'],
        ['limit to 0.5A', 'current'],
        ['about 10 milliamps into the load', 'current'],
        ['250 microamps quiescent', 'current'],
    ])('detects CURRENT in %j', (prompt, want) => {
        expect(requiredDimensions(prompt).has(want as SpecDimension)).toBe(true);
    });

    it.each([
        ['a low-pass with a 1kHz corner', 'frequency'],
        ['roll off at 60 Hz', 'frequency'],
        ['set the cutoff appropriately', 'frequency'],
        ['maximize the bandwidth', 'frequency'],
        ['the -3 dB point should be low', 'frequency'],
        ['pick the resonant frequency', 'frequency'],
    ])('detects FREQUENCY in %j', (prompt, want) => {
        expect(requiredDimensions(prompt).has(want as SpecDimension)).toBe(true);
    });

    it('does NOT trip on look-alikes: a part number, a bare resistor value, or an empty prompt', () => {
        // "BD139A": the digits are preceded by a letter, so the (?<![a-z0-9.]) lookbehind blocks the "…a" unit.
        expect(dims('use a BD139A transistor')).toEqual([]);
        // "10k" is a resistance value, not "10kA"/"10kHz" — no current, no frequency.
        expect(dims('a 10k pull-up and a 4.7k divider')).toEqual([]);
        expect(dims('')).toEqual([]);
        // A pure voltage prompt stays empty — voltage is intentionally never inferred/gated.
        expect(dims('a 5V regulated rail')).toEqual([]);
    });

    it('detects BOTH dimensions when the prompt names both', () => {
        expect(dims('draw 10mA and cut off at 1kHz')).toEqual(['current', 'frequency']);
    });

    it('tolerates a null/undefined prompt (?? guard)', () => {
        expect(requiredDimensions(undefined as unknown as string).size).toBe(0);
    });
});

describe('criterionDimension — what a single criterion actually measures', () => {
    it('cutoff metric ⇒ frequency; i()/@[i] probe ⇒ current; any other node ⇒ voltage', () => {
        expect(criterionDimension({ probe: 'out', metric: 'cutoff' })).toBe('frequency');
        expect(criterionDimension({ probe: 'i(R1)', metric: 'max' })).toBe('current');
        expect(criterionDimension({ probe: '@r1[i]', metric: 'rms' })).toBe('current');
        expect(criterionDimension({ probe: 'out', metric: 'final' })).toBe('voltage');
    });
});

describe('uncoveredRequiredDimensions — the gate that blocks an over-claimed "verified"', () => {
    it('flags a CURRENT target checked only by a node-voltage proxy', () => {
        const criteria = [{ probe: 'anode', metric: 'final' }]; // a voltage proxy for an "≈10mA" spec
        expect(uncoveredRequiredDimensions('LED at 10mA', criteria)).toEqual(['current']);
    });

    it('passes once a real branch-current criterion covers the current dimension', () => {
        const criteria = [{ probe: 'i(R1)', metric: 'max' }];
        expect(uncoveredRequiredDimensions('LED at 10mA', criteria)).toEqual([]);
    });

    it('flags a FREQUENCY target when no cutoff criterion measures it', () => {
        expect(uncoveredRequiredDimensions('1kHz low-pass', [{ probe: 'out', metric: 'final' }])).toEqual(['frequency']);
        expect(uncoveredRequiredDimensions('1kHz low-pass', [{ probe: 'out', metric: 'cutoff' }])).toEqual([]);
    });

    it('never gates VOLTAGE (it is the default and always carries a criterion)', () => {
        expect(uncoveredRequiredDimensions('a 5V rail', [{ probe: 'i(R1)', metric: 'max' }])).toEqual([]);
    });

    it('reports BOTH uncovered dimensions when both are required and neither is measured', () => {
        expect(uncoveredRequiredDimensions('10mA at 1kHz', [{ probe: 'out', metric: 'final' }]).sort()).toEqual(['current', 'frequency']);
    });
});

describe('cutoff metric — not-determinable returns actual:null (never a silent pass)', () => {
    it('a cutoff criterion on a measurement with no AC corner → pass:false, actual:null', () => {
        const m: SimMeasurement = { node: 'out', min: 0, max: 1, final: 1, pp: 1, avg: 0.5, rms: 0.7 };
        const [r] = evaluateAssertions([m], [crit({ probe: 'out', metric: 'cutoff', op: 'approx', value: 1000 })]);
        expect(r!.pass).toBe(false);
        expect(r!.actual).toBeNull();
        expect(r!.detail).toMatch(/not determinable/i);
    });

    it('a determinable cutoff is compared at full precision and shown as-is (not 4-sig-fig rounded)', () => {
        const m: SimMeasurement = { node: 'out', min: 0, max: 1, final: 1, pp: 1, avg: 0.5, rms: 0.7, cutoff: 1591.549 };
        const [r] = evaluateAssertions([m], [crit({ probe: 'out', metric: 'cutoff', op: 'approx', value: 1600, tol: 20 })]);
        expect(r!.pass).toBe(true);
        expect(r!.actual).toBe(1591.549); // frequency shown at full precision, unlike the 4-sig-fig display of other metrics
    });
});

describe('evaluateAssertions — unmeasured cases', () => {
    it('probe not found → actual:null with a "not found" detail', () => {
        const m: SimMeasurement = { node: 'out', min: 0, max: 5, final: 5, pp: 5, avg: 2.5, rms: 3 };
        const [r] = evaluateAssertions([m], [crit({ probe: 'nope', metric: 'final', op: 'gte', value: 1 })]);
        expect(r!.actual).toBeNull();
        expect(r!.pass).toBe(false);
        expect(r!.detail).toMatch(/not found/i);
    });

    it('simOk=false → every assertion unmet with "did not produce results"', () => {
        const m: SimMeasurement = { node: 'out', min: 0, max: 5, final: 5, pp: 5, avg: 2.5, rms: 3 };
        const [r] = evaluateAssertions([m], [crit({ probe: 'out', metric: 'final', op: 'gte', value: 1 })], false);
        expect(r!.actual).toBeNull();
        expect(r!.detail).toMatch(/did not produce results/i);
    });
});

describe('describeFailure — off-by message fed to the AI fix loop', () => {
    const base: Omit<AssertionResult, 'actual' | 'distance' | 'pass' | 'detail'> = {
        label: 'gain check', probe: 'out', metric: 'gain', op: 'gte', target: 10,
    };

    it('unmeasured failure → "<label>: <detail>"', () => {
        const r: AssertionResult = { ...base, actual: null, distance: null, pass: false, detail: 'gain(out) not determinable' };
        expect(describeFailure(r)).toBe('gain check: gain(out) not determinable');
    });

    it('measured miss → carries the signed gap AND a percent-off vs the target', () => {
        const r: AssertionResult = { ...base, actual: 3, distance: -7, pass: false, detail: '' };
        const s = describeFailure(r);
        expect(s).toContain('measured gain(out) = 3');
        expect(s).toContain('off by -7.00');
        expect(s).toContain('(-70% off)'); // -7 / |10| = -70%
    });

    it('a target of 0 omits the percent (no divide-by-zero)', () => {
        const r: AssertionResult = { ...base, target: 0, actual: 0.2, distance: 0.2, pass: false, detail: '' };
        const s = describeFailure(r);
        expect(s).toContain('off by 0.200');
        expect(s).not.toContain('% off)');
    });
});
