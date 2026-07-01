/**
 * Shared per-variant ngspice runner — the worker-side `VariantRunner` used by BOTH the Monte-Carlo yield batch
 * (montecarlo-runner.ts) and the parametric sweep batch (sweep-runner.ts). Both feed a stream of CircuitJson
 * VARIANTS (random draws for MC, deterministic parameter steps for sweep) through the IDENTICAL execution:
 *   - reuse ONE job dir across all variants;
 *   - STALE-CSV SAFETY: delete output.csv/stdout.log before EVERY spawn, so a variant that produces no file
 *     can't silently read the previous variant's result;
 *   - OOM-GUARD: reduce each variant to per-node scalar measurements immediately and drop the raw series
 *     (never accumulate hundreds of full SimulationResults);
 *   - fold listing-derived THD (fourier) / small-signal gain (tf) onto the measurements so a thd/gain criterion
 *     is evaluated PER VARIANT, not just at nominal;
 *   - a variant that won't generate/sanitize, won't spawn, times out, exits non-zero, or emits no/oversize data
 *     returns `null` = ERRORED (excluded from the denominator by the pure orchestrators), never a spec failure.
 * Reuses the IDENTICAL sandboxed executeNgspice as a normal sim.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from '../config';
import {
    generateNetlist,
    sanitizeNetlist,
    extractProbes,
    parseSimulationOutput,
    parseFourierLog,
    attachFourierThd,
    parseTransferFunction,
    attachTransferFunction,
    summarizeSeries,
    type CircuitJson,
    type AnalysisConfig,
    type SimMeasurement,
} from '@circuit-forge/eda-core';
import { executeNgspice } from './runner';

/**
 * Build the per-variant runner bound to a prepared job dir + the (fixed) analysis. Returns a function matching
 * eda-core's `VariantRunner` contract: `(variant) => measurements | null`. The caller (MC/sweep batch) creates
 * `jobDir`, writes any shared model files once, and disposes the dir afterward.
 */
export function makeVariantRunner(jobDir: string, analysis: AnalysisConfig): (variant: CircuitJson) => Promise<SimMeasurement[] | null> {
    const netlistPath = path.join(jobDir, 'circuit.cir');
    const outputPath = path.join(jobDir, 'output.csv');
    const logPath = path.join(jobDir, 'stdout.log');

    return async (variant: CircuitJson): Promise<SimMeasurement[] | null> => {
        let netlist: string;
        try {
            netlist = sanitizeNetlist(generateNetlist(variant, analysis), jobDir);
        } catch {
            return null; // a variant that won't even generate/sanitize — count errored, never crash the batch
        }
        // STALE-CSV SAFETY: clear the prior variant's artifacts so a no-output run can't read them.
        await fs.rm(outputPath, { force: true }).catch(() => undefined);
        await fs.rm(logPath, { force: true }).catch(() => undefined);
        await fs.writeFile(netlistPath, netlist);

        const { exitCode, timedOut, spawnError } = await executeNgspice(netlistPath);
        if (spawnError || timedOut || exitCode !== 0) return null; // couldn't evaluate this variant → errored

        let csv: string;
        try {
            csv = await fs.readFile(outputPath, 'utf-8');
        } catch {
            return null; // ngspice exited 0 but emitted no data (degenerate / non-converging) → errored
        }
        if (Buffer.byteLength(csv) > config.SIM_MAX_OUTPUT_BYTES) return null;

        const probes = extractProbes(netlist);
        const result = parseSimulationOutput(csv, probes, analysis.type);
        // OOM-GUARD: collapse to scalar measurements now; `result.series` is dropped when this returns.
        const measurements = result.series.map((s) => summarizeSeries(s, analysis.type));
        // ROBUST scalar metrics (THD from fourier, gain from tf) live in the LISTING, not the CSV — fold them
        // onto each variant's measurements so a thd/gain criterion is evaluated PER VARIANT. Read the listing
        // once when either is requested.
        const needsListing = (analysis.type === 'tran' && analysis.fourier) || (analysis.type === 'op' && analysis.tf);
        if (needsListing) {
            const listing = await fs.readFile(logPath, 'utf-8').catch(() => '');
            if (analysis.type === 'tran') attachFourierThd(measurements, parseFourierLog(listing));
            // Fallback to the requested tf output so a valid gain still binds if ngspice's
            // `output_impedance_at_<node>` echo is missing/truncated (else outputNode='' matches no node).
            if (analysis.type === 'op') attachTransferFunction(measurements, parseTransferFunction(listing, analysis.tf?.output));
        }
        return measurements;
    };
}
