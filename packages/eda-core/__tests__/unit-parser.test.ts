/**
 * parseSpiceValue — the SPICE value parser used by perturbCircuit (Monte-Carlo) + value-comparison paths.
 * Locks the scientific-notation regression (sci notation used to return { value:0, isValid:false }).
 */
import { parseSpiceValue, formatSpiceValue } from '../src/utils/unit-parser';

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

describe('parseSpiceValue — superset of SpiceValueSchema (arch-review debt #2)', () => {
    // This is now the ONE parser the analysis path uses too. SpiceValueSchema admits multiplier+unit tokens
    // ("10ms") and a leading "+", so the parser must accept everything the schema does — else a schema-valid
    // analysis config could still be unparseable and (previously) crash netlist generation.
    it('parses a multiplier+unit time like the schema-valid "10ms" (was a hard crash in the old analysis parser)', () => {
        const p = parseSpiceValue('10ms');
        expect(p.isValid).toBe(true);
        expect(p.value).toBeCloseTo(0.01); // 10 milli, unit "s"
    });

    it('accepts a leading "+" (SpiceValueSchema allows [+-]?)', () => {
        expect(parseSpiceValue('+10').value).toBe(10);
        expect(parseSpiceValue('+1k')).toMatchObject({ value: 1000, isValid: true });
        expect(parseSpiceValue('+2.5e-3').value).toBeCloseTo(0.0025);
    });

    it('parses unit-suffixed sub-multiples used by the point-budget guard ("1ns", "1us")', () => {
        expect(parseSpiceValue('1ns').value).toBeCloseTo(1e-9);
        expect(parseSpiceValue('1us').value).toBeCloseTo(1e-6);
    });

    it('parses a scientific-notation mantissa FOLLOWED by a scale/unit (schema admits exponent THEN letters)', () => {
        // Review-found regression: the old private analysis parser accepted these; the tolerant suffix regex
        // originally lacked the exponent group → isValid:false → the point-budget guard was bypassed for a
        // schema-valid step like "1e-4m". These must parse to the SAME number the old parser produced.
        expect(parseSpiceValue('1e-4m').value).toBeCloseTo(1e-7); // 1e-4 milli
        expect(parseSpiceValue('3.3e3k').value).toBeCloseTo(3.3e6); // 3.3e3 kilo
        expect(parseSpiceValue('1e3n').value).toBeCloseTo(1e-6); // 1e3 nano
        expect(parseSpiceValue('2.5e6MEG').value).toBeCloseTo(2.5e12);
        expect(parseSpiceValue('1e-3s')).toMatchObject({ isValid: true, unit: 'S' });
    });
});

describe('formatSpiceValue — never drops significant digits when rounding lands on a decade boundary (debt #2)', () => {
    const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

    it('does NOT collapse a mantissa that rounds to "1000" down to "1" (a 1000x error → defeated guard)', () => {
        // 9.9999e-4 → "u" band, mantissa 999.99 → toPrecision(4) "1000". The old `.replace(/\.?0+$/,'')` turned
        // that into "1" ⇒ "1u" = 1e-6 (1000x too small). Must round-trip to ≈1e-3.
        expect(parseSpiceValue(formatSpiceValue(9.9999e-4)).value).toBeCloseTo(1e-3, 6);
        expect(parseSpiceValue(formatSpiceValue(999.99)).value).toBeCloseTo(1000, 0);
    });

    it('round-trips representative values across bands within 4-sig-fig precision', () => {
        for (const v of [9.9999e-4, 999.99, 1.2346e-5, 47e-12, 3.3e3, 2.5, 5e-3, 1e6]) {
            expect(rel(parseSpiceValue(formatSpiceValue(v)).value, v)).toBeLessThan(1e-3);
        }
    });
});
