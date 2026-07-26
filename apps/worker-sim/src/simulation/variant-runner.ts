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
    assessTransientCompleteness,
    parseSpiceValue,
    type CircuitJson,
    type AnalysisConfig,
    type SimMeasurement,
} from '@circuit-forge/eda-core';

import { config } from '../config';

import { executeNgspice } from './runner';

/**
 * Build the per-variant runner bound to a prepared job dir + the (fixed) analysis. Returns a function matching
 * eda-core's `VariantRunner` contract: `(variant) => measurements | null`. The caller (MC/sweep/corner batch)
 * creates `jobDir`, writes any shared model files once, and disposes the dir afterward.
 *
 * `extraProbes` are the criterion-derived probes (branch currents like `i(R1)`) that must be UNIONed into every
 * variant's netlist — WITHOUT them the generator's default voltage-only sweep never saves a branch current, so a
 * current criterion reads "probe not found" and EVERY variant fails, collapsing yield/passAllCorners to ~0. This
 * mirrors the nominal verify path (verification.service passes the SAME derived probes) so a design that verifies
 * at nominal is measured against the identical criteria under Monte-Carlo / corner / sweep.
 */
/** The shared per-run core: execute an ALREADY-generated netlist in the prepared job dir and parse → scalar
 *  measurements. A `null` netlist (a variant that wouldn't generate/sanitize) OR any spawn/timeout/no-output/
 *  oversize/transient-truncation returns null = ERRORED (excluded from the denominator by the pure orchestrators).
 *  Reused by BOTH makeVariantRunner (MC/sweep/corner — component variants) and makeTempRunner (temperature corners). */
async function executeAndMeasure(
    paths: { netlistPath: string; outputPath: string; logPath: string },
    analysis: AnalysisConfig,
    netlist: string | null,
): Promise<SimMeasurement[] | null> {
    if (netlist === null) return null;
    // STALE-CSV SAFETY: clear the prior run's artifacts so a no-output run can't read them.
    await fs.rm(paths.outputPath, { force: true }).catch(() => undefined);
    await fs.rm(paths.logPath, { force: true }).catch(() => undefined);
    await fs.writeFile(paths.netlistPath, netlist);

    const { exitCode, timedOut, spawnError } = await executeNgspice(paths.netlistPath);
    if (spawnError || timedOut || exitCode !== 0) return null; // couldn't evaluate this run → errored

    let csv: string;
    try {
        csv = await fs.readFile(paths.outputPath, 'utf-8');
    } catch {
        return null; // ngspice exited 0 but emitted no data (degenerate / non-converging) → errored
    }
    if (Buffer.byteLength(csv) > config.SIM_MAX_OUTPUT_BYTES) return null;

    const probes = extractProbes(netlist);
    const result = parseSimulationOutput(csv, probes, analysis.type);
    // COMPLETENESS GUARD: a run whose transient SILENTLY TRUNCATED (adaptive timestep collapse — a marginal
    // perturbation can tip a run into non-convergence even when nominal ran fully) would otherwise be measured
    // over a CLIPPED waveform → a wrong per-run pass/fail. Treat it like any other unrunnable run: null = ERRORED.
    if (analysis.type === 'tran') {
        const stop = parseSpiceValue(analysis.stopTime);
        if (assessTransientCompleteness(result.series, stop.isValid ? stop.value : 0).endedEarly) return null;
    }
    // OOM-GUARD: collapse to scalar measurements now; `result.series` is dropped when this returns.
    const measurements = result.series.map((s) => summarizeSeries(s, analysis.type));
    await foldListingMetrics(measurements, analysis, paths.logPath);
    return measurements;
}

/** ROBUST scalar metrics (THD from fourier, gain from tf) live in the LISTING, not the CSV — fold them onto the
 *  measurements so a thd/gain criterion is evaluated PER RUN. Read the listing once, only when either is requested. */
async function foldListingMetrics(measurements: SimMeasurement[], analysis: AnalysisConfig, logPath: string): Promise<void> {
    const needsListing = (analysis.type === 'tran' && analysis.fourier) || (analysis.type === 'op' && analysis.tf);
    if (!needsListing) return;
    const listing = await fs.readFile(logPath, 'utf-8').catch(() => '');
    if (analysis.type === 'tran') attachFourierThd(measurements, parseFourierLog(listing));
    // Fallback to the requested tf output so a valid gain still binds if ngspice's `output_impedance_at_<node>`
    // echo is missing/truncated (else outputNode='' matches no node).
    if (analysis.type === 'op') attachTransferFunction(measurements, parseTransferFunction(listing, analysis.tf?.output));
}

const jobPaths = (jobDir: string) => ({
    netlistPath: path.join(jobDir, 'circuit.cir'),
    outputPath: path.join(jobDir, 'output.csv'),
    logPath: path.join(jobDir, 'stdout.log'),
});

export function makeVariantRunner(
    jobDir: string,
    analysis: AnalysisConfig,
    extraProbes?: string[],
): (variant: CircuitJson) => Promise<SimMeasurement[] | null> {
    const paths = jobPaths(jobDir);
    return async (variant: CircuitJson): Promise<SimMeasurement[] | null> => {
        let netlist: string | null;
        try {
            netlist = sanitizeNetlist(generateNetlist(variant, analysis, extraProbes?.length ? { extraProbes } : {}), jobDir);
        } catch {
            netlist = null; // a variant that won't even generate/sanitize — count errored, never crash the batch
        }
        return executeAndMeasure(paths, analysis, netlist);
    };
}

/**
 * Temperature-corner runner: the CIRCUIT is fixed; the ambient temperature varies per call, emitted as a
 * `.temp <T>` card via generateNetlist's `temperatureC`. Matches eda-core's `TempRunner` contract
 * `(temperatureC) => measurements | null`. Shares the identical execution/parse core with the variant runner.
 */
export function makeTempRunner(
    jobDir: string,
    circuit: CircuitJson,
    analysis: AnalysisConfig,
    extraProbes?: string[],
): (temperatureC: number) => Promise<SimMeasurement[] | null> {
    const paths = jobPaths(jobDir);
    return async (temperatureC: number): Promise<SimMeasurement[] | null> => {
        let netlist: string | null;
        try {
            netlist = sanitizeNetlist(generateNetlist(circuit, analysis, { ...(extraProbes?.length ? { extraProbes } : {}), temperatureC }), jobDir);
        } catch {
            netlist = null;
        }
        return executeAndMeasure(paths, analysis, netlist);
    };
}
