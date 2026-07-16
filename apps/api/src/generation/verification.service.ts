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
import { runErc, generateNetlist, type AnalysisConfig, type SimulationResult, type AcceptanceCriterion, type CornerSpec } from '@circuit-forge/eda-core';
import { safeValidateCircuitJson, type CircuitJson } from '@circuit-forge/eda-core';
import { CircuitSimulatorService, summarizeSeries, type SimMeasurement, type SimSummary, type ConvergenceReport } from './circuit-simulator.service';
import { attachGenericModels } from './model-resolution';
import { computeResistorPower, type PowerReport } from './power-analysis';
import { SimulationService } from '../simulation/simulation.service';
import type { AssertionDto } from './dto';
import { evaluateAssertions, attachFourierThd, attachTransferFunction, extraProbesForCriteria, type AssertionResult } from './assertions';

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
    /** Worst-case (corner) robustness — present only when the caller requested it AND the nominal verdict is
     *  'pass'. INFORMATIONAL (never changes `verdict` — same posture as `power` / Monte-Carlo robustness):
     *  reports whether the spec still holds at every ±tolerance corner, or why it couldn't be checked. */
    robustness?: WorstCaseEvidence;
}

/** The worst-case corner robustness section of a DesignEvidence (see VerificationService.runCornerRobustness). */
export interface WorstCaseEvidence {
    /** Present when the corner batch ran: the outcome across the 2^k ±tolerance corners. */
    worstCase?: {
        componentsCornered: string[];
        omitted: string[];
        evaluated: number;
        passed: number;
        failed: number;
        errored: number;
        passAllCorners: boolean;
        worstCorners: Array<Record<string, 'lo' | 'hi'>>;
    };
    /** Present instead when the check couldn't be performed (no toleranced parts / infra / didn't complete). */
    unavailable?: string;
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
        robustness?: { corner?: boolean; maxCorners?: number },
    ): Promise<DesignEvidence> {
        // Validate ONCE up front and reuse: the nets let evaluateAssertions resolve a criterion that names a
        // net ("v(out)") to the node the generator emitted from that net's ID — so the check still matches when
        // a net's id differs from its name (universal once the frontend mints UUID ids). Also feeds power below.
        const validCircuit = safeValidateCircuitJson(circuit);
        const nets = validCircuit.success ? (validCircuit.data as CircuitJson).nets : undefined;
        // Branch-current assertions (i(R1)) need their probe UNIONed into the netlist — the voltage-only
        // defaults never save it, so without this a current assertion would always read "probe not found".
        const currentProbes = extraProbesForCriteria(assertions);
        const sim = await this.runSimulation(circuit, analysisConfig, userId, currentProbes);
        const assertionResults = evaluateAssertions(sim.measurements, assertions, sim.simStatus === 'ok', nets);

        // Power-dissipation review (resistors): only meaningful once we have real node voltages.
        let power: PowerReport | undefined;
        if (sim.simStatus === 'ok' && sim.measurements.length > 0 && validCircuit.success) {
            power = computeResistorPower(validCircuit.data as CircuitJson, sim.measurements, sim.analysisType);
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
        } else if (assertionResults.length === 0) {
            // Simulated cleanly, but NOTHING was asserted → there is nothing to certify. This must read
            // 'inconclusive' ("simulated, no specs asserted"), NEVER 'pass' — a spec-less run is not "verified".
            // Mirrors the design loop's verified=false-on-empty posture; the caller disambiguates via
            // simStatus:'ok' + checks.total:0.
            verdict = 'inconclusive';
        } else if (failedAssertions > 0) {
            verdict = 'fail';
        } else {
            verdict = 'pass';
        }

        // Worst-case (corner) robustness — INFORMATIONAL, only when the caller asked for it AND the nominal
        // design already PASSES (no point cornering a design that fails at nominal) AND we have a worker+user
        // to run the batch. Never changes `verdict` (same posture as power / Monte-Carlo robustness).
        let robustnessEvidence: WorstCaseEvidence | undefined;
        if (robustness?.corner && verdict === 'pass' && this.simulation && userId) {
            robustnessEvidence = await this.runCornerRobustness(
                circuit,
                analysisConfig ?? { type: 'op' },
                assertions,
                robustness.maxCorners ? { maxComponents: robustness.maxCorners } : {},
                userId,
            );
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
            ...(robustnessEvidence ? { robustness: robustnessEvidence } : {}),
        };
    }

    /**
     * Enqueue a worst-case corner batch on the worker, poll it, and distill metrics.worstCase into the evidence's
     * robustness section. Never throws — an infra/queue failure or a circuit with no toleranced parts returns an
     * `unavailable` reason, never a design failure (this is informational, exactly like the Monte-Carlo path).
     */
    private async runCornerRobustness(
        circuit: unknown,
        analysis: AnalysisConfig,
        assertions: AssertionDto[],
        spec: CornerSpec,
        userId: string,
    ): Promise<WorstCaseEvidence> {
        try {
            const { jobId } = await this.simulation!.createCornerJob(
                circuit as CircuitJson,
                analysis as unknown as Record<string, unknown>,
                assertions as unknown as AcceptanceCriterion[],
                spec,
                userId,
            );
            const { status, metrics } = await this.pollJob(jobId, userId);
            if (status !== 'SUCCEEDED') {
                return { unavailable: `worst-case corner check did not complete (${status.toLowerCase()}) — try again` };
            }
            const wc = (metrics as { worstCase?: WorstCaseEvidence['worstCase'] } | null | undefined)?.worstCase;
            if (!wc) return { unavailable: 'worst-case corner check produced no result' };
            if (wc.evaluated === 0) return { unavailable: 'no toleranced components to corner — add a "tolerance" to R/C/L values' };
            return { worstCase: wc };
        } catch (e) {
            this.logger.error(`worst-case corner run failed: ${e instanceof Error ? e.message : e}`);
            return { unavailable: 'worst-case corner check could not be run (worker/queue unavailable) — try again' };
        }
    }

    /**
     * Produce the SimSummary verify() builds evidence on. PROD path delegates ngspice to the WORKER
     * (the API image ships no ngspice; the worker has it + the rlimit sandbox) — keeping untrusted
     * execution in one isolated tier. Falls back to the INLINE simulator only when there's no userId/
     * queue (local dev + the live specs), where the Convergence Doctor's remedy ladder still applies.
     * (Slice 1: the worker path is single-pass; moving the ladder worker-side is the next slice.)
     */
    private async runSimulation(circuit: unknown, analysis: AnalysisConfig | undefined, userId?: string, extraProbes?: string[]): Promise<SimSummary> {
        if (userId && this.simulation) return this.runViaWorker(circuit, analysis, userId, extraProbes);
        return this.simulator.simulateWithRemedies(circuit, analysis, extraProbes);
    }

    /**
     * Worker-backed run: ERC + netlist are pure (done here), ngspice runs on the worker queue, and the
     * API server-side-polls for the result (same pattern as the AI design loop) so verify-design stays
     * a SYNCHRONOUS request. Returns the SimSummary; never throws (failures become a 'failed' summary).
     */
    private async runViaWorker(circuit: unknown, analysis: AnalysisConfig | undefined, userId: string, extraProbes?: string[]): Promise<SimSummary> {
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
            netlist = generateNetlist(c, an, extraProbes?.length ? { extraProbes } : {});
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
            // Distil each series, then fold in the LISTING-derived metrics the worker computed but that don't
            // ride on a wrdata series: THD (from a `fourier` request on a tran) and small-signal gain (from a
            // `tf` request on an op). Without this the measurements carry thd/gain=undefined and a thd/gain
            // acceptance criterion can NEVER pass on the /verify-design worker path — a silent false-negative
            // verdict on a shipped, otherwise-wired feature. The AI design loop (llm-core) and the Monte-Carlo
            // batch already attach these; this closes the same seam on the synchronous verify path.
            const measurements = series.map((s) => summarizeSeries(s, an.type));
            attachFourierThd(measurements, res.result?.fourier ?? undefined);
            attachTransferFunction(measurements, res.result?.transferFunction ?? undefined);
            return { simStatus: 'ok', ercErrors, ercWarnings, measurements, nodeCount: series.length, analysisType: an.type, ...(convergence ? { convergence } : {}) };
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
            if (sim.measurements.length === 0) {
                return 'The simulation produced no measurable data, so the design could not be verified.';
            }
            // Simulated cleanly WITH data, but no acceptance criteria were asserted — nothing was verified.
            return 'The circuit simulated cleanly, but no acceptance criteria were asserted — so nothing was verified. Add measurable specs to get a pass/fail.';
        }
        const parts: string[] = [];
        if (sim.simStatus === 'failed') parts.push(`simulation failed (${sim.runError ?? 'unknown error'})`);
        if (sim.ercErrors.length) parts.push(`${sim.ercErrors.length} ERC error(s)`);
        const failed = results.filter((r) => !r.pass);
        if (failed.length) parts.push(`${failed.length}/${results.length} spec(s) not met`);
        if (verdict === 'pass') {
            // A 'pass' now always has at least one asserted spec (an empty set is 'inconclusive' above).
            const warnNote = sim.ercWarnings.length ? ` (${sim.ercWarnings.length} ERC warning(s) to review)` : '';
            return `Verified: simulation succeeded, no ERC errors, all ${results.length} spec(s) met.${warnNote}`;
        }
        return `Not verified: ${parts.join('; ')}.`;
    }
}
