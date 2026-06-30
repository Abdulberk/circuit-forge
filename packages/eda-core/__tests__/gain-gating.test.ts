import { evaluateAssertions, attachTransferFunction } from '../src/analysis/assertions';
import type { SimMeasurement } from '../src/analysis/measurements';
import type { TransferFunctionResult } from '../src/types/simulation';

const meas = (node: string, over: Partial<SimMeasurement> = {}): SimMeasurement => ({
    node, min: 0, max: 0, final: 0, pp: 0, avg: 0, rms: 0,
    raw: { min: 0, max: 0, final: 0, pp: 0, avg: 0, rms: 0 }, ...over,
});
const tf = (outputNode: string, gain: number): TransferFunctionResult => ({ gain, outputNode, outputImpedanceOhms: null, inputSource: 'v1', inputImpedanceOhms: null });

describe('attachTransferFunction', () => {
    it('folds the gain onto the output-node measurement (by node key)', () => {
        const ms = [meas('v(out)'), meas('v(in)')];
        attachTransferFunction(ms, tf('v(out)', 2));
        expect(ms[0]!.gain).toBeCloseTo(2, 6);
        expect(ms[1]!.gain).toBeUndefined();
    });

    it('is a no-op on undefined / NaN gain', () => {
        const ms = [meas('v(out)')];
        attachTransferFunction(ms, undefined);
        attachTransferFunction(ms, tf('v(out)', NaN));
        expect(ms[0]!.gain).toBeUndefined();
    });

    it('matches regardless of v() wrapping / case (tf node v(OUT) ↔ bare out)', () => {
        const ms = [meas('out')];
        attachTransferFunction(ms, tf('v(OUT)', 5));
        expect(ms[0]!.gain).toBeCloseTo(5, 6);
    });
});

describe('evaluateAssertions — gain metric (the verdict gate)', () => {
    const crit = { probe: 'v(out)', metric: 'gain' as const, op: 'gte' as const, value: 10 }; // gain ≥ 10

    it('PASSES when measured gain (11) meets the spec', () => {
        const [r] = evaluateAssertions([meas('v(out)', { gain: 11 })], [crit]);
        expect(r!.pass).toBe(true);
        expect(r!.actual).toBeCloseTo(11, 4);
    });

    it('FAILS when measured gain (2) is under the spec', () => {
        const [r] = evaluateAssertions([meas('v(out)', { gain: 2 })], [crit]);
        expect(r!.pass).toBe(false);
        expect(r!.actual).toBeCloseTo(2, 4);
        expect(r!.distance).toBeCloseTo(-8, 4);
    });

    it('is NOT determinable (actual null, fail) when no tf ran — never a silent pass', () => {
        const [r] = evaluateAssertions([meas('v(out)')], [crit]);
        expect(r!.pass).toBe(false);
        expect(r!.actual).toBeNull();
        expect(r!.detail).toMatch(/not determinable|tf/i);
    });

    it('end-to-end: attachTransferFunction → evaluateAssertions gates correctly', () => {
        const ms = [meas('v(out)')];
        attachTransferFunction(ms, tf('v(out)', 2)); // 1+Rf/Rg = 2 non-inverting amp
        expect(evaluateAssertions(ms, [{ ...crit, value: 1.5 }])[0]!.pass).toBe(true);  // gain ≥ 1.5 ✓
        expect(evaluateAssertions(ms, [crit])[0]!.pass).toBe(false);                    // gain ≥ 10 ✗
    });
});
