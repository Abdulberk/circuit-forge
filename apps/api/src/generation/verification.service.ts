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
import { runErc, generateNetlist, type AnalysisConfig, type SimulationResult } from '@circuit-forge/eda-core';
import { safeValidateCircuitJson, type CircuitJson } from '@circuit-forge/eda-core';
import { CircuitSimulatorService, summarizeSeries, type SimMeasurement, type SimSummary, type ConvergenceReport } from './circuit-simulator.service';
import { attachGenericModels } from './model-resolution';
import { computeResistorPower, type PowerReport } from './power-analysis';
import { SimulationService } from '../simulation/simulation.service';
import type { AssertionDto } from './dto';
import { evaluateAssertions, type AssertionResult } from './assertions';

// Assertion evaluation now lives in the shared, pure ./assertions module (used by the AI design loop too).
// Re-export so existing importers (controllers, specs) keep their './verification.service' path unchanged.
export { isCurrentProbe } from './assertions';
export type { AssertionResult } from './assertions';

/** How long the API server-side-polls the worker job before giving up (mirrors the AI design loop). */
const VERIFY_POLL_TIMEOUT_MS = 90_000;

export interface DesignEvidence {
    /** pass = sim ok, no ERC errors, all assertions pass. fail = an ERC error, OR ngspice actually ran
     *  and the circuit failed/couldn't simulate, OR an assertion was not met. inconclusive = the
     *  simulation couldn't RUN (ngspice not configured, OR the worker/queue was unavailable / backed up)
     *  so specs couldn't be checked — an OPERATIONAL state, never a statement about the design. */
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

@Injectable()
export class VerificationService {
    private readonly logger = new Logger(VerificationService.name);
    /** Server-side poll budget (ms) before giving up on the worker job. Env-tunable for ops; also lets
     *  tests drive the "no worker consuming the queue → inconclusive" path quickly. */
    private readonly pollTimeoutMs = Number(process.env.VERIFY_POLL_TIMEOUT_MS) || VERIFY_POLL_TIMEOUT_MS;

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
        const assertionResults = evaluateAssertions(sim.measurements, assertions, sim.simStatus === 'ok');

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
            const { status, metrics } = await this.pollJob(jobId, userId);
            // The worker tags pre/around-ngspice INFRA failures (bad NGSPICE_PATH/spawn, S3 model download,
            // DB, result upload) with metrics.failureClass='infra' — those land as job status FAILED but are
            // NOT design faults (the SimJobStatus enum has no operational value, so the discriminator rides
            // in metrics). Genuine ngspice faults carry 'sim' (or nothing on older rows).
            const infraFailure = (metrics as { failureClass?: string } | null | undefined)?.failureClass === 'infra';
            // The worker attaches a Convergence Doctor report to metrics when it walked the remedy ladder:
            // recovered:true on a rescued SUCCEEDED run, or recovered:false on a remedy-resistant FAILED run.
            // Surface it either way so the evidence can show "needed solver help: <remedy>" (or that the
            // ladder was tried and exhausted). This is the prod equivalent of the inline simulateWithRemedies.
            const convergence = (metrics as { convergence?: ConvergenceReport } | null | undefined)?.convergence;

            // ngspice ACTUALLY RAN and the circuit could not be simulated (exit≠0 / non-convergence, or it
            // exceeded the worker's own ngspice timeout) → a genuine simulation/design fault → 'fail'.
            // A worker-flagged infra failure is excluded here and handled as inconclusive below.
            if ((status === 'FAILED' || status === 'TIMED_OUT') && !infraFailure) {
                return { simStatus: 'failed', ercErrors, ercWarnings, runError: `simulation ${status.toLowerCase()}`, ...empty, ...(convergence ? { convergence } : {}) };
            }
            // NO design verdict was produced for an OPERATIONAL reason: the job never started (nothing
            // consumed the queue / backlog beyond our budget → POLL_TIMEOUT), was aborted (CANCELED), or the
            // worker hit an infrastructure error before/around ngspice (failureClass 'infra'). The evidence
            // contract FORBIDS reducing any of these to a design 'fail' (that would tell a user with a sound
            // design "verification failed"). → 'skipped' → inconclusive (try again).
            if (status !== 'SUCCEEDED') {
                const why = status === 'POLL_TIMEOUT'
                    ? `simulation did not start within ${Math.round(this.pollTimeoutMs / 1000)}s (no worker available or queue backlog)`
                    : infraFailure
                        ? 'the worker could not run the simulation (infrastructure error)'
                        : `simulation was ${status.toLowerCase()}`;
                return { simStatus: 'skipped', ercErrors, ercWarnings, runError: `${why} — try again`, ...empty };
            }

            const res = (await this.simulation!.getResult(jobId, userId)) as { result?: SimulationResult | null; error?: string };
            const series = res.result?.series;
            if (!series || series.length === 0) {
                // A SUCCEEDED job with no series: getResult sets `error` when the payload spilled to S3 and
                // couldn't be fetched — a STORAGE OUTAGE, not a design fault → inconclusive. Only a genuinely
                // empty dataset (no such error) is a degenerate no-data run → fail.
                if (res.error) {
                    return { simStatus: 'skipped', ercErrors, ercWarnings, runError: `${res.error} — try again`, ...empty };
                }
                return { simStatus: 'failed', ercErrors, ercWarnings, runError: 'simulation produced no result data', ...empty };
            }
            return { simStatus: 'ok', ercErrors, ercWarnings, measurements: series.map(summarizeSeries), nodeCount: series.length, analysisType: an.type, ...(convergence ? { convergence } : {}) };
        } catch (e) {
            // The queue/Redis/DB was unreachable (createQuickSim / getStatus / getResult threw). Same
            // contract rule as POLL_TIMEOUT above: a transient infra outage is NOT a design fault. → inconclusive.
            this.logger.error(`verify-design worker run failed: ${e instanceof Error ? e.message : e}`);
            return { simStatus: 'skipped', ercErrors, ercWarnings, runError: 'simulation could not be run (worker/queue unavailable) — try again', ...empty };
        }
    }

    /**
     * Server-side poll a worker job to a terminal state (mirrors design.service.pollJob). Returns the
     * terminal status (SUCCEEDED / FAILED / TIMED_OUT / CANCELED), or the sentinel 'POLL_TIMEOUT' when
     * the job never reached a terminal state within the budget — i.e. nothing consumed it (no worker /
     * queue backlog). That sentinel is an INFRA signal the caller maps to inconclusive, NOT a design
     * failure — and it is deliberately DISTINCT from a terminal 'TIMED_OUT' (where ngspice actually ran
     * and exceeded its own limit, which IS a sim fault).
     */
    private async pollJob(jobId: string, userId: string): Promise<{ status: string; metrics?: unknown }> {
        const start = Date.now();
        while (Date.now() - start < this.pollTimeoutMs) {
            const s = (await this.simulation!.getStatus(jobId, userId)) as { status: string; metrics?: unknown };
            if (s.status === 'SUCCEEDED' || s.status === 'FAILED' || s.status === 'TIMED_OUT' || s.status === 'CANCELED') {
                return { status: s.status, metrics: s.metrics };
            }
            await new Promise((r) => setTimeout(r, 1000));
        }
        return { status: 'POLL_TIMEOUT' };
    }

    private summarize(verdict: DesignEvidence['verdict'], sim: SimSummary, results: AssertionResult[]): string {
        if (verdict === 'inconclusive') {
            if (sim.simStatus === 'skipped') {
                // skipped = the simulation couldn't RUN (not configured in dev, OR worker/queue capacity
                // in prod). Surface the specific reason via runError; never phrase it as a design failure.
                return sim.runError
                    ? `The design could not be verified: ${sim.runError}.`
                    : 'The simulation could not run on the server, so the design could not be verified.';
            }
            return 'The simulation produced no measurable data, so the design could not be verified.';
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
