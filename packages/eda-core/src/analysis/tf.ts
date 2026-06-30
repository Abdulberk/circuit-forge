/**
 * Parse ngspice `.tf` (DC small-signal transfer function) results from the run's listing (the `-o` log).
 *
 * Driven by the `tf <output> <input_source>` CONTROL COMMAND + an explicit `print` of its three result vectors
 * (the auto-echo is unreliable after a `run`, so the generator always adds the print). The print emits, to the
 * listing — NOT the wrdata CSV:
 *
 *   transfer_function = 6.666667e-01
 *   output_impedance_at_v(out) = 6.666667e+02
 *   v1#input_impedance = 3.000000e+03
 *
 * i.e. the small-signal gain Vout/Vin (dimensionless), the output impedance at the probed node (ohms), and the
 * input impedance seen by the source (ohms). The vector names embed the probe (`_at_<probe>`) and the lowercased
 * source name (`<src>#input_impedance`). Pure + defensive: returns undefined when no transfer_function line is
 * present.
 */
import type { TransferFunctionResult } from '../types/simulation';

const NUM = '[-+]?\\d*\\.?\\d+(?:[eE][-+]?\\d+)?';
const GAIN_RE = new RegExp(`^\\s*transfer_function\\s*=\\s*(${NUM})`, 'im');
const ZOUT_RE = new RegExp(`^\\s*output_impedance_at_(\\S+)\\s*=\\s*(${NUM})`, 'im');
const ZIN_RE = new RegExp(`^\\s*(\\S+)#input_impedance\\s*=\\s*(${NUM})`, 'im');

/** Extract the `.tf` result from an ngspice listing, or undefined when absent. */
export function parseTransferFunction(log: string): TransferFunctionResult | undefined {
    if (!log) return undefined;
    const g = log.match(GAIN_RE);
    if (!g) return undefined; // no transfer_function line → nothing to report

    const out = log.match(ZOUT_RE);
    const inp = log.match(ZIN_RE);
    const num = (s: string | undefined): number | null => {
        if (s === undefined) return null;
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : null;
    };

    return {
        gain: num(g[1]) ?? NaN,
        outputNode: out?.[1] ?? '',
        outputImpedanceOhms: num(out?.[2]),
        inputSource: inp?.[1] ?? '',
        inputImpedanceOhms: num(inp?.[2]),
    };
}
