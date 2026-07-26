/**
 * CSV Parser Tests
 */
import { parseCsv, detectOutputFormat, parseSimulationOutput } from '../src/parser/csv-parser';

describe('CsvParser', () => {
    describe('parseCsv', () => {
        it('should parse simple CSV with time and voltage columns', () => {
            const csv = `0 0
1e-6 0.5
2e-6 1.0
3e-6 0.75`;

            const result = parseCsv(csv, ['v(out)'], 'tran');

            expect(result.meta.analysisType).toBe('tran');
            expect(result.series).toHaveLength(1);
            expect(result.series[0]!.name).toBe('v(out)');
            expect(result.series[0]!.points).toHaveLength(4);
            expect(result.series[0]!.points[0]).toEqual({ x: 0, y: 0 });
            expect(result.series[0]!.points[2]).toEqual({ x: 2e-6, y: 1.0 });
        });

        it('should parse CSV with multiple signals', () => {
            const csv = `0 1 0 0.001
1e-6 1 0.5 0.0005
2e-6 1 1.0 0`;

            const result = parseCsv(csv, ['v(in)', 'v(out)', 'i(r1)'], 'tran');

            expect(result.series).toHaveLength(3);
            expect(result.series.map((s) => s.name)).toEqual(['v(in)', 'v(out)', 'i(r1)']);
        });

        it('should handle tab-separated values', () => {
            const csv = `0\t0
1e-6\t0.5`;

            const result = parseCsv(csv, ['v(out)'], 'tran');

            expect(result.series).toHaveLength(1);
            expect(result.series[0]!.points).toHaveLength(2);
        });

        it('should handle scientific notation', () => {
            const csv = `0.000000e+00 0.000000e+00
1.000000e-06 5.000000e-01
2.000000e-06 1.000000e+00`;

            const result = parseCsv(csv, ['v(out)'], 'tran');

            expect(result.series[0]!.points[1]!.x).toBeCloseTo(1e-6);
            expect(result.series[0]!.points[1]!.y).toBeCloseTo(0.5);
        });

        it('should set AC analysis metadata correctly', () => {
            const csv = `1 0.99
10 0.95
100 0.7
1000 0.3`;

            const result = parseCsv(csv, ['v(out)'], 'ac');

            expect(result.meta.analysisType).toBe('ac');
            expect(result.meta.xLabel).toBe('frequency');
            expect(result.meta.xUnit).toBe('Hz');
        });

        it('collapses AC complex columns (freq, re, im) to magnitude per probe + appends phase series', () => {
            // ngspice `wrdata` writes each AC vector as THREE columns — freq, real, imag — so a row for two
            // probes is: f re0 im0 f re1 im1. The parser reads every 3rd value as x, hypot(re,im) as the
            // magnitude, AND appends one `phase(<probe>)` series per probe (degrees) AFTER the magnitudes so
            // magnitude indexes stay stable (a Bode plot needs both halves).
            const csv = `1 3 4 1 0.6 0.8
10 6 8 10 5 12`;

            const result = parseCsv(csv, ['v(out)', 'v(fb)'], 'ac');

            expect(result.series).toHaveLength(4); // 2 magnitudes + 2 phases
            expect(result.series.map((s) => s.name)).toEqual(['v(out)', 'v(fb)', 'phase(v(out))', 'phase(v(fb))']);
            // probe 0 magnitude: |3+4j| = 5, |6+8j| = 10
            expect(result.series[0]!.points).toEqual([
                { x: 1, y: 5 },
                { x: 10, y: 10 },
            ]);
            // probe 1 magnitude: |0.6+0.8j| = 1, |5+12j| = 13
            expect(result.series[1]!.points[0]!.y).toBeCloseTo(1);
            expect(result.series[1]!.points[1]!.y).toBeCloseTo(13);
            // phases (degrees): atan2(4,3) = 53.13°; atan2(12,5) = 67.38°
            expect(result.series[2]!.points[0]!.y).toBeCloseTo(53.13, 1);
            expect(result.series[2]!.points[1]!.y).toBeCloseTo(53.13, 1); // atan2(8,6) same angle
            expect(result.series[3]!.points[0]!.y).toBeCloseTo(53.13, 1); // atan2(0.8,0.6)
            expect(result.series[3]!.points[1]!.y).toBeCloseTo(67.38, 1);
        });

        it('does NOT append phase series for non-AC analyses', () => {
            const csv = `0 1 0 2
1e-6 1 1e-6 2`;
            const result = parseCsv(csv, ['v(a)', 'v(b)'], 'tran');
            expect(result.series).toHaveLength(2);
            expect(result.series.every((s) => !s.name.startsWith('phase('))).toBe(true);
        });

        it('should handle empty lines', () => {
            const csv = `0 0

1e-6 0.5

2e-6 1.0`;

            const result = parseCsv(csv, ['v(out)'], 'tran');

            expect(result.series[0]!.points).toHaveLength(3);
        });

        it('should handle Windows line endings', () => {
            const csv = '0 0\r\n1e-6 0.5\r\n2e-6 1.0';

            const result = parseCsv(csv, ['v(out)'], 'tran');

            expect(result.series[0]!.points).toHaveLength(3);
        });

        it('should return empty points on empty input', () => {
            const result = parseCsv('', ['v(out)'], 'tran');
            expect(result.series).toHaveLength(1);
            expect(result.series[0]!.points).toHaveLength(0);
        });

        it('should skip comment lines', () => {
            const csv = `# This is a comment
* Another comment
0 0
1e-6 0.5`;

            const result = parseCsv(csv, ['v(out)'], 'tran');

            expect(result.series[0]!.points).toHaveLength(2);
        });
    });

    describe('detectOutputFormat', () => {
        it('should detect raw format', () => {
            const raw = `Title: test
Plotname: Transient Analysis
No. Variables: 2
No. Points: 100`;

            expect(detectOutputFormat(raw)).toBe('raw');
        });

        it('should detect csv format', () => {
            const csv = `0 0
1e-6 0.5
2e-6 1.0`;

            expect(detectOutputFormat(csv)).toBe('csv');
        });
    });

    describe('parseSimulationOutput', () => {
        it('should auto-detect and parse CSV format', () => {
            const csv = `0 0
1e-6 0.5`;

            const result = parseSimulationOutput(csv, ['v(out)'], 'tran');

            expect(result.series).toHaveLength(1);
            expect(result.series[0]!.points).toHaveLength(2);
        });
    });
});
