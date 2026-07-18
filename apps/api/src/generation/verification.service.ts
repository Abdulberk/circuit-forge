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
import { safeValidateCircuitJson, buildElectricalScope, criterionDimension, checkOrientationConsistency, classifyRobustness, type CircuitJson, type ScopeManifest, type OrientationReport, type YieldSummary, type RobustnessTier, type DeterminedEntry } from '@circuit-forge/eda-core';
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
     *  and the circuit failed/couldn't simulate, OR an assertion was not met, OR the Monte-Carlo robustness
     *  gate flipped it (an at-risk tier on tolerances the user fully specified — see `montecarlo`).
     *  inconclusive = the simulation couldn't RUN (ngspice not configured, OR the worker/queue was
     *  unavailable / backed up) so specs couldn't be checked — an OPERATIONAL state, never about the design. */
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
    /** Scope disclosure: which checks this verdict actually ran, and — as important — which it did NOT.
     *  Keeps the badge from over-claiming by omission. */
    scope: ScopeManifest;
    /** Orientation ROLE-consistency (informational): diode/zener/LED that do not declare anode + cathode.
     *  Not geometric; polarized caps/connectors not covered. Present when the circuit validated. */
    polarity?: OrientationReport;
    /** Monte-Carlo tolerance-yield robustness (present only when requested + the nominal verdict is 'pass').
     *  The tier (robust/marginal/at-risk) grades the Wilson-95% lower bound of the pass-rate; it is
     *  INFORMATIONAL and flips `verdict` to 'fail' ONLY when at-risk AND the tolerances were user-specified. */
    montecarlo?: MonteCarloEvidence;
}

/** Provenance of the tolerances a robustness tier was computed on — disclosed with the tier, and the gate
 *  keys on it. Only 'user-specified' (EVERY toleranced part is user-stated) is gate-eligible: the worker
 *  perturbs every toleranced part regardless of source, so an at-risk verdict is attributable purely to
 *  user-stated spread ONLY when the user owns the whole spread. A 'mixed' or 'catalog' basis stays
 *  informational — we never auto-fail a design on catalog-datasheet spread the user didn't state. */
export type ToleranceBasis = 'user-specified' | 'catalog' | 'mixed' | 'unspecified' | 'none';

/** Domain yield-bar profile for the robustness tier (bars live in eda-core's ROBUSTNESS_PROFILES). */
export type RobustnessProfile = 'consumer' | 'automotive' | 'medical';

/** The Monte-Carlo robustness section of a DesignEvidence (see VerificationService.runMonteCarloRobustness). */
export interface MonteCarloEvidence {
    tier?: RobustnessTier;
    /** Point-estimate pass-rate in [0,1]. */
    yield?: number;
    /** Wilson-95% LOWER bound — what the tier is graded on (honest re: sample count). */
    yieldLowerBound?: number;
    /** Variants actually evaluated (the yield denominator). */
    evaluated?: number;
    /** Where the tolerances came from — the honest disclosure so a tier is never read off a silent assumption. */
    toleranceBasis?: ToleranceBasis;
    /** Domain profile whose bars were applied. */
    profile?: string;
    /** Whether this tier flipped the verdict (only at-risk + user-specified + a COMPLETE run does). */
    gated?: boolean;
    /** True when the batch was cut short by its wall-clock budget — the tier is then a low-confidence lower
     *  bound (few samples), NOT a robustness failure, so it is disclosed but NEVER gates. */
    budgetHit?: boolean;
    /** Plain-language honest one-liner. */
    note?: string;
    /** Present instead when the check couldn't be performed (no toleranced parts / infra / didn't complete). */
    unavailable?: string;
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

/** Where a circuit's tolerances came from — the honest basis a robustness tier must disclose (and the gate
 *  keys on): 'user-specified' (the user stated it, gate-eligible), 'catalog' (a datasheet fact from a sourced
 *  part), 'unspecified' (a tolerance with no recorded source), or 'none' (nothing toleranced). Pure. */
export function deriveToleranceBasis(circuit: CircuitJson): ToleranceBasis {
    const toleranced = circuit.components.filter((c) => typeof c.tolerance === 'number' && c.tolerance > 0);
    if (toleranced.length === 0) return 'none';
    // The worker perturbs EVERY toleranced part regardless of source, so an at-risk tier is attributable
    // purely to a given basis ONLY when ALL toleranced parts share it. 'user-specified' (the gate-eligible
    // basis) therefore requires EVERY toleranced part to be user-stated — one catalog part makes it 'mixed'
    // (informational), never a user-gated fail on spread the user didn't state.
    if (toleranced.every((c) => c.toleranceSource === 'user')) return 'user-specified';
    if (toleranced.every((c) => c.toleranceSource === 'catalog')) return 'catalog';
    if (toleranced.every((c) => c.toleranceSource === undefined)) return 'unspecified';
    return 'mixed';
}

/** The scope-manifest 'robustness' entry: an MC tier (with its basis + N) when MC ran, a corner run, an
 *  honest "requested but unavailable" when a requested check could not complete, else "not requested". */
export function robustnessManifestEntry(montecarlo?: MonteCarloEvidence, corner?: WorstCaseEvidence): DeterminedEntry {
    if (montecarlo && !montecarlo.unavailable) {
        const tail = montecarlo.gated
            ? ' — GATED (verdict → fail)'
            : montecarlo.budgetHit
                ? ' — informational (INCOMPLETE — budget cut)'
                : ' — informational (does not gate)';
        return {
            status: 'run',
            detail:
                `${montecarlo.tier} — ${((montecarlo.yieldLowerBound ?? 0) * 100).toFixed(1)}% yield (95% CI lower bound), ` +
                `${montecarlo.evaluated} Monte-Carlo runs; tolerances: ${montecarlo.toleranceBasis}${tail}`,
        };
    }
    if (montecarlo?.unavailable) return { status: 'not-run', detail: `Monte-Carlo requested but unavailable — ${montecarlo.unavailable}` };
    if (corner && !corner.unavailable) return { status: 'run', detail: 'worst-case corner robustness — informational (does not gate the verdict)' };
    if (corner?.unavailable) return { status: 'not-run', detail: `worst-case corner requested but unavailable — ${corner.unavailable}` };
    return { status: 'not-run', detail: 'tolerance robustness not requested' };
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
        robustness?: { corner?: boolean; maxCorners?: number; montecarlo?: boolean; n?: number; seed?: number; profile?: RobustnessProfile },
    ): Promise<DesignEvidence> {
        // Validate ONCE up front and reuse: the nets let evaluateAssertions resolve a criterion that names a
        // net ("v(out)") to the node the generator emitted from that net's ID — so the check still matches when
        // a net's id differs from its name (universal once the frontend mints UUID ids). Also feeds power below.
        const validCircuit = safeValidateCircuitJson(circuit);
        const nets = validCircuit.success ? (validCircuit.data as CircuitJson).nets : undefined;
        // Pre-layout design-review graph check (pure, sim-independent): orientation ROLE-consistency, read
        // from OUR validated CircuitJson (never a downstream transform). Informational — surfaces warnings,
        // never gates the verdict; its honest scope ceiling rides in the manifest. (Decoupling presence is
        // deferred — the model has no power-rail marking to identify a rail reliably; disclosed not-run.)
        const polarity = validCircuit.success ? checkOrientationConsistency(validCircuit.data as CircuitJson) : undefined;
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

        // Robustness (INFORMATIONAL): worst-case corner + Monte-Carlo tolerance-yield tier, run only on a
        // nominal PASS with a worker+user. Extracted to keep verify() legible; the MC gate MAY flip the verdict
        // (only a complete at-risk run whose tolerance spread the user owns entirely — see assessRobustness).
        const rob = await this.assessRobustness(
            circuit,
            analysisConfig ?? { type: 'op' },
            assertions,
            verdict,
            robustness,
            userId,
            validCircuit.success ? (validCircuit.data as CircuitJson) : undefined,
        );
        verdict = rob.verdict;
        const { robustnessEvidence, montecarlo, robustnessManifest } = rob;

        return {
            verdict,
            // When the robustness gate flipped the verdict, the honest top-level reason is the tier's own note
            // (the nominal sim/ERC/assertions all passed, so summarize() would render an empty "Not verified: .").
            summary: montecarlo?.gated ? `Not production-robust: ${montecarlo.note}` : this.summarize(verdict, sim, assertionResults),
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
            ...(montecarlo ? { montecarlo } : {}),
            // Scope disclosure fragment. Reports what THIS verdict actually ran: sim run-state (only 'ok'
            // counts as run — a skipped or failed run produced no usable simulation, so it is disclosed
            // not-run, never a false "Simulation ran"), assertion COVERAGE (which quantities the supplied
            // assertions check — coverage, not requirement satisfaction, since no prompt is threaded here),
            // the resistor-power/derating review, tolerance robustness (MC tier + its basis, or corner), and
            // orientation role-consistency — each disclosed run ONLY when it produced a result. Decoupling
            // presence stays not-run (deferred: no power-rail marking to identify a rail reliably).
            scope: buildElectricalScope({
                simRan: sim.simStatus === 'ok',
                coveredDimensions: [...new Set(assertions.map(criterionDimension))],
                derating: power
                    ? { status: 'run', detail: 'resistor power vs rating — informational, default-rating-based; caps/semiconductors/current not covered' }
                    : { status: 'not-run', detail: 'no resistor-power data (sim not ok / no resistors)' },
                robustness: robustnessManifest,
                polarity: polarity?.manifestEntry,
            }),
            ...(polarity ? { polarity } : {}),
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
     * Enqueue a Monte-Carlo yield batch on the worker, poll it, and grade metrics.monteCarlo into a robustness
     * tier (classifyRobustness on the Wilson-lower bound). Mirrors runCornerRobustness: never throws — an
     * infra/queue failure or a circuit with no toleranced parts returns an `unavailable` reason, never a
     * design failure. The tolerance BASIS is threaded in so the caller can disclose it and decide the gate.
     */
    private async runMonteCarloRobustness(
        circuit: unknown,
        analysis: AnalysisConfig,
        assertions: AssertionDto[],
        opts: { n?: number; seed?: number; profile?: RobustnessProfile; basis: ToleranceBasis },
        userId: string,
    ): Promise<MonteCarloEvidence> {
        try {
            const { jobId } = await this.simulation!.createMonteCarloJob(
                circuit as CircuitJson,
                analysis as unknown as Record<string, unknown>,
                assertions as unknown as AcceptanceCriterion[],
                { n: opts.n ?? 500, seed: opts.seed }, // default 500 — enough sample for the ~99% robust bar
                userId,
            );
            const { status, metrics } = await this.pollJob(jobId, userId);
            if (status !== 'SUCCEEDED') {
                return { unavailable: `Monte-Carlo did not complete (${status.toLowerCase()}) — try again`, toleranceBasis: opts.basis };
            }
            const mc = (metrics as { monteCarlo?: YieldSummary & { budgetHit?: boolean } } | null | undefined)?.monteCarlo;
            if (!mc) return { unavailable: 'Monte-Carlo produced no result', toleranceBasis: opts.basis };
            if (mc.evaluated === 0) {
                return { unavailable: 'no toleranced components to vary — set a tolerance or source a real part (its datasheet tolerance is captured)', toleranceBasis: opts.basis };
            }
            const v = classifyRobustness(mc as unknown as Record<string, unknown>, opts.profile ?? 'consumer');
            const budgetHit = mc.budgetHit === true;
            return {
                tier: v.tier,
                yield: v.yield ?? undefined,
                yieldLowerBound: v.yieldLowerBound ?? undefined,
                evaluated: v.evaluated ?? undefined,
                toleranceBasis: opts.basis,
                profile: v.profile,
                budgetHit,
                // A budget-truncated run's low bound is a small-sample artefact, not a real at-risk — say so.
                note: budgetHit ? `${v.note} (INCOMPLETE — cut short by the time budget after ${v.evaluated} runs; raise n or retry for a gating result)` : v.note,
            };
        } catch (e) {
            this.logger.error(`Monte-Carlo robustness run failed: ${e instanceof Error ? e.message : e}`);
            return { unavailable: 'Monte-Carlo robustness could not be run (worker/queue unavailable) — try again', toleranceBasis: opts.basis };
        }
    }

    /**
     * Run the requested INFORMATIONAL robustness checks on a nominally-passing design (worst-case corner +
     * Monte-Carlo tolerance-yield tier) and return the evidence, the disclosure manifest entry, and the
     * (possibly gate-flipped) verdict. Only a COMPLETE Monte-Carlo at-risk whose tolerance spread the user
     * OWNS ENTIRELY flips the verdict; every other outcome — a catalog/mixed basis, a budget-truncated run,
     * or the corner check — is disclosed but never auto-fails. Extracted so verify() stays legible.
     */
    private async assessRobustness(
        circuit: unknown,
        analysis: AnalysisConfig,
        assertions: AssertionDto[],
        nominalVerdict: DesignEvidence['verdict'],
        robustness: { corner?: boolean; maxCorners?: number; montecarlo?: boolean; n?: number; seed?: number; profile?: RobustnessProfile } | undefined,
        userId: string | undefined,
        circuitJson: CircuitJson | undefined,
    ): Promise<{ verdict: DesignEvidence['verdict']; robustnessEvidence?: WorstCaseEvidence; montecarlo?: MonteCarloEvidence; robustnessManifest: DeterminedEntry }> {
        let verdict = nominalVerdict;

        let robustnessEvidence: WorstCaseEvidence | undefined;
        if (robustness?.corner && verdict === 'pass' && this.simulation && userId) {
            robustnessEvidence = await this.runCornerRobustness(circuit, analysis, assertions, robustness.maxCorners ? { maxComponents: robustness.maxCorners } : {}, userId);
        }

        let montecarlo: MonteCarloEvidence | undefined;
        if (robustness?.montecarlo && verdict === 'pass' && this.simulation && userId) {
            const basis = circuitJson ? deriveToleranceBasis(circuitJson) : 'none';
            if (basis === 'none') {
                // No toleranced parts → a Monte-Carlo run would just re-simulate the nominal design N times
                // (identical variants): wasted compute + a meaningless 'robust'. Skip it, disclose honestly.
                montecarlo = { unavailable: 'no toleranced parts to vary — set a tolerance or source a real part (its datasheet tolerance is captured)', toleranceBasis: 'none' };
            } else {
                montecarlo = await this.runMonteCarloRobustness(circuit, analysis, assertions, { n: robustness.n, seed: robustness.seed, profile: robustness.profile, basis }, userId);
                // GATE: flip only on a COMPLETE at-risk run whose spread the user OWNS entirely. A budget-cut
                // run (a small-sample low bound, not a real failure) or a catalog/mixed basis stays informational.
                if (montecarlo.tier === 'at-risk' && basis === 'user-specified' && !montecarlo.budgetHit) {
                    verdict = 'fail';
                    montecarlo.gated = true;
                }
            }
        }

        return { verdict, robustnessEvidence, montecarlo, robustnessManifest: robustnessManifestEntry(montecarlo, robustnessEvidence) };
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
