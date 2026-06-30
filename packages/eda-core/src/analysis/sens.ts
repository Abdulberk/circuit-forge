/**
 * Parse ngspice `.sens` (DC sensitivity) results from the run's listing (the `-o` log).
 *
 * A `.sens <output>` card + `print all` prints a flat table of d(output)/d(parameter) as `name = value` lines:
 *
 *   No. of Data Rows : 1
 *   r1 = -1.11111e-03
 *   r2 = 5.555550e-04
 *   v1 = 6.666667e-01
 *   r1_scale = -1.11111e+00
 *   ... (many per-instance-parameter rows, almost all 0.0 for ideal parts)
 *
 * The meaningful sensitivities are the NON-ZERO entries (bare element/source names + the occasional non-zero
 * parameter row). Pure + defensive: the `name = value` shape is specific to sens (the op-point node table is
 * space-separated, not `=`, so it is never matched). Returns { entries: [] } when nothing matches.
 */
import type { SensitivityResult } from '../types/simulation';

const NUM = '[-+]?\\d*\\.?\\d+(?:[eE][-+]?\\d+)?';
// `<name> = <single real value>` at end of line. Name is a SPICE identifier with optional `_param`/`:param`.
// (A leading letter + the `=` + a bare real excludes log prose like "Total analysis time (seconds) = 0" — which
// has spaces in the name — and pz's complex `all = re,im` — which has a trailing `,imag`.)
const LINE_RE = new RegExp(`^\\s*([A-Za-z][\\w:]*)\\s*=\\s*(${NUM})\\s*$`, 'gm');
/** Safety cap so a pathological listing can't produce an unbounded table. */
const MAX_ENTRIES = 500;

/** Extract the non-zero DC sensitivities from an ngspice listing. */
export function parseSensitivity(log: string): SensitivityResult {
    const entries: { name: string; value: number }[] = [];
    if (!log) return { entries };

    let m: RegExpExecArray | null;
    LINE_RE.lastIndex = 0;
    while ((m = LINE_RE.exec(log)) !== null) {
        const value = parseFloat(m[2]!);
        if (!Number.isFinite(value) || value === 0) continue; // drop the ~0 per-parameter noise rows
        entries.push({ name: m[1]!, value });
        if (entries.length >= MAX_ENTRIES) break;
    }
    return { entries };
}
