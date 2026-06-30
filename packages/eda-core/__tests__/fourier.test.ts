import { parseFourierLog } from '../src/analysis/fourier';

// A REAL ngspice-42 `.four` listing block (captured from `ngspice -b -o`): a ~clean 1 kHz sine through an RC,
// THD ≈ 0. Trailing spaces in the table are intentional (ngspice pads columns) — the parser must tolerate them.
const SINE_BLOCK = `
Doing analysis at TEMP = 27.000000 and TNOM = 27.000000

No. of Data Rows : 1012
Fourier analysis for v(out):
  No. Harmonics: 10, THD: 1.71474e-12 %, Gridsize: 200, Interpolation Degree: 1

Harmonic Frequency   Magnitude   Phase       Norm. Mag   Norm. Phase
-------- ---------   ---------   -----       ---------   -----------
 0       0           2.5846e-15  0           0           0
 1       1000        0.846631    -32.144     1           0
 2       2000        2.85536e-15 -58.74      3.37261e-15 -26.596
 3       3000        5.14043e-15 -90.913     6.07163e-15 -58.769
 4       4000        3.60954e-15 -148.13     4.26341e-15 -115.99
 5       5000        3.29434e-15 -19.756     3.89112e-15 12.3878
 6       6000        1.03313e-14 7.48682     1.22028e-14 39.6309
 7       7000        3.66183e-15 48.7953     4.32518e-15 80.9393
 8       8000        5.26006e-16 130.27      6.21293e-16 162.414
 9       9000        5.64615e-15 109.765     6.66896e-15 141.909


Total analysis time (seconds) = 0.003
`;

// A second block in the same listing (a square-ish wave, THD ≈ 42.9% as measured on ngspice-42) — to exercise
// multi-`.four` parsing and a realistic high-THD value.
const TWO_BLOCK = `${SINE_BLOCK}
Fourier analysis for v(load):
  No. Harmonics: 10, THD: 42.9161 %, Gridsize: 200, Interpolation Degree: 1

Harmonic Frequency   Magnitude   Phase       Norm. Mag   Norm. Phase
-------- ---------   ---------   -----       ---------   -----------
 0       0           1.2e-04     0           0           0
 1       1000        1.27308     -0.045      1           0
 2       2000        2.0e-04     12.5        1.6e-04     12.5
 3       3000        0.42390     -0.137      0.332999    -0.092

Total analysis time (seconds) = 0.004
`;

describe('parseFourierLog', () => {
    it('returns [] when there is no Fourier block', () => {
        expect(parseFourierLog('')).toEqual([]);
        expect(parseFourierLog('Doing analysis at TEMP = 27\nNo. of Data Rows : 10')).toEqual([]);
    });

    it('parses the probe, THD% and full harmonic table from a real ngspice block', () => {
        const [r, ...rest] = parseFourierLog(SINE_BLOCK);
        expect(rest).toHaveLength(0);
        expect(r!.probe).toBe('v(out)');
        expect(r!.thd).toBeCloseTo(1.71474e-12, 15);
        expect(r!.fundamentalFreq).toBe(1000);
        expect(r!.harmonics).toHaveLength(10);
        // DC row
        expect(r!.harmonics[0]).toMatchObject({ order: 0, frequency: 0 });
        // Fundamental row (order 1) — magnitude/normMag from the real listing
        expect(r!.harmonics[1]).toMatchObject({ order: 1, frequency: 1000, normMag: 1 });
        expect(r!.harmonics[1]!.magnitude).toBeCloseTo(0.846631, 5);
        expect(r!.harmonics[1]!.phase).toBeCloseTo(-32.144, 3);
        // 9th harmonic present
        expect(r!.harmonics[9]).toMatchObject({ order: 9, frequency: 9000 });
    });

    it('parses MULTIPLE .four blocks in one listing, in order', () => {
        const res = parseFourierLog(TWO_BLOCK);
        expect(res.map((r) => r.probe)).toEqual(['v(out)', 'v(load)']);
        expect(res[1]!.thd).toBeCloseTo(42.9161, 4);
        // the high-THD block: 3rd harmonic is the dominant distortion term
        expect(res[1]!.harmonics.find((h) => h.order === 3)!.normMag).toBeCloseTo(0.332999, 5);
    });
});
