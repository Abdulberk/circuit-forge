import { evaluateAssertions, attachFourierThd } from '../src/analysis/assertions';
import type { SimMeasurement } from '../src/analysis/measurements';
import type { FourierResult } from '../src/types/simulation';

const meas = (node: string, over: Partial<SimMeasurement> = {}): SimMeasurement => ({
    node,
    min: 0,
    max: 0,
    final: 0,
    pp: 0,
    avg: 0,
    rms: 0,
    raw: { min: 0, max: 0, final: 0, pp: 0, avg: 0, rms: 0 },
    ...over,
});
const fr = (probe: string, thd: number): FourierResult => ({ probe, fundamentalFreq: 1000, thd, harmonics: [] });

describe('attachFourierThd', () => {
    it('folds THD (%) onto the matching measurement by node key (v(out) ↔ out)', () => {
        const ms = [meas('v(out)'), meas('v(in)')];
        attachFourierThd(ms, [fr('v(out)', 0.27)]);
        expect(ms[0]!.thd).toBeCloseTo(0.27, 6);
        expect(ms[1]!.thd).toBeUndefined(); // no fourier for this node
    });

    it('is a no-op on undefined/empty fourier', () => {
        const ms = [meas('v(out)')];
        attachFourierThd(ms, undefined);
        attachFourierThd(ms, []);
        expect(ms[0]!.thd).toBeUndefined();
    });

    it('matches regardless of v() wrapping / case (probe v(OUT) ↔ bare node out)', () => {
        const ms = [meas('out')];
        attachFourierThd(ms, [fr('v(OUT)', 42.9)]);
        expect(ms[0]!.thd).toBeCloseTo(42.9, 4);
    });
});

describe('evaluateAssertions — thd metric (the verdict gate)', () => {
    const crit = { probe: 'v(out)', metric: 'thd' as const, op: 'lt' as const, value: 1 }; // THD < 1%

    it('PASSES when measured THD (0.27%) is under the spec', () => {
        const [r] = evaluateAssertions([meas('v(out)', { thd: 0.27 })], [crit]);
        expect(r!.pass).toBe(true);
        expect(r!.actual).toBeCloseTo(0.27, 4);
    });

    it('FAILS when measured THD (42.9%) exceeds the spec — with a signed distance', () => {
        const [r] = evaluateAssertions([meas('v(out)', { thd: 42.9 })], [crit]);
        expect(r!.pass).toBe(false);
        expect(r!.actual).toBeCloseTo(42.9, 3);
        expect(r!.distance).toBeCloseTo(41.9, 2);
    });

    it('is NOT determinable (actual null, fail) when no fourier ran — never a silent pass', () => {
        const [r] = evaluateAssertions([meas('v(out)')], [crit]); // no thd on the measurement
        expect(r!.pass).toBe(false);
        expect(r!.actual).toBeNull();
        expect(r!.detail).toMatch(/not determinable|fourier/i);
    });

    it('end-to-end nominal path: attachFourierThd → evaluateAssertions gates correctly', () => {
        const ms = [meas('v(out)')];
        attachFourierThd(ms, [fr('v(out)', 0.27)]); // simulate the fold-in the design loop / MC does
        expect(evaluateAssertions(ms, [crit])[0]!.pass).toBe(true);
        // and a tighter spec the same THD would miss
        expect(evaluateAssertions(ms, [{ ...crit, value: 0.1 }])[0]!.pass).toBe(false);
    });
});
