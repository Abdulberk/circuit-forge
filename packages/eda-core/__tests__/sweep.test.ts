import type { AcceptanceCriterion } from '../src/analysis/assertions';
import type { SimMeasurement } from '../src/analysis/measurements';
import { sweepVariants, runParametricSweep, type SweepSpec } from '../src/sweep';
import type { CircuitJson } from '../src/types/circuit';
import { parseSpiceValue } from '../src/utils/unit-parser';

const DIVIDER: CircuitJson = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 10', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: '0' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'r2', type: 'resistor', designator: 'R2', value: '1k', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: '0' }] },
        { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: '0' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: '0', name: '0', isGround: true }],
} as unknown as CircuitJson;

/** A per-node measurement with min=max=final=avg=value (both rounded + raw, so evaluateAssertions is happy). */
const meas = (node: string, value: number): SimMeasurement => ({
    node, min: value, max: value, final: value, pp: 0, avg: value, rms: Math.abs(value),
    raw: { min: value, max: value, final: value, pp: 0, avg: value, rms: Math.abs(value) },
});

/** Read a component's numeric value out of a variant (what the sweep wrote). */
const valueOf = (c: CircuitJson, designator: string): number =>
    parseSpiceValue(c.components.find((x) => x.designator === designator)!.value!).value;

describe('sweepVariants', () => {
    it('generates a linear range of variants, overriding only the target component (unit preserved)', () => {
        const variants = sweepVariants(DIVIDER, { designator: 'R1', start: 1000, stop: 5000, points: 5 });
        expect(variants).toHaveLength(5);
        expect(variants.map((v) => valueOf(v.circuit, 'R1'))).toEqual([1000, 2000, 3000, 4000, 5000]);
        // R2 (and everything else) is untouched on every variant.
        expect(variants.every((v) => valueOf(v.circuit, 'R2') === 1000)).toBe(true);
        // The unit came from R1's "1k" → values are formatted back in kΩ-family SPICE strings, re-parsing cleanly.
        expect(parseSpiceValue(variants[2]!.value).value).toBe(3000);
    });

    it('generates a decade (log) range when scale="dec"', () => {
        const variants = sweepVariants(DIVIDER, { designator: 'R1', start: 1000, stop: 100000, points: 3, scale: 'dec' });
        expect(variants.map((v) => Math.round(valueOf(v.circuit, 'R1')))).toEqual([1000, 10000, 100000]);
    });

    it('uses an explicit values list verbatim (strings) and unit-formats numbers', () => {
        const variants = sweepVariants(DIVIDER, { designator: 'R1', values: ['4.7k', 10000] });
        // strings pass verbatim; the number is unit-formatted (SPICE kilo = 'K', case-insensitive to ngspice).
        expect(variants.map((v) => v.value)).toEqual(['4.7k', '10K']);
    });

    it('returns [] for an unknown designator (caller reports a non-runnable sweep, not a silent no-op)', () => {
        expect(sweepVariants(DIVIDER, { designator: 'R99', start: 1, stop: 2, points: 2 })).toEqual([]);
    });

    it('returns [] for a degenerate range (points < 2, or dec with a non-positive endpoint)', () => {
        expect(sweepVariants(DIVIDER, { designator: 'R1', start: 1, stop: 2, points: 1 })).toEqual([]);
        expect(sweepVariants(DIVIDER, { designator: 'R1', start: 0, stop: 100, points: 3, scale: 'dec' })).toEqual([]);
    });
});

describe('runParametricSweep', () => {
    // Divider out = 10 * R2/(R1+R2). Fake ngspice: read R1 from the variant, compute v(out) exactly.
    const dividerRunner = (variant: CircuitJson): Promise<SimMeasurement[]> => {
        const r1 = valueOf(variant, 'R1');
        const out = 10 * 1000 / (r1 + 1000);
        return Promise.resolve([meas('v(out)', out)]);
    };
    const outAtLeast = (v: number): AcceptanceCriterion[] => [{ probe: 'out', metric: 'final', op: 'gte', value: v }];

    it('passAll + a contiguous passRange when the criterion holds over a low-R prefix of the sweep', async () => {
        // out ≥ 2.5V  ⇔  10·1k/(R1+1k) ≥ 2.5  ⇔  R1 ≤ 3k. Sweep 1k..5k → pass at 1k,2k,3k, fail at 4k,5k.
        const spec: SweepSpec = { designator: 'R1', start: 1000, stop: 5000, points: 5 };
        const res = await runParametricSweep(DIVIDER, outAtLeast(2.5), spec, dividerRunner);
        expect(res.parameter).toBe('R1');
        expect(res.evaluated).toBe(5);
        expect(res.passed).toBe(3);
        expect(res.failed).toBe(2);
        expect(res.errored).toBe(0);
        expect(res.passAll).toBe(false);                 // it fails at the high end
        expect(res.passRange).toEqual({ lo: 1000, hi: 3000 }); // spec holds for R1 ∈ [1k, 3k]
        expect(res.points.map((p) => p.outcome)).toEqual(['pass', 'pass', 'pass', 'fail', 'fail']);
    });

    it('passAll=true when every swept point meets the criterion', async () => {
        const res = await runParametricSweep(DIVIDER, outAtLeast(0.5), { designator: 'R1', start: 1000, stop: 5000, points: 5 }, dividerRunner);
        expect(res.passAll).toBe(true);
        expect(res.passed).toBe(5);
        expect(res.passRange).toEqual({ lo: 1000, hi: 5000 });
    });

    it('a point whose sim could not be run is errored (excluded, not a false fail) and blocks passAll', async () => {
        const flaky = (variant: CircuitJson, i: number) => (i === 2 ? Promise.resolve(null) : dividerRunner(variant));
        const res = await runParametricSweep(DIVIDER, outAtLeast(0.5), { designator: 'R1', start: 1000, stop: 5000, points: 5 }, flaky);
        expect(res.errored).toBe(1);
        expect(res.evaluated).toBe(4);
        expect(res.passed).toBe(4);
        expect(res.passAll).toBe(false); // errored > 0 → we don't claim "holds across the whole sweep"
    });

    it('does NOT summarize a non-contiguous passing region into a range (surfaced per-point instead)', async () => {
        // Criterion passes only at the endpoints, fails in the middle → not a single contiguous block.
        const endsOnly: AcceptanceCriterion[] = [{ probe: 'out', metric: 'final', op: 'lt', value: 100 }];
        const bandRunner = (variant: CircuitJson) => {
            const r1 = valueOf(variant, 'R1');
            const out = r1 === 3000 ? 999 : 1; // only the middle point violates
            return Promise.resolve([meas('v(out)', out)]);
        };
        const res = await runParametricSweep(DIVIDER, endsOnly, { designator: 'R1', start: 1000, stop: 5000, points: 5 }, bandRunner);
        expect(res.passed).toBe(4);
        expect(res.failed).toBe(1);
        expect(res.passRange).toBeUndefined(); // pass–fail–pass is not contiguous → don't fabricate a range
    });

    it('an unknown designator yields an empty, honestly-non-passing sweep', async () => {
        const res = await runParametricSweep(DIVIDER, outAtLeast(1), { designator: 'R99', start: 1, stop: 2, points: 2 }, dividerRunner);
        expect(res.points).toHaveLength(0);
        expect(res.evaluated).toBe(0);
        expect(res.passAll).toBe(false);
        expect(res.passRange).toBeUndefined();
    });
});
