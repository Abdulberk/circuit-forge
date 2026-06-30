import { parseTransferFunction } from '../src/analysis/tf';

// REAL ngspice-42 `.tf` print output for a 1k/2k divider (gain = 2k/(1k+2k) = 0.6667, Zout = 1k‖2k = 666.7,
// Zin = 1k+2k = 3k), captured from `tf v(out) V1` + explicit print.
const TF_LOG = `
Doing analysis at TEMP = 27.000000 and TNOM = 27.000000

No. of Data Rows : 1
transfer_function = 6.666667e-01
output_impedance_at_v(out) = 6.666667e+02
v1#input_impedance = 3.000000e+03

Total analysis time (seconds) = 0
`;

describe('parseTransferFunction', () => {
    it('returns undefined when there is no transfer_function line', () => {
        expect(parseTransferFunction('')).toBeUndefined();
        expect(parseTransferFunction('No. of Data Rows : 1\noutput_impedance_at_v(out) = 5')).toBeUndefined();
    });

    it('parses gain + output node + Zout + source + Zin from a real ngspice block', () => {
        const tf = parseTransferFunction(TF_LOG);
        expect(tf).toBeDefined();
        expect(tf!.gain).toBeCloseTo(0.6666667, 6);
        expect(tf!.outputNode).toBe('v(out)');
        expect(tf!.outputImpedanceOhms).toBeCloseTo(666.6667, 3);
        expect(tf!.inputSource).toBe('v1');
        expect(tf!.inputImpedanceOhms).toBeCloseTo(3000, 1);
    });

    it('still returns the gain when an impedance line is missing (impedance null)', () => {
        const tf = parseTransferFunction('transfer_function = 1.234560e+01\n');
        expect(tf!.gain).toBeCloseTo(12.3456, 4);
        expect(tf!.outputImpedanceOhms).toBeNull();
        expect(tf!.inputImpedanceOhms).toBeNull();
        expect(tf!.outputNode).toBe('');
        expect(tf!.inputSource).toBe('');
    });
});
