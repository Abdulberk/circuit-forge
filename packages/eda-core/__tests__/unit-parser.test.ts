/**
 * parseSpiceValue — the SPICE value parser used by perturbCircuit (Monte-Carlo) + value-comparison paths.
 * Locks the scientific-notation regression (sci notation used to return { value:0, isValid:false }).
 */
import { parseSpiceValue } from '../src/utils/unit-parser';

describe('parseSpiceValue — scientific notation (regression)', () => {
    it('parses 1e3 / 1.5e-6 / 2E4 / -2.2e-3 as valid numbers', () => {
        expect(parseSpiceValue('1e3')).toMatchObject({ value: 1000, isValid: true });
        expect(parseSpiceValue('2E4')).toMatchObject({ value: 20000, isValid: true });
        const small = parseSpiceValue('1.5e-6');
        expect(small.isValid).toBe(true);
        expect(small.value).toBeCloseTo(1.5e-6);
        const neg = parseSpiceValue('-2.2e-3');
        expect(neg.isValid).toBe(true);
        expect(neg.value).toBeCloseTo(-0.0022);
    });
});

describe('parseSpiceValue — suffix notation still works (no regression)', () => {
    it('parses standard SPICE suffixes', () => {
        expect(parseSpiceValue('1k')).toMatchObject({ value: 1000, isValid: true });
        expect(parseSpiceValue('1meg')).toMatchObject({ value: 1e6, isValid: true });
        expect(parseSpiceValue('4.7uF')).toMatchObject({ isValid: true, unit: 'F' });
        expect(parseSpiceValue('100n').value).toBeCloseTo(1e-7);
        // SPICE convention: a bare "M" is milli (not mega — that's MEG).
        expect(parseSpiceValue('1M').value).toBe(0.001);
    });

    it('rejects genuinely invalid input', () => {
        expect(parseSpiceValue('').isValid).toBe(false);
        expect(parseSpiceValue('abc').isValid).toBe(false);
    });
});
