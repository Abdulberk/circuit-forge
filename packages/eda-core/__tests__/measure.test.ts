import { parseMeasurements } from '../src/analysis/measure';

// A REAL ngspice-42 `.meas` listing (captured from `ngspice -b -o`), including the section header and the mix
// of bare scalars + qualifier-bearing lines. Trailing column padding is intentional.
const MEAS_LOG = `
Doing analysis at TEMP = 27.000000 and TNOM = 27.000000

  Measurements for Transient Analysis

vmax                =  2.544619e-01 at=  4.586477e-04
vmin                =  -1.560857e-01 at=  4.973648e-03
tcross              =   1.17558e-03
vpp                 =  4.105475e-01 from=  0.000000e+00 to=  0.000000e+00
vavg                =  3.083303e-02 from=  0.000000e+00 to=  5.000000e-03
vrms                =   4.19104e+00 from=  0.00000e+00 to=  5.00000e-03
trise               =  2.197222e-03 targ=  2.303083e-03 trig=  1.058615e-04

Total analysis time (seconds) = 0.003
`;

// Failure case: a WHEN threshold never reached — exit stays 0, other measures unaffected.
const FAIL_LOG = `
  Measurements for Transient Analysis

vmax                =  2.544619e-01 at=  4.586477e-04
Error: measure  tcross  when(WHEN) : out of interval
 .meas tran tcross when v(out)=99 rise=1 failed!
`;

describe('parseMeasurements', () => {
    it('returns [] for empty input or no requested names', () => {
        expect(parseMeasurements('', ['vmax'])).toEqual([]);
        expect(parseMeasurements(MEAS_LOG, [])).toEqual([]);
    });

    it('parses scalar values + qualifiers, scoped to the requested names, in order', () => {
        const res = parseMeasurements(MEAS_LOG, ['vmax', 'tcross', 'vrms', 'trise']);
        expect(res.map((r) => r.name)).toEqual(['vmax', 'tcross', 'vrms', 'trise']);
        expect(res[0]).toMatchObject({ name: 'vmax', value: expect.closeTo(0.2544619, 6) });
        expect(res[0]!.qualifiers).toMatchObject({ at: expect.closeTo(4.586477e-4, 9) });
        expect(res[1]).toMatchObject({ name: 'tcross', value: expect.closeTo(1.17558e-3, 7) });
        expect(res[1]!.qualifiers).toBeUndefined();
        expect(res[2]!.value).toBeCloseTo(4.19104, 4);
        expect(res[2]!.qualifiers).toMatchObject({ from: 0, to: expect.closeTo(5e-3, 6) });
        expect(res[3]!.qualifiers).toMatchObject({
            targ: expect.closeTo(2.303083e-3, 8),
            trig: expect.closeTo(1.058615e-4, 9),
        });
    });

    it('IGNORES log lines whose name was not requested (no false positives from other tables)', () => {
        // a sensitivity-like stray line `r1 = -1.1e-3` must NOT be picked up when only vmax is requested
        const res = parseMeasurements(`${MEAS_LOG}\nr1 = -1.111110e-03\nv1 = 6.666667e-01`, ['vmax']);
        expect(res.map((r) => r.name)).toEqual(['vmax']);
    });

    it('marks a failed measure (value null, failed true) and never throws', () => {
        const res = parseMeasurements(FAIL_LOG, ['vmax', 'tcross']);
        const tcross = res.find((r) => r.name === 'tcross')!;
        expect(tcross.value).toBeNull();
        expect(tcross.failed).toBe(true);
        expect(tcross.failureReason).toMatch(/failed!|out of interval/);
        // the other measure on the same run is unaffected
        expect(res.find((r) => r.name === 'vmax')!.value).toBeCloseTo(0.2544619, 6);
    });

    it('drops requested names that produced neither a value nor a failure line', () => {
        const res = parseMeasurements(MEAS_LOG, ['vmax', 'does_not_exist']);
        expect(res.map((r) => r.name)).toEqual(['vmax']);
    });
});
