/**
 * Verified Designs — deterministic evidence packs.
 *
 * Turns a circuit + (optional) spec assertions into a structured, defensible report: run ERC + real
 * ngspice (inline, via CircuitSimulatorService), measure the result, check each requested spec against
 * the MEASURED value, and return a pass/fail verdict with the evidence attached. No LLM in this path —
 * the whole point is that a "verified design" is backed by deterministic simulation, not a model's
 * say-so. This is both the productized closed-loop output and the "AI design review with receipts"
 * surface (review an existing circuit, generation optional).
 */
import { Injectable } from '@nestjs/common';
import { sanitizeNodeName, type AnalysisConfig } from '@circuit-forge/eda-core';
import { CircuitSimulatorService, type SimMeasurement, type SimSummary } from './circuit-simulator.service';
import type { AssertionDto } from './dto';

export interface AssertionResult {
    label: string;
    probe: string;
    metric: AssertionDto['metric'];
    op: AssertionDto['op'];
    target: number;
    tol?: number;
    actual: number | null; // null = the probe wasn't found in the simulation output
    pass: boolean;
    detail: string;
}

export interface DesignEvidence {
    /** pass = sim ok, no ERC errors, all assertions pass. fail = any of those failed. inconclusive =
     *  simulation couldn't run (ngspice not configured / capacity) so specs couldn't be checked. */
    verdict: 'pass' | 'fail' | 'inconclusive';
    summary: string;
    simStatus: SimSummary['simStatus'];
    analysisType?: string;
    runError?: string;
    erc: { errors: SimSummary['ercErrors']; warnings: SimSummary['ercWarnings'] };
    measurements: SimMeasurement[];
    assertions: AssertionResult[];
    /** Counts for a quick UI badge. */
    checks: { total: number; passed: number; failed: number };
}

/**
 * Map a user-facing probe to the SPICE node the simulator actually reports. The user thinks in NET
 * names ("out"); the netlist generator runs each net id through sanitizeNodeName (which prefixes a
 * plain name with "n", e.g. "vin" → "nvin", and escapes a reserved word, e.g. "out" → "x_out"). We
 * apply the SAME transform to both the assertion probe and the measured node, after stripping a
 * v() wrapper, so "out" / "v(out)" / "V(OUT)" all resolve to the one node the measurement carries.
 * Lowercased because ngspice emits node names in lower case. (Current probes are rejected upstream —
 * the default simulation measures node voltages only.)
 */
function nodeKey(probe: string): string {
    const m = probe.trim().match(/^v\(([^)]+)\)$/i);
    const bare = m ? m[1]! : probe.trim();
    return sanitizeNodeName(bare).toLowerCase();
}

/** A current/power probe the voltage-only default simulation can't measure (i(R1), @r1[i]). */
export function isCurrentProbe(probe: string): boolean {
    return /^\s*i\s*\(/i.test(probe) || /\[\s*i\s*\]\s*$/i.test(probe);
}

@Injectable()
export class VerificationService {
    constructor(private readonly simulator: CircuitSimulatorService) {}

    async verify(
        circuit: unknown,
        analysisConfig?: AnalysisConfig,
        assertions: AssertionDto[] = [],
    ): Promise<DesignEvidence> {
        const sim = await this.simulator.simulate(circuit, analysisConfig);
        const assertionResults = this.evaluate(sim.measurements, assertions, sim.simStatus === 'ok');

        const ercErrorCount = sim.ercErrors.length;
        const failedAssertions = assertionResults.filter((a) => !a.pass).length;
        // "ok" but zero measurements means ngspice exited cleanly yet produced no usable data — we
        // can't certify a design we couldn't actually measure (treat like a skipped run).
        const noData = sim.simStatus === 'ok' && sim.measurements.length === 0;

        let verdict: DesignEvidence['verdict'];
        if (ercErrorCount > 0 || sim.simStatus === 'failed') {
            verdict = 'fail';
        } else if (sim.simStatus === 'skipped' || noData) {
            verdict = 'inconclusive';
        } else if (failedAssertions > 0) {
            verdict = 'fail';
        } else {
            verdict = 'pass';
        }

        return {
            verdict,
            summary: this.summarize(verdict, sim, assertionResults),
            simStatus: sim.simStatus,
            analysisType: sim.analysisType,
            runError: sim.runError,
            erc: { errors: sim.ercErrors, warnings: sim.ercWarnings },
            measurements: sim.measurements,
            assertions: assertionResults,
            checks: {
                total: assertionResults.length,
                passed: assertionResults.filter((a) => a.pass).length,
                failed: failedAssertions,
            },
        };
    }

    /** Evaluate each assertion against the measurements. When the sim didn't run (simOk=false) every
     *  assertion is unmet (actual=null) — you can't certify a spec you couldn't measure. */
    private evaluate(measurements: SimMeasurement[], assertions: AssertionDto[], simOk: boolean): AssertionResult[] {
        const byKey = new Map(measurements.map((m) => [nodeKey(m.node), m]));
        return assertions.map((a) => {
            const label = a.label ?? `${a.probe} ${a.metric} ${a.op} ${a.value}`;
            const base = { label, probe: a.probe, metric: a.metric, op: a.op, target: a.value, tol: a.tol };
            const m = simOk ? byKey.get(nodeKey(a.probe)) : undefined;
            if (!m) {
                return {
                    ...base,
                    actual: null,
                    pass: false,
                    detail: simOk ? `probe "${a.probe}" not found in simulation output` : 'simulation did not produce results',
                };
            }
            const actual = m[a.metric];
            const pass = this.compare(actual, a.op, a.value, a.tol);
            return { ...base, actual, pass, detail: `${a.metric}(${a.probe}) = ${actual} ${pass ? '✓' : '✗'} ${a.op} ${a.value}` };
        });
    }

    private compare(actual: number, op: AssertionDto['op'], target: number, tol?: number): boolean {
        switch (op) {
            case 'lt':
                return actual < target;
            case 'lte':
                return actual <= target;
            case 'gt':
                return actual > target;
            case 'gte':
                return actual >= target;
            case 'approx': {
                // Default tolerance: 5% of |target|, or an absolute 1e-9 floor so target=0 still works.
                const t = tol ?? Math.max(Math.abs(target) * 0.05, 1e-9);
                return Math.abs(actual - target) <= t;
            }
        }
    }

    private summarize(verdict: DesignEvidence['verdict'], sim: SimSummary, results: AssertionResult[]): string {
        if (verdict === 'inconclusive') {
            return sim.simStatus === 'skipped'
                ? 'Simulation is not configured on the server, so the design could not be verified.'
                : 'The simulation produced no measurable data, so the design could not be verified.';
        }
        const parts: string[] = [];
        if (sim.simStatus === 'failed') parts.push(`simulation failed (${sim.runError ?? 'unknown error'})`);
        if (sim.ercErrors.length) parts.push(`${sim.ercErrors.length} ERC error(s)`);
        const failed = results.filter((r) => !r.pass);
        if (failed.length) parts.push(`${failed.length}/${results.length} spec(s) not met`);
        if (verdict === 'pass') {
            const passNote = results.length ? `all ${results.length} spec(s) met` : 'no specs asserted';
            const warnNote = sim.ercWarnings.length ? ` (${sim.ercWarnings.length} ERC warning(s) to review)` : '';
            return `Verified: simulation succeeded, no ERC errors, ${passNote}.${warnNote}`;
        }
        return `Not verified: ${parts.join('; ')}.`;
    }
}
