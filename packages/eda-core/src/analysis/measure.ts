/**
 * Parse ngspice `.meas`/`meas` results from the run's listing (the `-o` log / stdout).
 *
 * `.meas` rides on an existing analysis (tran/ac/dc) and prints one line per measurement to the listing — NOT
 * to the wrdata CSV — e.g.:
 *
 *     Measurements for Transient Analysis
 *
 *   vmax                =  2.544619e-01 at=  4.586477e-04
 *   vrms                =   4.19104e+00 from=  0.00000e+00 to=  5.00000e-03
 *   tcross              =   1.17558e-03
 *
 * A FAILED measure (e.g. a WHEN value never reached) does NOT abort the run (exit stays 0) and does NOT stop
 * the other measures; it emits, to the log:
 *
 *   Error: measure  tcross  when(WHEN) : out of interval
 *    .meas tran tcross when v(out)=99 rise=1 failed!
 *
 * So a failed measure is surfaced as { failed:true, value:null }, never as a sim error.
 *
 * Pure + defensive: scoped to the `names` the caller requested (so unrelated `x = y` lines in the listing —
 * sensitivity tables, etc. — are never mistaken for measurements). Returns [] when nothing matches.
 */
import type { MeasurementResult } from '../types/simulation';

const NUM = '[-+]?\\d*\\.?\\d+(?:[eE][-+]?\\d+)?';
/** `<name> = <value> [k= v k= v ...]` — the primary scalar plus optional at=/from=/to=/targ=/trig= qualifiers. */
const LINE_RE = new RegExp(`^\\s*(\\w+)\\s*=\\s*(${NUM})\\s*(.*)$`);
const QUAL_RE = new RegExp(`(\\w+)\\s*=\\s*(${NUM})`, 'g');
/** `.meas tran <name> ... failed!` — the name is the 3rd token (after `.meas` and the analysis-type token). */
const FAILED_RE = /^\s*\.meas\s+\w+\s+(\w+)\b.*\bfailed!/i;
/** `Error: measure  <name>  ...` */
const ERR_RE = /^Error:\s*measure\s+(\w+)/i;

/**
 * Extract `.meas` results from an ngspice listing, scoped to the requested measurement `names`.
 * Each name resolves to exactly one MeasurementResult: a value, or failed:true when ngspice reported it failed.
 */
export function parseMeasurements(log: string, names: string[]): MeasurementResult[] {
    if (!log || names.length === 0) return [];
    const want = new Set(names);
    const byName = new Map<string, MeasurementResult>();

    for (const raw of log.split(/\r?\n/)) {
        // Failure lines first — a name can have BOTH an Error line and a "failed!" line; either marks it failed.
        const failed = raw.match(FAILED_RE) || raw.match(ERR_RE);
        if (failed && want.has(failed[1]!)) {
            byName.set(failed[1]!, { name: failed[1]!, value: null, failed: true, failureReason: raw.trim() });
            continue;
        }
        const m = raw.match(LINE_RE);
        if (!m) continue;
        const name = m[1]!;
        if (!want.has(name)) continue; // only accept requested measure names — ignore other `x = y` log lines
        if (byName.get(name)?.failed) continue; // a prior failure wins over a stray value line
        const value = parseFloat(m[2]!);
        const qualifiers: Record<string, number> = {};
        let q: RegExpExecArray | null;
        QUAL_RE.lastIndex = 0;
        while ((q = QUAL_RE.exec(m[3]!)) !== null) {
            qualifiers[q[1]!] = parseFloat(q[2]!);
        }
        byName.set(name, {
            name,
            value: Number.isFinite(value) ? value : null,
            ...(Object.keys(qualifiers).length ? { qualifiers } : {}),
        });
    }

    // Preserve the requested order; drop names that produced neither a value nor a failure line.
    return names.map((n) => byName.get(n)).filter((r): r is MeasurementResult => r !== undefined);
}
