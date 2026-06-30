/**
 * Parse ngspice `.four` (Fourier) blocks from the run's listing (the `-o` log / stdout).
 *
 * A `.four <freq> <probe>` card makes ngspice decompose a node's transient waveform into harmonics and print
 * a block to the listing — NOT to the `wrdata` CSV — so this is parsed from the log text, separately from the
 * series. The block looks like:
 *
 *   Fourier analysis for v(out):
 *     No. Harmonics: 10, THD: 42.9161 %, Gridsize: 200, Interpolation Degree: 1
 *
 *   Harmonic Frequency   Magnitude   Phase       Norm. Mag   Norm. Phase
 *   -------- ---------   ---------   -----       ---------   -----------
 *    0       0           2.58e-15    0           0           0
 *    1       1000        0.846631    -32.144     1           0
 *    ...
 *
 * Pure + defensive: a malformed/absent block yields []. THD is kept as the PERCENT ngspice reports.
 */
import type { FourierResult, FourierHarmonic } from '../types/simulation';

const HEADER_RE = /Fourier analysis for\s+(.+?):/i;
const THD_RE = /THD:\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*%/i;
/** A harmonic DATA row = 6 whitespace-separated numeric columns: order freq mag phase normMag normPhase. */
const NUM = '[-+]?\\d*\\.?\\d+(?:[eE][-+]?\\d+)?';
const ROW_RE = new RegExp(`^\\s*(\\d+)\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s*$`);

/**
 * Extract every `.four` block from an ngspice listing. Returns one FourierResult per analyzed probe, in
 * the order they appear. Never throws; returns [] when no Fourier block is present.
 */
export function parseFourierLog(log: string): FourierResult[] {
    if (!log || !log.includes('Fourier analysis for')) return [];
    const lines = log.split(/\r?\n/);
    const results: FourierResult[] = [];

    for (let i = 0; i < lines.length; i++) {
        const header = lines[i]!.match(HEADER_RE);
        if (!header) continue;

        const probe = header[1]!.trim();
        // THD is on the header line or the next couple of lines ("No. Harmonics: N, THD: x %, ...").
        let thd = NaN;
        for (let j = i; j < Math.min(i + 3, lines.length); j++) {
            const m = lines[j]!.match(THD_RE);
            if (m) {
                thd = parseFloat(m[1]!);
                break;
            }
        }

        // Collect contiguous harmonic data rows that follow (skipping the header/divider/blank lines). Stop at
        // the next "Fourier analysis for" or after a run of rows once any were seen and a non-row line appears.
        const harmonics: FourierHarmonic[] = [];
        let seenRow = false;
        for (let k = i + 1; k < lines.length; k++) {
            if (HEADER_RE.test(lines[k]!)) break; // next block
            const row = lines[k]!.match(ROW_RE);
            if (row) {
                seenRow = true;
                harmonics.push({
                    order: parseInt(row[1]!, 10),
                    frequency: parseFloat(row[2]!),
                    magnitude: parseFloat(row[3]!),
                    phase: parseFloat(row[4]!),
                    normMag: parseFloat(row[5]!),
                    normPhase: parseFloat(row[6]!),
                });
            } else if (seenRow && lines[k]!.trim().length > 0) {
                break; // the table ended (a non-row, non-blank line after rows began)
            }
        }

        const fundamental = harmonics.find((h) => h.order === 1)?.frequency ?? NaN;
        results.push({
            probe,
            fundamentalFreq: fundamental,
            thd: Number.isFinite(thd) ? thd : NaN,
            harmonics,
        });
        i++; // past this header; the inner scan already consumed the rows
    }

    return results;
}
