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
import {
    runErc,
    generateNetlist,
    safeValidateCircuitJson,
    buildElectricalScope,
    criterionDimension,
    checkOrientationConsistency,
    classifyRobustness,
    barsForProfile,
    DEFAULT_ROBUSTNESS_PROFILE,
    TEMP_CORNER_CEILING,
    type AnalysisConfig,
    type SimulationResult,
    type AcceptanceCriterion,
    type CornerSpec,
    type CircuitJson,
    type ScopeManifest,
    type OrientationReport,
    type YieldSummary,
    type RobustnessTier,
    type DeterminedEntry,
    type TempCornerSpec,
    type TempMetricDrift,
    type SupplyCornerSpec,
    type RailValidation,
    type SupplyDrift,
} from '@circuit-forge/eda-core';
import { Injectable, Optional, Logger } from '@nestjs/common';

import { SimulationService } from '../simulation/simulation.service';

import {
    evaluateAssertions,
    attachFourierThd,
    attachTransferFunction,
    extraProbesForCriteria,
    type AssertionResult,
} from './assertions';
import {
    CircuitSimulatorService,
    summarizeSeries,
    type SimMeasurement,
    type SimSummary,
    type ConvergenceReport,
} from './circuit-simulator.service';
import type { AssertionDto } from './dto';
import { attachGenericModels } from './model-resolution';
import { computeResistorPower, type PowerReport } from './power-analysis';

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
    /** Ambient temperature-corner robustness (present only when requested + the nominal verdict is 'pass'):
     *  spec re-evaluated + per-node metric drift across the profile's cold/room/hot set. INFORMATIONAL and
     *  AMBIENT-ONLY (no self-heating/Tj) — NEVER flips `verdict` in any branch. Temperature-flat circuits are
     *  disclosed not-applicable, never "passed". */
    tempcorner?: TempCornerEvidence;
    /** Supply-voltage corner robustness (present only when requested + the nominal verdict is 'pass'): spec
     *  re-evaluated + per-node drift when each trusted power rail's source is perturbed ±tolerance. INFORMATIONAL
     *  — NEVER flips `verdict`. When no rail is trusted it is disclosed not-applicable (with the reason), never "passed". */
    supplycorner?: SupplyCornerEvidence;
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

/** The SUPPLY-VOLTAGE corner section of a DesignEvidence (see VerificationService.runSupplyCorner). Perturbs each
 *  trusted power rail's driving source ±tolerance. INFORMATIONAL — never gates. `rails` carries EVERY isPower net's
 *  validation status (its emptiness vs. deferred entries drives the honest 3-way not-run disclosure). */
export interface SupplyCornerEvidence {
    supplyCorner?: {
        /** False when NO rail is trusted (no power rail marked, or all deferred) — not-applicable, never "passed". */
        applicable: boolean;
        rails: RailValidation[];
        omitted: string[];
        tolerance: number;
        rangeLabel?: string;
        evaluated: number;
        passed: number;
        failed: number;
        errored: number;
        hasLimits: boolean;
        passAllCorners: boolean;
        drift: SupplyDrift[];
    };
    /** Present instead when the check couldn't be performed (infra / didn't complete). */
    unavailable?: string;
}

/** The AMBIENT temperature-corner section of a DesignEvidence (see VerificationService.runTempCorner). Informational
 *  and AMBIENT-ONLY (self-heating / junction-temp Tj NOT modeled — see TEMP_CORNER_CEILING); never gates the verdict. */
export interface TempCornerEvidence {
    tempCorner?: {
        /** False when temperature-flat (passive-only / behavioral subckt) — not-applicable, never "passed". */
        applicable: boolean;
        notApplicableReason?: string;
        temperaturesC: number[];
        rangeLabel?: string;
        evaluated: number;
        passed: number;
        failed: number;
        errored: number;
        hasLimits: boolean;
        passAllTemps: boolean;
        drift: TempMetricDrift[];
    };
    /** Present instead when the check couldn't be performed (infra / didn't complete). */
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

/** The supply-corner sub-clause + whether it counts as "ran". Honest 3-way not-run: (c) NO power rail marked —
 *  the common freeze-era case, phrased so it reads as "not yet marked" not "broken"; (b) the marked rail(s) could
 *  not be validated (the refutation-asymmetry deferred, with the reason); or requested-but-unavailable. */
function supplyCornerClause(supplycorner?: SupplyCornerEvidence): { clause: string; ran: boolean } | null {
    const sc = supplycorner?.supplyCorner;
    if (sc && !supplycorner?.unavailable) {
        if (sc.applicable) {
            const range = sc.rangeLabel ?? `±${(sc.tolerance * 100).toFixed(0)}%`;
            const outcome = sc.hasLimits
                ? sc.passAllCorners
                    ? 'spec held at every supply corner'
                    : `spec violated at ${sc.failed} supply corner(s)`
                : 'drift-only (no spec limits supplied)';
            return { clause: `supply corners (${range}) — ${outcome}; informational (does not gate)`, ran: true };
        }
        if (sc.rails.length === 0) {
            return {
                clause: 'supply corners: not-run — no power rail marked (mark a net isPower to enable; expected until rails are marked)',
                ran: false,
            };
        }
        const reasons = sc.rails
            .filter((r) => r.status === 'deferred')
            .map((r) => r.reason)
            .filter(Boolean)
            .join('; ');
        return { clause: `supply corners: not-run — marked power net could not be validated: ${reasons}`, ran: false };
    }
    if (supplycorner?.unavailable)
        return { clause: `supply corner requested but unavailable — ${supplycorner.unavailable}`, ran: false };
    return null;
}

/** The scope-manifest 'robustness' entry — COMPOSES every robustness sub-analysis that ran (Monte-Carlo tier +
 *  worst-case tolerance corner + ambient temperature corner + supply-voltage corner) into ONE disclosure so none
 *  is hidden. (It used to early-return on Monte-Carlo, silently dropping the others.) Each sub-clause keeps its
 *  exact prior wording, so an MC-only or corner-only manifest is byte-identical to before; ' | ' joins only when
 *  more than one ran. gradation:'presence' is set when the ambient temperature corner ran — its ambient-only
 *  ceiling makes it deliberately shallower than "temperature verified", exactly the presence-depth marker. */
export function robustnessManifestEntry(
    montecarlo?: MonteCarloEvidence,
    corner?: WorstCaseEvidence,
    tempcorner?: TempCornerEvidence,
    supplycorner?: SupplyCornerEvidence,
): DeterminedEntry {
    const clauses: string[] = [];
    let ranAny = false;
    let presence = false;

    // Monte-Carlo tier (the only sub-analysis that can gate — its clause reports whether it did).
    if (montecarlo && !montecarlo.unavailable) {
        ranAny = true;
        const tail = montecarlo.gated
            ? ' — GATED (verdict → fail)'
            : montecarlo.budgetHit
              ? ' — informational (INCOMPLETE — budget cut)'
              : ' — informational (does not gate)';
        clauses.push(
            `${montecarlo.tier} — ${((montecarlo.yieldLowerBound ?? 0) * 100).toFixed(1)}% yield (95% CI lower bound), ` +
                `${montecarlo.evaluated} Monte-Carlo runs; tolerances: ${montecarlo.toleranceBasis}${tail}`,
        );
    } else if (montecarlo?.unavailable) {
        clauses.push(`Monte-Carlo requested but unavailable — ${montecarlo.unavailable}`);
    }

    // Worst-case ±tolerance corner (informational).
    if (corner && !corner.unavailable) {
        ranAny = true;
        clauses.push('worst-case corner robustness — informational (does not gate the verdict)');
    } else if (corner?.unavailable) {
        clauses.push(`worst-case corner requested but unavailable — ${corner.unavailable}`);
    }

    // Ambient temperature corner (informational, ambient-only ceiling). A temperature-flat circuit is disclosed
    // not-applicable (NOT "passed"); a run carries the ambient-only ceiling so it can't be over-read.
    const tc = tempcorner?.tempCorner;
    if (tc && !tempcorner?.unavailable) {
        if (!tc.applicable) {
            clauses.push(
                `temperature corner: ${tc.notApplicableReason ?? 'not-applicable (temperature-flat circuit)'}`,
            );
        } else {
            ranAny = true;
            presence = true;
            const range = tc.rangeLabel ?? `${tc.temperaturesC.join(' / ')} C`;
            const outcome = tc.hasLimits
                ? tc.passAllTemps
                    ? 'spec held at every temperature'
                    : `spec violated at ${tc.failed} temperature(s)`
                : 'drift-only (no spec limits supplied)';
            clauses.push(
                `temperature corners (${range}) — ${outcome}; informational (does not gate). ${TEMP_CORNER_CEILING}`,
            );
        }
    } else if (tempcorner?.unavailable) {
        clauses.push(`temperature corner requested but unavailable — ${tempcorner.unavailable}`);
    }

    // Supply-voltage corner (informational) — its honest 3-way not-run is built in supplyCornerClause.
    const supply = supplyCornerClause(supplycorner);
    if (supply) {
        clauses.push(supply.clause);
        if (supply.ran) ranAny = true;
    }

    if (clauses.length === 0) return { status: 'not-run', detail: 'tolerance robustness not requested' };
    const entry: DeterminedEntry = { status: ranAny ? 'run' : 'not-run', detail: clauses.join(' | ') };
    if (presence) entry.gradation = 'presence';
    return entry;
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
        robustness?: {
            corner?: boolean;
            maxCorners?: number;
            montecarlo?: boolean;
            n?: number;
            seed?: number;
            profile?: RobustnessProfile;
            temperature?: boolean;
            supply?: boolean;
            supplyTolerance?: number;
        },
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
        const polarity = validCircuit.success
            ? checkOrientationConsistency(validCircuit.data as CircuitJson)
            : undefined;
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
        const { robustnessEvidence, montecarlo, tempcorner, supplycorner, robustnessManifest } = rob;

        return {
            verdict,
            // When the robustness gate flipped the verdict, the honest top-level reason is the tier's own note
            // (the nominal sim/ERC/assertions all passed, so summarize() would render an empty "Not verified: .").
            summary: montecarlo?.gated
                ? `Not production-robust: ${montecarlo.note}`
                : this.summarize(verdict, sim, assertionResults),
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
            ...(tempcorner ? { tempcorner } : {}),
            ...(supplycorner ? { supplycorner } : {}),
            // Scope disclosure fragment. Reports what THIS verdict actually ran: sim run-state (only 'ok'
            // counts as run — a skipped or failed run produced no usable simulation, so it is disclosed
            // not-run, never a false "Simulation ran"), assertion COVERAGE (which quantities the supplied
            // assertions check — coverage, not requirement satisfaction, since no prompt is threaded here),
            // the resistor-power review, tolerance robustness (MC tier + its basis, or corner), and
            // orientation role-consistency — each disclosed run ONLY when it produced a result. Decoupling
            // presence stays not-run (deferred: no power-rail marking to identify a rail reliably).
            scope: buildElectricalScope({
                simRan: sim.simStatus === 'ok',
                coveredDimensions: [...new Set(assertions.map(criterionDimension))],
                resistorPower: power
                    ? {
                          status: 'run',
                          detail: 'resistor power vs rating — informational; rating from the part when it declares one, else its package size, else a 0.25W default',
                      }
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
                return {
                    unavailable: `worst-case corner check did not complete (${status.toLowerCase()}) — try again`,
                };
            }
            const wc = (metrics as { worstCase?: WorstCaseEvidence['worstCase'] } | null | undefined)?.worstCase;
            if (!wc) return { unavailable: 'worst-case corner check produced no result' };
            if (wc.evaluated === 0)
                return { unavailable: 'no toleranced components to corner — add a "tolerance" to R/C/L values' };
            return { worstCase: wc };
        } catch (e) {
            this.logger.error(`worst-case corner run failed: ${e instanceof Error ? e.message : String(e)}`);
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
                // No hardcoded n. The old `?? 500` looked generous but silently pinned the ceiling: the
                // consumer bar needs 381 clean runs and 500 covers it, yet automotive/medical need 3838 — so
                // those tiers were unreachable by arithmetic, not by design quality. The profile now travels
                // instead, and eda-core derives both the ceiling and the stopping rule from its bars. An
                // explicit caller-supplied `n` still wins, and wall-clock remains bounded by the batch budget.
                {
                    ...(opts.n ? { n: opts.n } : {}),
                    seed: opts.seed,
                    ...(opts.profile ? { profile: opts.profile } : {}),
                },
                userId,
            );
            const { status, metrics } = await this.pollJob(jobId, userId);
            if (status !== 'SUCCEEDED') {
                return {
                    unavailable: `Monte-Carlo did not complete (${status.toLowerCase()}) — try again`,
                    toleranceBasis: opts.basis,
                };
            }
            const mc = (metrics as { monteCarlo?: YieldSummary & { budgetHit?: boolean } } | null | undefined)
                ?.monteCarlo;
            if (!mc) return { unavailable: 'Monte-Carlo produced no result', toleranceBasis: opts.basis };
            if (mc.evaluated === 0) {
                return {
                    unavailable:
                        'no toleranced components to vary — set a tolerance or source a real part (its datasheet tolerance is captured)',
                    toleranceBasis: opts.basis,
                };
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
                note: budgetHit
                    ? `${v.note} (INCOMPLETE — cut short by the time budget after ${v.evaluated} runs; raise n or retry for a gating result)`
                    : v.note,
            };
        } catch (e) {
            this.logger.error(`Monte-Carlo robustness run failed: ${e instanceof Error ? e.message : String(e)}`);
            return {
                unavailable: 'Monte-Carlo robustness could not be run (worker/queue unavailable) — try again',
                toleranceBasis: opts.basis,
            };
        }
    }

    /**
     * Enqueue an ambient temperature-corner batch on the worker, poll it, and distill metrics.tempCorner into the
     * evidence's tempcorner section. Mirrors runCornerRobustness: never throws — an infra/queue failure returns an
     * `unavailable` reason, never a design failure. A not-applicable result (temperature-flat circuit) is a VALID
     * result (surfaced with its reason), not an unavailability. INFORMATIONAL — the caller never gates on it.
     */
    private async runTempCorner(
        circuit: unknown,
        analysis: AnalysisConfig,
        assertions: AssertionDto[],
        spec: TempCornerSpec,
        userId: string,
    ): Promise<TempCornerEvidence> {
        try {
            const { jobId } = await this.simulation!.createTempCornerJob(
                circuit as CircuitJson,
                analysis as unknown as Record<string, unknown>,
                assertions as unknown as AcceptanceCriterion[],
                spec,
                userId,
            );
            const { status, metrics } = await this.pollJob(jobId, userId);
            if (status !== 'SUCCEEDED') {
                return {
                    unavailable: `temperature-corner check did not complete (${status.toLowerCase()}) — try again`,
                };
            }
            const tc = (metrics as { tempCorner?: TempCornerEvidence['tempCorner'] } | null | undefined)?.tempCorner;
            if (!tc) return { unavailable: 'temperature-corner check produced no result' };
            return { tempCorner: tc };
        } catch (e) {
            this.logger.error(`temperature-corner run failed: ${e instanceof Error ? e.message : String(e)}`);
            return { unavailable: 'temperature-corner check could not be run (worker/queue unavailable) — try again' };
        }
    }

    /**
     * Enqueue a supply-voltage corner batch on the worker, poll it, and distill metrics.supplyCorner into the
     * evidence's supplycorner section. Mirrors runTempCorner: never throws. A NOT-APPLICABLE result (no rail
     * trusted — no rail marked, or all deferred) is a VALID result (returned with its rail statuses so the
     * manifest can disclose the honest 3-way not-run), not an unavailability. INFORMATIONAL — never gated on.
     */
    private async runSupplyCorner(
        circuit: unknown,
        analysis: AnalysisConfig,
        assertions: AssertionDto[],
        spec: SupplyCornerSpec,
        userId: string,
    ): Promise<SupplyCornerEvidence> {
        try {
            const { jobId } = await this.simulation!.createSupplyCornerJob(
                circuit as CircuitJson,
                analysis as unknown as Record<string, unknown>,
                assertions as unknown as AcceptanceCriterion[],
                spec,
                userId,
            );
            const { status, metrics } = await this.pollJob(jobId, userId);
            if (status !== 'SUCCEEDED') {
                return { unavailable: `supply-corner check did not complete (${status.toLowerCase()}) — try again` };
            }
            const sc = (metrics as { supplyCorner?: SupplyCornerEvidence['supplyCorner'] } | null | undefined)
                ?.supplyCorner;
            if (!sc) return { unavailable: 'supply-corner check produced no result' };
            return { supplyCorner: sc };
        } catch (e) {
            this.logger.error(`supply-corner run failed: ${e instanceof Error ? e.message : String(e)}`);
            return { unavailable: 'supply-corner check could not be run (worker/queue unavailable) — try again' };
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
        robustness:
            | {
                  corner?: boolean;
                  maxCorners?: number;
                  montecarlo?: boolean;
                  n?: number;
                  seed?: number;
                  profile?: RobustnessProfile;
                  temperature?: boolean;
                  supply?: boolean;
                  supplyTolerance?: number;
              }
            | undefined,
        userId: string | undefined,
        circuitJson: CircuitJson | undefined,
    ): Promise<{
        verdict: DesignEvidence['verdict'];
        robustnessEvidence?: WorstCaseEvidence;
        montecarlo?: MonteCarloEvidence;
        tempcorner?: TempCornerEvidence;
        supplycorner?: SupplyCornerEvidence;
        robustnessManifest: DeterminedEntry;
    }> {
        let verdict = nominalVerdict;

        let robustnessEvidence: WorstCaseEvidence | undefined;
        if (robustness?.corner && verdict === 'pass' && this.simulation && userId) {
            robustnessEvidence = await this.runCornerRobustness(
                circuit,
                analysis,
                assertions,
                robustness.maxCorners ? { maxComponents: robustness.maxCorners } : {},
                userId,
            );
        }

        let montecarlo: MonteCarloEvidence | undefined;
        if (robustness?.montecarlo && verdict === 'pass' && this.simulation && userId) {
            const basis = circuitJson ? deriveToleranceBasis(circuitJson) : 'none';
            if (basis === 'none') {
                // No toleranced parts → a Monte-Carlo run would just re-simulate the nominal design N times
                // (identical variants): wasted compute + a meaningless 'robust'. Skip it, disclose honestly.
                montecarlo = {
                    unavailable:
                        'no toleranced parts to vary — set a tolerance or source a real part (its datasheet tolerance is captured)',
                    toleranceBasis: 'none',
                };
            } else {
                montecarlo = await this.runMonteCarloRobustness(
                    circuit,
                    analysis,
                    assertions,
                    { n: robustness.n, seed: robustness.seed, profile: robustness.profile, basis },
                    userId,
                );
                // GATE: flip only on a COMPLETE at-risk run whose spread the user OWNS entirely. A budget-cut
                // run (a small-sample low bound, not a real failure) or a catalog/mixed basis stays informational.
                if (montecarlo.tier === 'at-risk' && basis === 'user-specified' && !montecarlo.budgetHit) {
                    verdict = 'fail';
                    montecarlo.gated = true;
                }
            }
        }

        // Ambient TEMPERATURE corner (INFORMATIONAL). It NEVER touches `verdict` in ANY branch — the ambient-only
        // ceiling (no self-heating/Tj) makes gating on it unjustifiable, so passAllTemps/failed are disclosed only.
        // The temperature range comes from the SAME robustness profile (one grade concept — not a separate temp grade).
        let tempcorner: TempCornerEvidence | undefined;
        if (robustness?.temperature && verdict === 'pass' && this.simulation && userId && circuitJson) {
            // Resolve through the SHARED helper rather than a hand-rolled lookup: the sampler, the grader and
            // this corner sweep have to agree on which bars apply, and a second copy of the fallback is exactly
            // how they drift apart. It also refuses inherited keys, so a profile name off the wire cannot reach
            // Object.prototype and hand back a bars-shaped object that is not a profile.
            const profileName = robustness.profile ?? DEFAULT_ROBUSTNESS_PROFILE;
            const bars = barsForProfile(robustness.profile);
            const temperaturesC = [...bars.tempCornersC];
            const spec: TempCornerSpec = { temperaturesC, rangeLabel: `${profileName} ${temperaturesC.join(' / ')} C` };
            tempcorner = await this.runTempCorner(circuit, analysis, assertions, spec, userId);
        }

        // SUPPLY-VOLTAGE corner (INFORMATIONAL). NEVER touches `verdict` in ANY branch — a Vmin/Vmax fail the user
        // did not ask to gate on stays informational (robustness-gate discipline). Default ±5% supply tolerance.
        let supplycorner: SupplyCornerEvidence | undefined;
        if (robustness?.supply && verdict === 'pass' && this.simulation && userId && circuitJson) {
            const tol =
                robustness.supplyTolerance && robustness.supplyTolerance > 0 ? robustness.supplyTolerance : 0.05;
            const spec: SupplyCornerSpec = { tolerance: tol, rangeLabel: `±${(tol * 100).toFixed(0)}%` };
            supplycorner = await this.runSupplyCorner(circuit, analysis, assertions, spec, userId);
        }

        return {
            verdict,
            robustnessEvidence,
            montecarlo,
            tempcorner,
            supplycorner,
            robustnessManifest: robustnessManifestEntry(montecarlo, robustnessEvidence, tempcorner, supplycorner),
        };
    }

    /**
     * Produce the SimSummary verify() builds evidence on. PROD path delegates ngspice to the WORKER
     * (the API image ships no ngspice; the worker has it + the rlimit sandbox) — keeping untrusted
     * execution in one isolated tier. Falls back to the INLINE simulator only when there's no userId/
     * queue (local dev + the live specs), where the Convergence Doctor's remedy ladder still applies.
     * (Slice 1: the worker path is single-pass; moving the ladder worker-side is the next slice.)
     */
    private async runSimulation(
        circuit: unknown,
        analysis: AnalysisConfig | undefined,
        userId?: string,
        extraProbes?: string[],
    ): Promise<SimSummary> {
        if (userId && this.simulation) return this.runViaWorker(circuit, analysis, userId, extraProbes);
        return this.simulator.simulateWithRemedies(circuit, analysis, extraProbes);
    }

    /**
     * Worker-backed run: ERC + netlist are pure (done here), ngspice runs on the worker queue, and the
     * API server-side-polls for the result (same pattern as the AI design loop) so verify-design stays
     * a SYNCHRONOUS request. Returns the SimSummary; never throws (failures become a 'failed' summary).
     */
    private async runViaWorker(
        circuit: unknown,
        analysis: AnalysisConfig | undefined,
        userId: string,
        extraProbes?: string[],
    ): Promise<SimSummary> {
        const an: AnalysisConfig = analysis ?? { type: 'op' };
        const empty = { measurements: [], nodeCount: 0, analysisType: an.type };

        const validated = safeValidateCircuitJson(circuit);
        if (!validated.success) {
            const issues = validated.error.errors
                .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
                .join('; ');
            return {
                simStatus: 'failed',
                ercErrors: [],
                ercWarnings: [],
                runError: `invalid circuit: ${issues}`,
                ...empty,
            };
        }
        const c = validated.data as CircuitJson;
        attachGenericModels(c);

        // ERC always runs (pure, API-side) — the worker only does the ngspice execution.
        const erc = runErc(c);
        const ercErrors = erc.issues
            .filter((i) => i.severity === 'error')
            .map((i) => ({ code: i.code, message: i.message, relatedIds: i.relatedIds }));
        const ercWarnings = erc.issues
            .filter((i) => i.severity === 'warning')
            .map((i) => ({ code: i.code, message: i.message, relatedIds: i.relatedIds }));

        let netlist: string;
        try {
            netlist = generateNetlist(c, an, extraProbes?.length ? { extraProbes } : {});
        } catch (e) {
            return {
                simStatus: 'failed',
                ercErrors,
                ercWarnings,
                runError: `netlist generation failed: ${e instanceof Error ? e.message : String(e)}`,
                ...empty,
            };
        }

        try {
            const { jobId } = await this.simulation!.createQuickSim(
                netlist,
                an as unknown as Record<string, unknown>,
                userId,
            );
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
                return {
                    simStatus: 'failed',
                    ercErrors,
                    ercWarnings,
                    runError: `simulation ${status.toLowerCase()}`,
                    ...empty,
                    ...(convergence ? { convergence } : {}),
                };
            }
            // NO design verdict was produced for an OPERATIONAL reason: the job never started (nothing
            // consumed the queue / backlog beyond our budget → POLL_TIMEOUT), was aborted (CANCELED), or the
            // worker hit an infrastructure error before/around ngspice (failureClass 'infra'). The evidence
            // contract FORBIDS reducing any of these to a design 'fail' (that would tell a user with a sound
            // design "verification failed"). → 'skipped' → inconclusive (try again).
            if (status !== 'SUCCEEDED') {
                const why =
                    status === 'POLL_TIMEOUT'
                        ? `simulation did not start within ${Math.round(this.pollTimeoutMs / 1000)}s (no worker available or queue backlog)`
                        : infraFailure
                          ? 'the worker could not run the simulation (infrastructure error)'
                          : `simulation was ${status.toLowerCase()}`;
                return { simStatus: 'skipped', ercErrors, ercWarnings, runError: `${why} — try again`, ...empty };
            }

            const res = (await this.simulation!.getResult(jobId, userId)) as {
                result?: SimulationResult | null;
                error?: string;
            };
            const series = res.result?.series;
            if (!series || series.length === 0) {
                // A SUCCEEDED job with no series: getResult sets `error` when the payload spilled to S3 and
                // couldn't be fetched — a STORAGE OUTAGE, not a design fault → inconclusive. Only a genuinely
                // empty dataset (no such error) is a degenerate no-data run → fail.
                if (res.error) {
                    return {
                        simStatus: 'skipped',
                        ercErrors,
                        ercWarnings,
                        runError: `${res.error} — try again`,
                        ...empty,
                    };
                }
                return {
                    simStatus: 'failed',
                    ercErrors,
                    ercWarnings,
                    runError: 'simulation produced no result data',
                    ...empty,
                };
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
            return {
                simStatus: 'ok',
                ercErrors,
                ercWarnings,
                measurements,
                nodeCount: series.length,
                analysisType: an.type,
                ...(convergence ? { convergence } : {}),
            };
        } catch (e) {
            // The queue/Redis/DB was unreachable (createQuickSim / getStatus / getResult threw). Same
            // contract rule as POLL_TIMEOUT above: a transient infra outage is NOT a design fault. → inconclusive.
            this.logger.error(`verify-design worker run failed: ${e instanceof Error ? e.message : String(e)}`);
            return {
                simStatus: 'skipped',
                ercErrors,
                ercWarnings,
                runError: 'simulation could not be run (worker/queue unavailable) — try again',
                ...empty,
            };
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
            if (
                s.status === 'SUCCEEDED' ||
                s.status === 'FAILED' ||
                s.status === 'TIMED_OUT' ||
                s.status === 'CANCELED'
            ) {
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
