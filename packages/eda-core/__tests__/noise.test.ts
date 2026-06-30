import { parseNoise, parseNoiseTotals } from '../src/analysis/noise';

// REAL ngspice-42 noise output for an RC low-pass with a 1k resistor (Johnson noise density √(4kTR) ≈
// 4.07e-9 V/√Hz at 300K). CSV is the 4-column pair layout [freq, onoise, freq(dup), inoise]; totals printed.
const NOISE_CSV = ` 1.00000000e+00  4.07136950e-09  1.00000000e+00  4.07137153e-09
 1.25892541e+00  4.07136831e-09  1.25892541e+00  4.07137153e-09
 1.58489319e+00  4.07136643e-09  1.58489319e+00  4.07137153e-09
 1.00000000e+05  2.61300000e-11  1.00000000e+05  4.07137153e-09 `;

const NOISE_LOG = `
Noise analysis ...
onoise_total = 1.606951e-07
inoise_total = 1.442055e-06
`;

describe('parseNoiseTotals', () => {
    it('parses the integrated totals, null when absent', () => {
        expect(parseNoiseTotals(NOISE_LOG)).toEqual({
            onoiseTotalV: expect.closeTo(1.606951e-7, 12),
            inoiseTotalV: expect.closeTo(1.442055e-6, 11),
        });
        expect(parseNoiseTotals('no totals here')).toEqual({ onoiseTotalV: null, inoiseTotalV: null });
    });
});

describe('parseNoise', () => {
    it('builds onoise/inoise spectrum series from the 4-column CSV + attaches totals', () => {
        const { series, totals } = parseNoise(NOISE_CSV, NOISE_LOG);
        expect(series.map((s) => s.name)).toEqual(['onoise_spectrum', 'inoise_spectrum']);
        expect(series[0]!.points).toHaveLength(4);
        // first point: 1 Hz, onoise ≈ 4.07e-9 (the resistor Johnson-noise floor)
        expect(series[0]!.points[0]).toEqual({ x: 1, y: expect.closeTo(4.0713695e-9, 14) });
        // the onoise density rolls off by 100 kHz (past the RC pole)
        expect(series[0]!.points[3]!.y).toBeLessThan(series[0]!.points[0]!.y);
        // inoise is the second vector (col 3), distinct scale column dropped
        expect(series[1]!.points[0]).toEqual({ x: 1, y: expect.closeTo(4.07137153e-9, 14) });
        expect(totals.onoiseTotalV).toBeCloseTo(1.606951e-7, 12);
    });

    it('returns [] series (totals still parsed) on empty/garbage CSV — never throws', () => {
        const { series, totals } = parseNoise('', NOISE_LOG);
        expect(series).toEqual([]);
        expect(totals.inoiseTotalV).toBeCloseTo(1.442055e-6, 11);
        expect(parseNoise('garbage\nnot numbers', '').series).toEqual([]);
    });
});
