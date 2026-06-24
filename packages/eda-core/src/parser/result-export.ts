/**
 * Simulation-result EXPORT writers — the counterpart to csv-parser.ts (which READS ngspice output).
 * Lets a user take a finished SimulationResult out of circuit-forge into other tools:
 *   - resultToCsv  → a standard comma-separated table (Excel / pandas / MATLAB readable)
 *   - resultToVcd  → a Value Change Dump (GTKWave / digital waveform viewers)
 * Pure: no I/O, no ngspice. Operates on the already-parsed { meta, series } structure.
 */
import type { SimulationResult, DataSeries } from '../types/simulation';

/** Compact, lossless-enough decimal for export (JS default number formatting preserves round-trip precision). */
function num(n: number): string {
    return Number.isFinite(n) ? String(n) : '';
}

/** Quote a CSV field per RFC 4180 when it contains a delimiter, quote, or newline. */
function csvField(s: string, delim: string): string {
    return s.includes(delim) || s.includes('"') || s.includes('\n') || s.includes('\r')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
}

export interface CsvExportOptions {
    /** Field delimiter (default ","). */
    delimiter?: string;
    /** Line terminator (default "\n"). */
    eol?: string;
}

/**
 * Serialize a SimulationResult to a CSV table: a header row (the x-axis column + one column per series),
 * then one row per sample. All series share the analysis sweep, so rows are zipped by index off the first
 * series; a shorter series leaves blank cells rather than misaligning. The x value is taken from each
 * series' own point (they agree), falling back to the first series. Round-trips: split the text back and
 * the header names + numeric columns reproduce the series.
 */
export function resultToCsv(result: SimulationResult, opts: CsvExportOptions = {}): string {
    const delim = opts.delimiter ?? ',';
    const eol = opts.eol ?? '\n';
    const series = result.series ?? [];
    const xHeader = result.meta?.xUnit ? `${result.meta.xLabel} (${result.meta.xUnit})` : result.meta?.xLabel ?? 'x';

    const header = [xHeader, ...series.map((s) => s.name)].map((h) => csvField(h, delim)).join(delim);
    const rowCount = series.reduce((max, s) => Math.max(max, s.points.length), 0);

    const lines = [header];
    for (let i = 0; i < rowCount; i++) {
        // x: the first series that HAS a point at this index defines the sweep value (all agree on the grid).
        const xSrc = series.find((s) => s.points[i] !== undefined);
        const x = xSrc ? num(xSrc.points[i]!.x) : '';
        const cells = [x, ...series.map((s) => (s.points[i] !== undefined ? num(s.points[i]!.y) : ''))];
        lines.push(cells.join(delim));
    }
    return lines.join(eol) + eol;
}

export interface VcdExportOptions {
    /**
     * Threshold (volts) above which a sample reads logic-1. Per-series auto = midpoint of that series'
     * min/max when omitted — so a 0..5 swing thresholds at 2.5, a 0..3.3 swing at 1.65, etc.
     */
    threshold?: number;
    /** Timescale unit in seconds for the integer VCD time ticks (default 1e-12 = 1 ps). */
    timeUnitSeconds?: number;
}

/** VCD identifier codes: printable ASCII from '!' (33). 94 single-char codes cover any realistic probe set. */
function vcdId(index: number): string {
    return String.fromCharCode(33 + (index % 94));
}

const TIME_UNIT_LABEL: Record<string, string> = {
    '1': '1s', '0.001': '1ms', '0.000001': '1us', '1e-9': '1ns', '1e-12': '1ps', '1e-15': '1fs',
};

/**
 * Serialize a SimulationResult to a digital VCD (GTKWave-loadable). Each series is thresholded to a 1-bit
 * signal (>= threshold → 1) — the classic digital-waveform view of a (possibly mixed-signal) run; the x
 * axis becomes VCD time. Only value CHANGES are emitted (VCD is change-driven). Most meaningful for a
 * transient run; for ac/dc the time axis is the sweep variable. Deterministic (no $date) so it is testable.
 */
export function resultToVcd(result: SimulationResult, opts: VcdExportOptions = {}): string {
    const series = (result.series ?? []).filter((s) => s.points.length > 0);
    const unit = opts.timeUnitSeconds ?? 1e-12;
    const unitLabel = TIME_UNIT_LABEL[String(unit)] ?? `${unit}s`;

    // Per-series threshold (explicit, or the midpoint of its own swing).
    const thresholdOf = (s: DataSeries): number => {
        if (opts.threshold !== undefined) return opts.threshold;
        let lo = Infinity;
        let hi = -Infinity;
        for (const p of s.points) {
            if (p.y < lo) lo = p.y;
            if (p.y > hi) hi = p.y;
        }
        return Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : 0.5;
    };
    const thresholds = series.map(thresholdOf);
    const bitAt = (si: number, i: number): 0 | 1 => (series[si]!.points[i]!.y >= thresholds[si]! ? 1 : 0);

    const head: string[] = [];
    head.push('$version eda-core VCD export $end');
    head.push(`$timescale ${unitLabel} $end`);
    head.push('$scope module circuit $end');
    series.forEach((s, i) => head.push(`$var wire 1 ${vcdId(i)} ${s.name} $end`));
    head.push('$upscope $end');
    head.push('$enddefinitions $end');

    const rowCount = series.reduce((max, s) => Math.max(max, s.points.length), 0);
    const body: string[] = [];
    const last: (0 | 1 | null)[] = series.map(() => null);
    let lastTick: number | null = null;
    for (let i = 0; i < rowCount; i++) {
        // Use the first series that has this index for the time value (the shared sweep grid).
        const tSrc = series.find((s) => s.points[i] !== undefined);
        if (!tSrc) continue;
        const tick = Math.round(tSrc.points[i]!.x / unit);
        const changes: string[] = [];
        for (let si = 0; si < series.length; si++) {
            if (series[si]!.points[i] === undefined) continue;
            const b = bitAt(si, i);
            if (last[si] !== b) {
                changes.push(`${b}${vcdId(si)}`);
                last[si] = b;
            }
        }
        if (changes.length === 0) continue; // VCD is change-driven — skip a tick with no transitions
        if (i === 0 || lastTick === null) {
            body.push(`#${tick}`, '$dumpvars', ...changes, '$end');
        } else {
            body.push(`#${tick}`, ...changes);
        }
        lastTick = tick;
    }

    return head.join('\n') + '\n' + body.join('\n') + '\n';
}
