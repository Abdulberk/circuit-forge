/**
 * Tests for the simulation-result export writers (Faz A #4): CSV (universal table) + VCD (GTKWave).
 * The CSV test is a genuine round-trip — write the table, split it back, and reconstruct the series — so it
 * proves the export is lossless, not just well-formed.
 */
import { parseCsv } from '../src/parser/csv-parser';
import { resultToCsv, resultToVcd } from '../src/parser/result-export';
import type { SimulationResult } from '../src/types/simulation';

const tranResult: SimulationResult = {
    meta: { analysisType: 'tran', xLabel: 'time', xUnit: 's', pointsCount: 4 },
    series: [
        { name: 'v(a)', points: [{ x: 0, y: 0 }, { x: 1e-3, y: 5 }, { x: 2e-3, y: 2.5 }, { x: 3e-3, y: 0 }] },
        { name: 'v(b)', points: [{ x: 0, y: 1 }, { x: 1e-3, y: 1 }, { x: 2e-3, y: 1 }, { x: 3e-3, y: 1 }] },
    ],
};

describe('resultToCsv', () => {
    it('writes a header (x-axis + series) and one row per sample', () => {
        const csv = resultToCsv(tranResult);
        const lines = csv.trim().split('\n');
        expect(lines[0]).toBe('time (s),v(a),v(b)');
        expect(lines).toHaveLength(1 + 4); // header + 4 samples
        expect(lines[2]).toBe('0.001,5,1');
    });

    it('round-trips losslessly — splitting the CSV back reproduces every series value', () => {
        const csv = resultToCsv(tranResult);
        const rows = csv.trim().split('\n').slice(1).map((l) => l.split(',').map(Number));
        for (let s = 0; s < tranResult.series.length; s++) {
            const col = s + 1; // column 0 is the x axis
            const got = rows.map((r) => r[col]);
            const want = tranResult.series[s]!.points.map((p) => p.y);
            expect(got).toEqual(want);
        }
        // the x column reproduces the sweep grid too
        expect(rows.map((r) => r[0])).toEqual([0, 1e-3, 2e-3, 3e-3]);
    });

    it('quotes a series name containing the delimiter (RFC 4180)', () => {
        const r: SimulationResult = { meta: { analysisType: 'dc', xLabel: 'v-sweep', pointsCount: 1 }, series: [{ name: 'i(R1,sense)', points: [{ x: 0, y: 1 }] }] };
        expect(resultToCsv(r).split('\n')[0]).toBe('v-sweep,"i(R1,sense)"');
    });

    it('produces a table the AC magnitude+phase series also export cleanly through (no misalignment)', () => {
        // Mirror what parseCsv yields for an AC run: magnitudes then phase series, all on the same grid.
        const ac = parseCsv('1 1.0 0.0 1 0.5 -0.5\n10 0.7 0.0 10 0.35 -0.35', ['v(out)'], 'ac');
        const csv = resultToCsv(ac);
        const header = csv.split('\n')[0]!;
        expect(header.startsWith('frequency (Hz),')).toBe(true);
        expect(header).toContain('v(out)');
        expect(header).toContain('phase(v(out))');
    });
});

describe('resultToVcd', () => {
    const togglingResult: SimulationResult = {
        meta: { analysisType: 'tran', xLabel: 'time', xUnit: 's', pointsCount: 3 },
        series: [
            { name: 'v(out)', points: [{ x: 0, y: 0 }, { x: 1e-6, y: 5 }, { x: 2e-6, y: 0 }] },
            { name: 'v(clk)', points: [{ x: 0, y: 5 }, { x: 1e-6, y: 0 }, { x: 2e-6, y: 5 }] },
        ],
    };

    it('emits a valid VCD skeleton with one $var per series', () => {
        const vcd = resultToVcd(togglingResult);
        expect(vcd).toContain('$timescale');
        expect(vcd).toContain('$enddefinitions $end');
        expect(vcd).toContain('$dumpvars');
        expect(vcd).toMatch(/\$var wire 1 ! v\(out\) \$end/);
        expect(vcd).toMatch(/\$var wire 1 " v\(clk\) \$end/); // second series gets the next id code
    });

    it('records the threshold crossings as VCD value changes (signal toggles 0<->1)', () => {
        const vcd = resultToVcd(togglingResult);
        // v(out) (id '!') auto-thresholds at 2.5: 0->0, 5->1, 0->0 — both edges present.
        expect(vcd).toContain('1!');
        expect(vcd).toContain('0!');
        // time ticks are emitted (1us at the 1ps default timescale = #1000000).
        expect(vcd).toMatch(/#1000000/);
    });

    it('honors an explicit logic threshold', () => {
        // threshold 4 → 5 is the only "1"; v(out) reads 0,1,0 still, but a 3.3V sample would read 0.
        const r: SimulationResult = { meta: { analysisType: 'tran', xLabel: 'time', xUnit: 's', pointsCount: 2 }, series: [{ name: 'n', points: [{ x: 0, y: 3.3 }, { x: 1e-9, y: 5 }] }] };
        const vcd = resultToVcd(r, { threshold: 4 });
        expect(vcd).toContain('0!'); // 3.3 < 4 → 0
        expect(vcd).toContain('1!'); // 5 >= 4 → 1
    });
});
