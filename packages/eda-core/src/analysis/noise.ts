/**
 * Parse an ngspice `.noise` run into its spectrum series + integrated totals.
 *
 * The generator's noise control block writes the per-frequency spectrum to the wrdata CSV (so it rides the
 * normal output.csv path) and prints the integrated totals to the listing:
 *   - CSV: `wrdata output.csv onoise_spectrum inoise_spectrum` → whitespace columns [freq, onoise, freq, inoise]
 *     (each vector is a scale+value PAIR, so the frequency column is repeated; we drop the duplicate).
 *   - log: `print onoise_total inoise_total` → `onoise_total = <V>` / `inoise_total = <V>`.
 *
 * Self-contained (does NOT go through parseSimulationOutput, whose probe handling is v()/i()-centric and would
 * drop the bare onoise_spectrum/inoise_spectrum vector names). Pure + defensive: missing data → empty series /
 * null totals, never throws.
 */
import type { DataSeries, NoiseResult } from '../types/simulation';

const NUM = '[-+]?\\d*\\.?\\d+(?:[eE][-+]?\\d+)?';
const ONOISE_TOTAL_RE = new RegExp(`^\\s*onoise_total\\s*=\\s*(${NUM})`, 'im');
const INOISE_TOTAL_RE = new RegExp(`^\\s*inoise_total\\s*=\\s*(${NUM})`, 'im');

/** Parse the integrated noise totals from the listing. */
export function parseNoiseTotals(log: string): NoiseResult {
    const num = (re: RegExp): number | null => {
        const m = log.match(re);
        if (!m) return null;
        const n = parseFloat(m[1]!);
        return Number.isFinite(n) ? n : null;
    };
    return { onoiseTotalV: num(ONOISE_TOTAL_RE), inoiseTotalV: num(INOISE_TOTAL_RE) };
}

/**
 * Parse a noise run: the spectrum CSV (cols [freq, onoise, freq, inoise]) into two DataSeries vs frequency, plus
 * the integrated totals from the listing. Returns whatever it can; series is [] when the CSV is empty/garbage.
 */
export function parseNoise(csv: string, log: string): { series: DataSeries[]; totals: NoiseResult } {
    const onoise: { x: number; y: number }[] = [];
    const inoise: { x: number; y: number }[] = [];

    for (const raw of (csv || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const cols = line.split(/\s+/).map(Number);
        // [freq, onoise, freq(dup), inoise]; require the 4-column pair layout and finite numbers.
        if (cols.length < 4 || !cols.slice(0, 4).every(Number.isFinite)) continue;
        onoise.push({ x: cols[0]!, y: cols[1]! });
        inoise.push({ x: cols[2]!, y: cols[3]! });
    }

    const series: DataSeries[] = [];
    if (onoise.length) series.push({ name: 'onoise_spectrum', unit: 'V/sqrt(Hz)', points: onoise });
    if (inoise.length) series.push({ name: 'inoise_spectrum', unit: 'V/sqrt(Hz)', points: inoise });

    return { series, totals: parseNoiseTotals(log) };
}
