/**
 * IEC 60063 E-series snapping tests (Faz B-1). Pure number/string math — closed-form expected values.
 */
import { nearestESeries, isESeriesValue, snapValueString } from '../src/utils/eseries';

describe('nearestESeries', () => {
    it('snaps a computed value to the nearest E24 preferred value (in log space)', () => {
        expect(nearestESeries(3270, 'E24')).toBe(3300); // divider output 3.27k -> 3.3k
        expect(nearestESeries(1591.5, 'E24')).toBe(1600); // RC filter 1591.5 -> 1.6k
        expect(nearestESeries(15915, 'E24')).toBe(16000);
    });
    it('leaves an exact preferred value unchanged', () => {
        expect(nearestESeries(4700, 'E24')).toBe(4700);
        expect(nearestESeries(2200, 'E24')).toBe(2200);
    });
    it('snaps up across a decade boundary (9.9 -> 10)', () => {
        expect(nearestESeries(9.9, 'E24')).toBe(10);
        expect(nearestESeries(9900, 'E24')).toBe(10000);
    });
    it('respects the chosen series granularity', () => {
        expect(nearestESeries(3270, 'E12')).toBe(3300); // E12 has 3.3
        expect(nearestESeries(3270, 'E96')).toBe(3240); // E96 has 3.24 and 3.32; 3.27 is nearer 3.24 in log
    });
    it('passes through non-positive / non-finite input untouched', () => {
        expect(nearestESeries(0, 'E24')).toBe(0);
        expect(nearestESeries(-5, 'E24')).toBe(-5);
        expect(nearestESeries(NaN, 'E24')).toBeNaN();
    });
});

describe('isESeriesValue', () => {
    it('accepts an exact preferred value and rejects a computed near-miss', () => {
        expect(isESeriesValue(4700, 'E24')).toBe(true);
        expect(isESeriesValue(1591.5, 'E24')).toBe(false); // ~0.5% off 1.6k -> not manufacturable as-is
        expect(isESeriesValue(3270, 'E24')).toBe(false);
        expect(isESeriesValue(3300, 'E12')).toBe(true);
    });
});

describe('snapValueString', () => {
    it('snaps a SPICE value string and reformats it, preserving the unit', () => {
        expect(snapValueString('3.27k', 'E24')).toBe('3.3K');
        expect(snapValueString('1591.5', 'E24')).toBe('1.6K');
        expect(snapValueString('100n', 'E24')).toBe('100n'); // already standard
    });
    it('returns null for an unparseable value (caller keeps the original)', () => {
        expect(snapValueString('not-a-number', 'E24')).toBeNull();
        expect(snapValueString('', 'E24')).toBeNull();
    });
});
