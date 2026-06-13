/**
 * Verified Designs — deterministic evidence packs.
 *
 * Turns a circuit + (optional) spec assertions into a structured, defensible report: run ERC, run real
 * ngspice (on the WORKER in prod — see runSimulation; the API image ships no ngspice), measure the
 * result, check each requested spec against the MEASURED value, and return a pass/fail verdict with the
 * evidence attached. No LLM in this path — a "verified design" is backed by deterministic simulation,
 * not a model's say-so. Both the productized closed-loop output and the "AI design review with
 * receipts" surface (review an existing circuit, generation optional). Stays a SYNCHRONOUS request via
 * server-side job polling.
 */
import { Injectable, Optional, Logger } from '@nestjs/common';
import { sanitizeNodeName, runErc, generateNetlist, type AnalysisConfig, type SimulationResult } from '@circuit-forge/eda-core';
import { safeValidateCircuitJson, type CircuitJson } from '@circuit-forge/eda-core';
import { CircuitSimulatorService, summarizeSeries, type SimMeasurement, type SimSummary, type ConvergenceReport } from './circuit-simulator.service';
import { attachGenericModels } from './model-resolution';
import { computeResistorPower, type PowerReport } from './power-analysis';
import { SimulationService } from '../simulation/simulation.service';
import type { AssertionDto } from './dto';

/** How long the API server-side-polls the worker job before giving up (mirrors the AI design loop). */
const VERIFY_POLL_TIMEOUT_MS = 90_000;

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
    /** Set when the run hit a convergence failure — the Convergence Doctor's diagnosis + what fixed it
     *  (or what was tried). Lets the UI surface "needed solver help: <remedy>" on an otherwise-pass. */
    convergence?: ConvergenceReport;
    /** Per-resistor steady-state power dissipation + over-rating flags (informational — does NOT change
     *  the verdict, since the default rating is a guess). Present only when the run produced data. */
    power?: PowerReport;
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
    private readonly logger = new Logger(VerificationService.name);

    constructor(
        private readonly simulator: CircuitSimulatorService,
        // Optional so the service can be constructed without the queue in unit/live specs (→ inline).
        @Optional() private readonly simulation?: SimulationService,
    ) {}

    async verify(
        circuit: unknown,
        analysisConfig?: AnalysisConfig,
        assertions: AssertionDto[] = [],
        userId?: string,
    ): Promise<DesignEvidence> {
        const sim = await this.runSimulation(circuit, analysisConfig, userId);
        const assertionResults = this.evaluate(sim.measurements, assertions, sim.simStatus === 'ok');

        // Power-dissipation review (resistors): only meaningful once we have real node voltages.
        let power: PowerReport | undefined;
        if (sim.simStatus === 'ok' && sim.measurements.length > 0) {
            const valid = safeValidateCircuitJson(circuit);
            if (valid.success) power = computeResistorPower(valid.data as CircuitJson, sim.measurements, sim.analysisType);
        }

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
            ...(sim.convergence ? { convergence: sim.convergence } : {}),
            ...(power ? { power } : {}),
        };
    }

    /**
     * Produce the SimSummary verify() builds evidence on. PROD path delegates ngspice to the WORKER
     * (the API image ships no ngspice; the worker has it + the rlimit sandbox) — keeping untrusted
     * execution in one isolated tier. Falls back to the INLINE simulator only when there's no userId/
     * queue (local dev + the live specs), where the Convergence Doctor's remedy ladder still applies.
     * (Slice 1: the worker path is single-pass; moving the ladder worker-side is the next slice.)
     */
    private async runSimulation(circuit: unknown, analysis: AnalysisConfig | undefined, userId?: string): Promise<SimSummary> {
        if (userId && this.simulation) return this.runViaWorker(circuit, analysis, userId);
        return this.simulator.simulateWithRemedies(circuit, analysis);
    }

    /**
     * Worker-backed run: ERC + netlist are pure (done here), ngspice runs on the worker queue, and the
     * API server-side-polls for the result (same pattern as the AI design loop) so verify-design stays
     * a SYNCHRONOUS request. Returns the SimSummary; never throws (failures become a 'failed' summary).
     */
    private async runViaWorker(circuit: unknown, analysis: AnalysisConfig | undefined, userId: string): Promise<SimSummary> {
        const an: AnalysisConfig = analysis ?? { type: 'op' };
        const empty = { measurements: [], nodeCount: 0, analysisType: an.type };

        const validated = safeValidateCircuitJson(circuit);
        if (!validated.success) {
            const issues = validated.error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ');
            return { simStatus: 'failed', ercErrors: [], ercWarnings: [], runError: `invalid circuit: ${issues}`, ...empty };
        }
        const c = validated.data as CircuitJson;
        attachGenericModels(c);

        // ERC always runs (pure, API-side) — the worker only does the ngspice execution.
        const erc = runErc(c);
        const ercErrors = erc.issues.filter((i) => i.severity === 'error').map((i) => ({ code: i.code, message: i.message, relatedIds: i.relatedIds }));
        const ercWarnings = erc.issues.filter((i) => i.severity === 'warning').map((i) => ({ code: i.code, message: i.message, relatedIds: i.relatedIds }));

        let netlist: string;
        try {
            netlist = generateNetlist(c, an);
        } catch (e) {
            return { simStatus: 'failed', ercErrors, ercWarnings, runError: `netlist generation failed: ${e instanceof Error ? e.message : String(e)}`, ...empty };
        }

        try {
            const { jobId } = await this.simulation!.createQuickSim(netlist, an as unknown as Record<string, unknown>, userId);
            const status = await this.pollJob(jobId, userId);
            if (status !== 'SUCCEEDED') {
                return { simStatus: 'failed', ercErrors, ercWarnings, runError: `simulation ${status.toLowerCase()}`, ...empty };
            }
            const res = (await this.simulation!.getResult(jobId, userId)) as { result?: SimulationResult | null };
            const series = res.result?.series;
            if (!series || series.length === 0) {
                return { simStatus: 'failed', ercErrors, ercWarnings, runError: 'simulation produced no result data', ...empty };
            }
            return { simStatus: 'ok', ercErrors, ercWarnings, measurements: series.map(summarizeSeries), nodeCount: series.length, analysisType: an.type };
        } catch (e) {
            this.logger.error(`verify-design worker run failed: ${e instanceof Error ? e.message : e}`);
            return { simStatus: 'failed', ercErrors, ercWarnings, runError: 'simulation could not be queued (worker/queue unavailable)', ...empty };
        }
    }

    /** Server-side poll a worker job to a terminal state (mirrors design.service.pollJob). */
    private async pollJob(jobId: string, userId: string): Promise<string> {
        const start = Date.now();
        while (Date.now() - start < VERIFY_POLL_TIMEOUT_MS) {
            const s = (await this.simulation!.getStatus(jobId, userId)) as { status: string };
            if (s.status === 'SUCCEEDED' || s.status === 'FAILED' || s.status === 'TIMED_OUT' || s.status === 'CANCELED') return s.status;
            await new Promise((r) => setTimeout(r, 1000));
        }
        return 'TIMED_OUT';
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
