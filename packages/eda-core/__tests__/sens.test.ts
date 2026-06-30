import { parseSensitivity } from '../src/analysis/sens';

// REAL ngspice-42 `.sens v(mid)` + `print all` output for a 5V → 1k/2k divider. v(mid)=3.333V; the meaningful
// sensitivities: d/dV1 = R2/(R1+R2) = 0.6667; d/dR1 = -V·R2/(R1+R2)² = -1.111e-3; d/dR2 = +V·R1/(R1+R2)² =
// 5.556e-4. The per-parameter rows (r1_m, r1_w, …) are ~0 and must be filtered out.
const SENS_LOG = `
Doing analysis at TEMP = 27.000000 and TNOM = 27.000000

No. of Data Rows : 1
r1 = -1.11111e-03
r1_scale = -1.11111e+00
r1_m = -0.000000e+00
r1_w = -0.000000e+00
r2 = 5.555550e-04
r2_m = -0.000000e+00
v1 = 6.666667e-01
Total analysis time (seconds) = 0
ngspice-42 done
`;

describe('parseSensitivity', () => {
    it('returns no entries for empty input', () => {
        expect(parseSensitivity('')).toEqual({ entries: [] });
    });

    it('parses the NON-ZERO d(out)/d(param) entries, dropping the ~0 rows', () => {
        const { entries } = parseSensitivity(SENS_LOG);
        const byName = Object.fromEntries(entries.map((e) => [e.name, e.value]));
        expect(byName.v1).toBeCloseTo(0.6666667, 6); // d(v(mid))/d(V1) = R2/(R1+R2)
        expect(byName.r1).toBeCloseTo(-1.11111e-3, 7); // d/dR1
        expect(byName.r2).toBeCloseTo(5.55555e-4, 8); // d/dR2
        expect(byName.r1_scale).toBeCloseTo(-1.11111, 4); // a non-zero parameter row is kept
        // the zero rows are filtered
        expect(byName).not.toHaveProperty('r1_m');
        expect(byName).not.toHaveProperty('r1_w');
    });

    it('does NOT mistake log prose (names with spaces) for a sensitivity entry', () => {
        // "Total analysis time (seconds) = 0" must not appear as an entry
        const names = parseSensitivity(SENS_LOG).entries.map((e) => e.name);
        expect(names.every((n) => !/\s/.test(n))).toBe(true);
        expect(names).not.toContain('Total');
    });
});
