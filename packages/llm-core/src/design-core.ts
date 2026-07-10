/**
 * Framework-free agentic design loop: generate → simulate → (on miss) AI-fix → re-simulate, up to N rounds,
 * then (on a verified design with toleranced parts) an informational Monte-Carlo yield pass.
 *
 * This is the SINGLE source of the design intelligence. It lives in llm-core (not the API) so BOTH the API
 * (today, via DesignService) AND the worker (when the loop relocates onto the durable 'design' queue) run the
 * IDENTICAL logic by injecting their own side-effecting deps. No NestJS here: the three host touchpoints
 * — LLM config, simulation, catalog grounding — plus abort/progress are injected via `DesignDeps`. The core
 * throws only `CircuitGenerationError` (already framework-free), `DesignAbortedError`, or a plain `Error`;
 * each host maps those to its own surface (the API → HTTP exceptions).
 */
import {
    generateNetlist,
    summarizeSeries,
    resolveGenericModels,
    evaluateAssertions,
    attachFourierThd,
    attachTransferFunction,
    describeFailure,
    uncoveredRequiredDimensions,
    requiredDimensions,
    criterionDimension,
    isCurrentProbe,
    currentKey,
    type CircuitJson,
    type AnalysisConfig,
    type TranAnalysis,
    type OpAnalysis,
    type DataSeries,
    type AcceptanceCriterion,
    type AssertionResult,
    type SpecDimension,
    type FourierResult,
    type TransferFunctionResult,
} from '@circuit-forge/eda-core';
import { generateCircuit, fixCircuit, type GenerateCircuitConfig } from './index';

export interface RoundRecord {
    round: number;
    status: string;
    pointsCount: number;
    jobId?: string;
    note?: string;
}

export interface DesignLoopInput {
    prompt: string;
    constraints?: string;
    maxRounds?: number;
    /** SEED a pre-generated circuit so the loop SKIPS its initial generateCircuit and re-enters at the
     *  simulate/fix stage. The multi-candidate orchestrator passes a screened candidate here so finalists
     *  don't burn a second generate request (they were already generated in the screen). When omitted, the
     *  loop generates as before — byte-identical to today. seedCriteria/seedAnalysisConfig/seedExplanation
     *  carry the rest of that candidate's generation output. */
    seedCircuit?: CircuitJson;
    seedAnalysisConfig?: AnalysisConfig;
    seedCriteria?: AcceptanceCriterion[];
    seedExplanation?: string;
}

/** The design result (superset of the success / inconclusive / spec-miss shapes — the discriminators are
 *  `ok` / `verified` / `inconclusive`). Typed so callers keep `.circuit` etc. without casting. */
export interface DesignResult {
    ok: boolean;
    circuit: CircuitJson;
    analysisConfig: AnalysisConfig;
    explanation?: string;
    rounds: number;
    history: RoundRecord[];
    simulation: { jobId?: string; status: string; metrics?: unknown; result?: unknown };
    verified?: boolean;
    inconclusive?: boolean;
    acceptanceCriteria?: AcceptanceCriterion[];
    assertions?: AssertionResult[];
    warning?: string;
    caveats?: string[];
    yield?: Record<string, unknown>;
    /** Tolerance-aware robustness tier (layered on top of nominal `verified`; never false-fails). */
    robustness?: RobustnessVerdict;
    /** Index signature so a caller may still treat the result as a loose record (the API persists it as Json,
     *  and the tests read fields dynamically). Named members above keep their precise types (e.g. circuit). */
    [key: string]: unknown;
}

/** The simulation surface the loop needs. The API's SimulationService matches this signature exactly (zero
 *  adapter); the worker supplies a LOCAL-ngspice impl that returns the same shapes synchronously. */
export interface DesignRunSim {
    createQuickSim(netlist: string, analysisConfig: Record<string, unknown> | undefined, userId: string): Promise<{ jobId: string }>;
    getStatus(jobId: string, userId: string): Promise<{ status: string; metrics?: unknown }>;
    getResult(jobId: string, userId: string): Promise<unknown>;
    createMonteCarloJob(
        circuit: CircuitJson,
        analysisConfig: Record<string, unknown> | undefined,
        criteria: AcceptanceCriterion[],
        opts: { n?: number; seed?: number },
        userId: string,
    ): Promise<{ jobId: string }>;
}

/** Catalog grounding surface. The worker injects a no-op (grounding()→undefined) until a framework-free TME
 *  executor is added; the loop already guards every grounding call on a truthy `grounding()`. */
export interface DesignGround {
    grounding(): unknown;
    enrichSourcing(circuit: CircuitJson): Promise<void>;
}

export interface DesignDeps {
    llmConfig: GenerateCircuitConfig;
    runSim: DesignRunSim;
    ground: DesignGround;
    userId: string;
    /** Server-side poll budget (ms) per round's simulation. */
    pollTimeoutMs: number;
    /** DESIGN_MC_ENABLED !== 'false'. */
    mcEnabled: boolean;
    /** DESIGN_MC_RUNS override (variants), or undefined for the worker default. */
    mcRuns?: number;
    /** Cooperative cancel checkpoint — polled at each round start + before each paid LLM call. The API's
     *  synchronous path passes `() => false`; the queue worker reads the DesignJob.abortRequested flag. */
    isAborted?: () => Promise<boolean>;
    /** Progress sink (current round) — the worker writes it to the job; the API ignores it. */
    progress?: (round: number) => void;
    /** Domain profile for the robustness-yield bars (ROBUSTNESS_PROFILES key: consumer | automotive | medical).
     *  Default 'consumer' (≈ Cpk 1.33). Configurable so customer/contract requirements override the default. */
    robustnessProfile?: string;
    /** True for errors that carry intent and must propagate UNTRANSLATED rather than become "inconclusive"
     *  (the API: `e instanceof HttpException`, so a 429 QUOTA_EXCEEDED survives; the worker: `() => false`). */
    isIntentfulError?: (e: unknown) => boolean;
}

/** Thrown when a cooperative cancel was observed mid-loop; the host maps it to a CANCELED outcome. */
export class DesignAbortedError extends Error {
    constructor() {
        super('design canceled');
        this.name = 'DesignAbortedError';
    }
}

function attachGenericModels(circuit: CircuitJson): void {
    const extra = resolveGenericModels(circuit);
    if (extra.length > 0) circuit.models = [...(circuit.models ?? []), ...extra];
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function checkAbort(deps: DesignDeps): Promise<void> {
    if (deps.isAborted && (await deps.isAborted())) throw new DesignAbortedError();
}

/**
 * Run the agentic design loop. Returns the design result object (ok/verified/circuit/...). Throws
 * CircuitGenerationError (LLM produced bad/unusable output), DesignAbortedError (canceled), an intentful
 * error the host flagged (propagated), or a plain Error — the host translates.
 */
export async function runDesignLoop(input: DesignLoopInput, deps: DesignDeps): Promise<DesignResult> {
    const { llmConfig, runSim, ground, userId } = deps;
    const maxRounds = Math.min(Math.max(input.maxRounds ?? 2, 1), 4);
    const groundingOpts = ground.grounding();

    await checkAbort(deps);
    // SEED path: when the orchestrator supplies an already-generated candidate, skip generateCircuit entirely
    // (no second paid request) and enter the loop at the simulate/fix stage. Otherwise generate as before.
    let circuit: CircuitJson;
    let analysis: AnalysisConfig;
    let explanation: string | undefined;
    let criteria: AcceptanceCriterion[];
    if (input.seedCircuit) {
        circuit = input.seedCircuit;
        analysis = input.seedAnalysisConfig ?? ({ type: 'op' } as AnalysisConfig);
        explanation = input.seedExplanation;
        criteria = input.seedCriteria ?? [];
    } else {
        const gen = await generateCircuit(
            { prompt: input.prompt, constraints: input.constraints },
            llmConfig,
            groundingOpts as Parameters<typeof generateCircuit>[2],
        );
        circuit = gen.circuit;
        analysis = gen.analysisConfig;
        explanation = gen.explanation;
        criteria = (gen.acceptanceCriteria ?? []) as AcceptanceCriterion[];
    }
    attachGenericModels(circuit);
    const history: RoundRecord[] = [];
    let lastAssertions: AssertionResult[] = [];
    let currentProbes = criteria.filter((c) => isCurrentProbe(c.probe)).map((c) => c.probe);
    const requiredDims = requiredDimensions(input.prompt);
    const freqCaveat = requiredDims.has('frequency')
        ? ['Frequency response is verified at the −3 dB corner (cutoff) only; passband flatness, stopband attenuation, and roll-off order are not separately asserted.']
        : undefined;

    for (let round = 1; round <= maxRounds; round++) {
        deps.progress?.(round);
        await checkAbort(deps);

        let netlist: string;
        try {
            netlist = generateNetlist(circuit, analysis, currentProbes.length ? { extraProbes: currentProbes } : {});
        } catch (e) {
            history.push({ round, status: 'NETLIST_ERROR', pointsCount: 0, note: errMsg(e) });
            if (round >= maxRounds) break;
            ({ circuit, analysis, explanation } = await applyFix(deps, circuit, analysis, `Netlist generation failed: ${errMsg(e)}`));
            continue;
        }

        let jobId: string;
        let status: { status: string; metrics?: unknown };
        let result: {
            result?: { meta?: { pointsCount?: number }; series?: DataSeries[]; fourier?: FourierResult[]; transferFunction?: TransferFunctionResult };
            metrics?: { pointsCount?: number };
            error?: string;
        };
        try {
            ({ jobId } = await runSim.createQuickSim(netlist, analysis as unknown as Record<string, unknown>, userId));
            status = await pollJob(deps, jobId);
            if (status.status === 'POLL_TIMEOUT' || status.status === 'CANCELED') {
                history.push({ round, status: status.status, pointsCount: 0, jobId, note: 'simulation capacity unavailable' });
                return inconclusive(deps, circuit, analysis, explanation, history, groundingOpts,
                    'Simulation capacity was unavailable, so the design could not be verified — try again. The circuit was generated but its simulation checks did not run.');
            }
            result = (await runSim.getResult(jobId, userId)) as typeof result;
        } catch (e) {
            if (deps.isIntentfulError?.(e)) throw e; // 429 QUOTA_EXCEEDED etc. carry intent — keep them
            history.push({ round, status: 'INFRA_ERROR', pointsCount: 0, note: errMsg(e) });
            return inconclusive(deps, circuit, analysis, explanation, history, groundingOpts,
                'Simulation could not be run (worker/queue unavailable), so the design could not be verified — try again.');
        }

        const failureClass = (status.metrics as { failureClass?: string } | undefined)?.failureClass;
        if (status.status !== 'SUCCEEDED' && failureClass === 'infra') {
            history.push({ round, status: status.status, pointsCount: 0, jobId, note: 'worker infrastructure error' });
            return inconclusive(deps, circuit, analysis, explanation, history, groundingOpts,
                'The worker could not run the simulation (infrastructure error), so the design could not be verified — try again.');
        }

        const statusMetrics = status.metrics as { pointsCount?: number } | undefined;
        const pointsCount = statusMetrics?.pointsCount ?? result?.metrics?.pointsCount ?? result?.result?.meta?.pointsCount ?? 0;
        const simHealthy = status.status === 'SUCCEEDED' && pointsCount > 0;

        if (simHealthy && criteria.length > 0) {
            const measurements = (result.result?.series ?? []).map((s) => summarizeSeries(s, analysis.type));
            if (measurements.length === 0 && result?.error) {
                history.push({ round, status: status.status, pointsCount, jobId, note: 'results unavailable to check specs' });
                return inconclusive(deps, circuit, analysis, explanation, history, groundingOpts,
                    'The simulation ran but its results were unavailable to check the design specifications — try again.');
            }
            // Fold THD (from a fourier request) onto the measurements so a `thd` criterion gates like any other.
            attachFourierThd(measurements, result.result?.fourier);
            attachTransferFunction(measurements, result.result?.transferFunction);
            lastAssertions = evaluateAssertions(measurements, criteria);
        }
        const specsMet = lastAssertions.every((a) => a.pass);
        const uncovered = simHealthy && specsMet ? uncoveredRequiredDimensions(input.prompt, criteria) : [];
        const covered = uncovered.length === 0;
        const succeeded = simHealthy && specsMet && covered;
        history.push({
            round,
            status: status.status,
            pointsCount,
            jobId,
            note: !simHealthy
                ? undefined
                : criteria.length === 0
                    ? 'no acceptance criteria'
                    : !specsMet
                        ? `${lastAssertions.filter((a) => !a.pass).length}/${lastAssertions.length} acceptance criteria unmet`
                        : covered
                            ? 'all acceptance criteria met'
                            : `criteria met but none measures the required ${uncovered.join('/')} target`,
        });

        if (succeeded) {
            if (groundingOpts) await ground.enrichSourcing(circuit);
            const yieldReport = await runYieldAnalysis(deps, circuit, analysis, criteria);
            // Tolerance-aware robustness tier on top of the nominal pass — never gates `ok`/`verified` (a
            // correct design is never false-failed); it just labels real-world robustness honestly. 'unknown'
            // when no MC ran (no toleranced parts), which means "verified at nominal values only".
            const robustness = classifyRobustness(yieldReport, deps.robustnessProfile);
            return {
                ok: true,
                verified: criteria.length > 0,
                circuit,
                analysisConfig: analysis,
                explanation,
                acceptanceCriteria: criteria,
                assertions: lastAssertions,
                rounds: round,
                history,
                simulation: { jobId, status: status.status, metrics: status.metrics, result: result.result },
                ...(yieldReport ? { yield: yieldReport } : {}),
                robustness,
                ...(freqCaveat ? { caveats: freqCaveat } : {}),
            };
        }

        if (round < maxRounds) {
            let problem: string;
            if (!simHealthy) {
                problem =
                    status.status !== 'SUCCEEDED'
                        ? `Simulation ${status.status}. ${result?.error ?? ''}`.trim()
                        : 'Simulation succeeded but produced no data points (pointsCount = 0) — likely a floating node or an analysis that does not excite the circuit.';
                const conv = (status.metrics as { convergence?: { diagnosis?: string; triedRemedies?: string[] } } | undefined)?.convergence;
                if (conv?.diagnosis) {
                    problem += ` Solver diagnosis: ${conv.diagnosis}${conv.triedRemedies?.length ? ` (already tried: ${conv.triedRemedies.join('; ')})` : ''}`;
                }
            } else if (!specsMet) {
                const failed = lastAssertions.filter((a) => !a.pass);
                problem =
                    'The circuit simulates cleanly but does NOT meet the required specification(s):\n' +
                    failed.map((f) => `- ${describeFailure(f)}`).join('\n') +
                    '\nRevise the design so these are satisfied; keep the parts that already pass.';
            } else {
                problem =
                    `The circuit simulates and passes every acceptance criterion, but you specified a ${uncovered.join(' and ')} target and NONE of the acceptance criteria measure ${uncovered.join('/')} — a node-voltage proxy does NOT count. ` +
                    `Add a criterion that probes the quantity DIRECTLY` +
                    (uncovered.includes('current')
                        ? `: for a current, probe a series resistor's branch current, e.g. {"probe":"i(R1)","metric":"final","op":"approx","value":<amps>,"tol":<amps>}`
                        : '') +
                    (uncovered.includes('frequency')
                        ? `: for a cutoff/corner frequency, switch analysisConfig to an AC sweep {"type":"ac","variation":"dec","points":20,"startFreq":"<~fc/100>","stopFreq":"<~fc*100>"} driven by a source declared "AC 1", and add {"probe":"out","metric":"cutoff","op":"approx","value":<fc in Hz>,"tol":<Hz>}`
                        : '') +
                    `. KEEP every existing criterion unchanged (do not relax or remove any).`;
            }
            await checkAbort(deps); // don't spend another LLM call if a cancel arrived
            const fixed = await applyFix(deps, circuit, analysis, problem);
            circuit = fixed.circuit;
            explanation = fixed.explanation;
            criteria = mergeCriteria(criteria, fixed.acceptanceCriteria, requiredDims);
            // A fix may DROP the listing-overlay (fourier/tf) a thd/gain criterion needs to be measurable — the
            // fix prompt asks the model to keep it, but guarantee it: carry the prior round's overlay forward
            // when an active criterion still requires it and the analysis is still the compatible type. Without
            // this, a dropped overlay would flip an otherwise-good thd/gain check to "not determinable" mid-loop.
            analysis = preserveMetricOverlays(analysis, fixed.analysis, criteria);
            currentProbes = criteria.filter((c) => isCurrentProbe(c.probe)).map((c) => c.probe);
        }
    }

    if (groundingOpts) await ground.enrichSourcing(circuit);
    const last = history[history.length - 1];
    const lastRoundHealthy = last?.status === 'SUCCEEDED' && (last?.pointsCount ?? 0) > 0;
    const specMiss = lastRoundHealthy && lastAssertions.length > 0 && lastAssertions.some((a) => !a.pass);
    const lastUncovered = lastRoundHealthy ? uncoveredRequiredDimensions(input.prompt, criteria) : [];
    const coverageMiss = lastRoundHealthy && !specMiss && lastUncovered.length > 0;
    return {
        ok: false,
        verified: false,
        circuit,
        analysisConfig: analysis,
        explanation,
        acceptanceCriteria: criteria,
        assertions: lastAssertions,
        rounds: history.length,
        history,
        simulation: { status: last?.status ?? 'FAILED' },
        warning: specMiss
            ? 'The circuit simulates but did not meet all acceptance criteria within the round budget.'
            : coverageMiss
                ? `The circuit simulates and meets its stated criteria, but you specified a ${lastUncovered.join('/')} target that no acceptance criterion verifies — treat it as unverified for that quantity.`
                : 'Could not produce a successful simulation within the round budget.',
        ...(freqCaveat ? { caveats: freqCaveat } : {}),
    };
}

/**
 * Guarantee that the listing-derived overlays a thd/gain criterion depends on survive a fix round.
 *
 * `thd` is only measurable when the transient carries a `fourier` request on that probe; `gain` only when the
 * op carries a `tf`. A fix model may silently drop the overlay while keeping the criterion — which would flip an
 * otherwise-passing check to "not determinable". We NEVER fabricate an overlay (we don't know the fundamental
 * frequency / input source out of thin air); we only CARRY FORWARD the prior round's overlay, and only when the
 * criterion still needs it AND the fixed analysis is still the compatible type (so a deliberate analysis-type
 * change by the fix is respected — a mismatched criterion then reads not-determinable and is fed back honestly).
 */
export function preserveMetricOverlays(prev: AnalysisConfig, next: AnalysisConfig, criteria: AcceptanceCriterion[]): AnalysisConfig {
    let out = next;
    const prevTran = prev.type === 'tran' ? (prev as TranAnalysis) : undefined;
    const nextTran = next.type === 'tran' ? (next as TranAnalysis) : undefined;
    if (criteria.some((c) => c.metric === 'thd') && prevTran?.fourier && nextTran && !nextTran.fourier) {
        out = { ...nextTran, fourier: prevTran.fourier };
    }
    const prevOp = prev.type === 'op' ? (prev as OpAnalysis) : undefined;
    const nextOp = out.type === 'op' ? (out as OpAnalysis) : undefined;
    if (criteria.some((c) => c.metric === 'gain') && prevOp?.tf && nextOp && !nextOp.tf) {
        out = { ...nextOp, tf: prevOp.tf };
    }
    return out;
}

async function applyFix(
    deps: DesignDeps,
    circuit: CircuitJson,
    analysis: AnalysisConfig,
    problem: string,
): Promise<{ circuit: CircuitJson; analysis: AnalysisConfig; explanation?: string; acceptanceCriteria: AcceptanceCriterion[] }> {
    const fixed = await fixCircuit({ circuit, analysisConfig: analysis, problem }, deps.llmConfig);
    attachGenericModels(fixed.circuit);
    return {
        circuit: fixed.circuit,
        analysis: fixed.analysisConfig,
        explanation: fixed.explanation,
        acceptanceCriteria: (fixed.acceptanceCriteria ?? []) as AcceptanceCriterion[],
    };
}

async function inconclusive(
    deps: DesignDeps,
    circuit: CircuitJson,
    analysis: AnalysisConfig,
    explanation: string | undefined,
    history: RoundRecord[],
    grounding: unknown,
    warning: string,
): Promise<DesignResult> {
    if (grounding) await deps.ground.enrichSourcing(circuit);
    return {
        ok: false,
        inconclusive: true,
        circuit,
        analysisConfig: analysis,
        explanation,
        rounds: history.length,
        history,
        simulation: { status: history[history.length - 1]?.status ?? 'UNAVAILABLE' },
        warning,
    };
}

/**
 * Poll backoff (ms) for the synchronous /design-circuit sim wait. A fast sim resolves on the first ~150ms
 * check (the old fixed-1s loop FLOORED every sim's observed latency at 1s), then exponential growth capped at
 * 2s so a long transient is not hammered with ~1 status query/second (the old loop issued up to hundreds of
 * findUnique per design request). Monotonic non-decreasing. Exported for unit testing.
 */
export function pollBackoffMs(attempt: number): number {
    return Math.min(2000, 150 * 2 ** attempt); // 150, 300, 600, 1200, 2000, 2000, …
}

async function pollJob(deps: DesignDeps, jobId: string): Promise<{ status: string; metrics?: unknown }> {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < deps.pollTimeoutMs) {
        const s = (await deps.runSim.getStatus(jobId, deps.userId)) as { status: string; metrics?: unknown };
        if (s.status === 'SUCCEEDED' || s.status === 'FAILED' || s.status === 'TIMED_OUT' || s.status === 'CANCELED') return s;
        await new Promise((r) => setTimeout(r, pollBackoffMs(attempt++)));
    }
    return { status: 'POLL_TIMEOUT' };
}

// Exported so the multi-candidate orchestrator (stage 2) can run the Monte-Carlo yield pass on the WINNER
// ONLY — the single most important cost lever (1 MC batch/request, never N×300).
export async function runYieldAnalysis(
    deps: DesignDeps,
    circuit: CircuitJson,
    analysis: AnalysisConfig,
    criteria: AcceptanceCriterion[],
): Promise<Record<string, unknown> | undefined> {
    if (!deps.mcEnabled) return undefined;
    if (criteria.length === 0) return undefined;
    const hasTolerance = circuit.components.some(
        (c) => typeof (c as { tolerance?: number }).tolerance === 'number' && ((c as { tolerance?: number }).tolerance ?? 0) > 0,
    );
    if (!hasTolerance) return undefined;

    try {
        const { jobId } = await deps.runSim.createMonteCarloJob(
            circuit,
            analysis as unknown as Record<string, unknown>,
            criteria,
            deps.mcRuns ? { n: deps.mcRuns } : {},
            deps.userId,
        );
        const status = await pollJob(deps, jobId);
        const mc = (status.metrics as { monteCarlo?: { evaluated?: number } } | undefined)?.monteCarlo;
        if (status.status === 'SUCCEEDED' && mc && (mc.evaluated ?? 0) > 0) {
            return {
                ...mc,
                assumptions:
                    'Estimated manufacturing yield: each toleranced component value sampled (Gaussian, ±tolerance) and the acceptance criteria re-checked over the run. Models component-value spread ONLY (not temperature/aging/active-device spread); the 95% CI reflects the run count. NOT a certified production figure.',
            };
        }
        return { available: false, reason: 'yield analysis could not be completed (capacity or no evaluable variants)' };
    } catch {
        return { available: false, reason: 'yield analysis unavailable (simulation capacity)' };
    }
}

/**
 * Manufacturing-robustness tier, layered ON TOP of the nominal verdict — the nominal pass stays the gate, so
 * this NEVER false-fails a correct design; it just labels how robust it is to REAL component tolerances.
 *
 * Graded on the Wilson-95% LOWER bound of the Monte-Carlo yield (honest about how few runs back it — a small
 * MC can't claim 99.99%) against industry capability bars: consumer ≈ Cpk 1.33 (the "capable process" bar,
 * ~99%); automotive/medical ≈ Cpk 1.67 (AIAG PPAP / IATF 16949). The yield models COMPONENT-VALUE spread only
 * (short-term) — it is NOT a long-term-drift-adjusted production figure, and the note says so. Thresholds are
 * DEFAULTS per domain profile and must stay configurable (customer/contract requirements override). Pure.
 */
export type RobustnessTier = 'robust' | 'marginal' | 'at-risk' | 'unknown';

interface RobustnessBars {
    /** Wilson-lower-bound yield at/above which the design is "robust" (production-ready). */
    robustMin: number;
    /** Wilson-lower-bound yield at/above which it is "marginal" (works but below the production bar). */
    marginalMin: number;
}

/** Yield bars per domain — DEFAULTS, configurable; customer/contract requirements override (Cpk 1.33 vs 1.67). */
export const ROBUSTNESS_PROFILES: Record<string, RobustnessBars> = {
    consumer: { robustMin: 0.99, marginalMin: 0.9 }, // general electronics "capable" bar (≈ Cpk 1.33 / 4σ)
    automotive: { robustMin: 0.999, marginalMin: 0.99 }, // safety/critical (≈ Cpk 1.67 / 5σ, AIAG PPAP / IATF 16949)
    medical: { robustMin: 0.999, marginalMin: 0.99 },
};

export interface RobustnessVerdict {
    tier: RobustnessTier;
    /** Which domain profile's bars were applied. */
    profile: string;
    /** Point-estimate yield in [0,1], or null when no Monte-Carlo ran. */
    yield: number | null;
    /** Wilson-95% LOWER bound — the value the tier is graded on (honest re: sample count). */
    yieldLowerBound: number | null;
    /** Monte-Carlo variants actually evaluated. */
    evaluated: number | null;
    /** Plain-language, honest one-liner for the user / AI loop. */
    note: string;
}

/** Classify a yield report (from runYieldAnalysis) into a robustness tier. Pure; no I/O. `unknown` when no MC
 *  ran (no toleranced parts / capacity) — which honestly means "verified at NOMINAL values only". */
export function classifyRobustness(
    yieldReport: Record<string, unknown> | undefined,
    profileName = 'consumer',
): RobustnessVerdict {
    const bars = ROBUSTNESS_PROFILES[profileName] ?? ROBUSTNESS_PROFILES.consumer!;
    const yld = typeof yieldReport?.yield === 'number' ? (yieldReport.yield as number) : null;
    const ci = yieldReport?.ci95 as { low?: number; high?: number } | undefined;
    const lo = typeof ci?.low === 'number' ? ci.low : null;
    const evaluated = typeof yieldReport?.evaluated === 'number' ? (yieldReport.evaluated as number) : null;
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

    if (lo === null) {
        return {
            tier: 'unknown', profile: profileName, yield: yld, yieldLowerBound: null, evaluated,
            note: 'Robustness not assessed (no toleranced parts or no Monte-Carlo) — verified at NOMINAL component values only.',
        };
    }
    const tier: RobustnessTier = lo >= bars.robustMin ? 'robust' : lo >= bars.marginalMin ? 'marginal' : 'at-risk';
    const tail = `(component-tolerance Monte-Carlo, ${evaluated ?? '?'} runs; ~${pct(lo)} is the 95% lower bound; short-term, not long-term-drift-adjusted)`;
    const note =
        tier === 'robust'
            ? `Robust — at least ${pct(bars.robustMin)} of units expected to meet spec under component tolerances ${tail}.`
            : tier === 'marginal'
                ? `Marginal — ~${pct(lo)} expected yield, below the ${pct(bars.robustMin)} production bar. Tighten component tolerances (e.g. ±1% parts) or re-center values ${tail}.`
                : `At risk — only ~${pct(lo)} expected yield; passes at nominal but is NOT production-robust ${tail}.`;
    return { tier, profile: profileName, yield: yld, yieldLowerBound: lo, evaluated, note };
}

function mergeCriteria(
    original: AcceptanceCriterion[],
    fixReturned: AcceptanceCriterion[] | undefined,
    required: Set<SpecDimension>,
): AcceptanceCriterion[] {
    if (!fixReturned?.length) return original;
    const coveredDims = new Set(original.map((c) => criterionDimension(c)));
    const wanted = [...required].filter((d) => !coveredDims.has(d));
    if (wanted.length === 0) return original;
    const key = (c: AcceptanceCriterion) => {
        const p = isCurrentProbe(c.probe) ? `i:${currentKey(c.probe) ?? c.probe.toLowerCase()}` : c.probe;
        return `${p}|${c.metric}|${c.op}|${c.value}`;
    };
    const seen = new Set(original.map(key));
    const merged = [...original];
    for (const c of fixReturned) {
        if (!wanted.includes(criterionDimension(c))) continue;
        if (seen.has(key(c))) continue;
        seen.add(key(c));
        merged.push(c);
    }
    return merged;
}

// ---------------------------------------------------------------------------------------------------------
// Multi-candidate building blocks (stage 1). UNUSED by runDesignLoop — they exist for the stage-2 orchestrator,
// so this stage ships DARK (runDesignLoop is byte-identical). They reuse the SAME eda-core path
// (generateNetlist → summarizeSeries → evaluateAssertions) so the cheap screen sees identical evidence.
// ---------------------------------------------------------------------------------------------------------

/** A spec-closeness score for ranking screened candidates: the summed, target-normalized absolute miss across
 *  the acceptance criteria (LOWER = closer to spec; 0 = dead-on). An unmeasured criterion costs a full unit;
 *  no criteria → Infinity (can't rank). Pure — no I/O; unit-tested. */
export function specCloseness(assertions: AssertionResult[]): number {
    if (assertions.length === 0) return Number.POSITIVE_INFINITY;
    let sum = 0;
    for (const a of assertions) {
        const denom = Math.abs(a.target) > 1e-12 ? Math.abs(a.target) : a.tol && a.tol > 1e-12 ? a.tol : 1;
        sum += a.distance === null ? 1 : Math.abs(a.distance) / denom;
    }
    return sum;
}

/** Screen-stage "spec-met" gate (audit S1). Each screened candidate is graded against its OWN self-written
 *  acceptanceCriteria, so a candidate that LOWBALLS its rubric (omits a current/frequency criterion the
 *  prompt demanded) would otherwise show specsMet=true and crowd a thorough candidate out of a finalist slot.
 *  Apply the SAME coverage gate the finalist loop already enforces: a candidate is spec-met only if every
 *  assertion passes AND no prompt-required, enforceable dimension is left unmeasured. Derives required
 *  dimensions from the ORIGINAL prompt (never the per-candidate directive-augmented constraints, which could
 *  distort detection). Deterministic — no extra LLM/sim call. The finalist-stage gate (uncovered → not
 *  verified) remains the backstop; this only fixes the screen RANKING, and composes under S2's robustness
 *  ordering (which runs only among coverage-complete passers). */
export function screenSpecsMet(assertions: AssertionResult[], prompt: string, criteria: AcceptanceCriterion[]): boolean {
    if (assertions.length === 0 || !assertions.every((a) => a.pass)) return false;
    return uncoveredRequiredDimensions(prompt, criteria).length === 0;
}

/** The result of screening ONE candidate: generated + simulated ONCE (no fix loop, no Monte-Carlo). */
export interface ScreenResult {
    circuit: CircuitJson;
    analysisConfig: AnalysisConfig;
    explanation?: string;
    acceptanceCriteria: AcceptanceCriterion[];
    assertions: AssertionResult[];
    /** SUCCEEDED with >0 points — the sim produced usable evidence. */
    simHealthy: boolean;
    pointsCount: number;
    /** Every acceptance criterion passed on the FIRST shot (rare; most need a fix round). */
    specsMet: boolean;
    /** specCloseness over the assertions; Infinity when the sim wasn't healthy (can't score). */
    closeness: number;
    simStatus: string;
}

/**
 * Generate ONE candidate and simulate it ONCE — no AI-fix loop, no Monte-Carlo. The cheap Stage-1 screen of
 * the multi-candidate plan: cost ≈ one LLM request + one nominal sim. `deps.llmConfig.temperature` (set by the
 * orchestrator per candidate) drives topology diversity. Never throws — a generation/sim failure returns a
 * not-simHealthy result with closeness = Infinity (it sorts last). Mirrors runDesignLoop's round-1 evidence
 * path exactly, minus the fix/MC stages.
 */
export async function screenCandidate(input: DesignLoopInput, deps: DesignDeps): Promise<ScreenResult> {
    const groundingOpts = deps.ground.grounding();
    const gen = await generateCircuit(
        { prompt: input.prompt, constraints: input.constraints },
        deps.llmConfig,
        groundingOpts as Parameters<typeof generateCircuit>[2],
    );
    const circuit: CircuitJson = gen.circuit;
    attachGenericModels(circuit);
    const analysis: AnalysisConfig = gen.analysisConfig;
    const criteria = (gen.acceptanceCriteria ?? []) as AcceptanceCriterion[];
    const currentProbes = criteria.filter((c) => isCurrentProbe(c.probe)).map((c) => c.probe);

    let assertions: AssertionResult[] = [];
    let simHealthy = false;
    let pointsCount = 0;
    let simStatus = 'UNKNOWN';
    try {
        const netlist = generateNetlist(circuit, analysis, currentProbes.length ? { extraProbes: currentProbes } : {});
        const { jobId } = await deps.runSim.createQuickSim(netlist, analysis as unknown as Record<string, unknown>, deps.userId);
        const status = await pollJob(deps, jobId);
        simStatus = status.status;
        const result = (await deps.runSim.getResult(jobId, deps.userId)) as {
            result?: { meta?: { pointsCount?: number }; series?: DataSeries[]; fourier?: FourierResult[]; transferFunction?: TransferFunctionResult };
            metrics?: { pointsCount?: number };
        };
        const statusMetrics = status.metrics as { pointsCount?: number } | undefined;
        pointsCount = statusMetrics?.pointsCount ?? result?.metrics?.pointsCount ?? result?.result?.meta?.pointsCount ?? 0;
        simHealthy = status.status === 'SUCCEEDED' && pointsCount > 0;
        if (simHealthy && criteria.length > 0) {
            const measurements = (result.result?.series ?? []).map((s) => summarizeSeries(s, analysis.type));
            attachFourierThd(measurements, result.result?.fourier);
            attachTransferFunction(measurements, result.result?.transferFunction);
            assertions = evaluateAssertions(measurements, criteria);
        }
    } catch {
        // a screen sim/infra failure → not healthy; closeness Infinity → this candidate sorts last.
    }

    return {
        circuit,
        analysisConfig: analysis,
        explanation: gen.explanation,
        acceptanceCriteria: criteria,
        assertions,
        simHealthy,
        pointsCount,
        specsMet: screenSpecsMet(assertions, input.prompt, criteria),
        closeness: simHealthy ? specCloseness(assertions) : Number.POSITIVE_INFINITY,
        simStatus,
    };
}

/** "Real" part count (a cheap cost proxy) — excludes ground symbols. */
function partCount(c: CircuitJson): number {
    return c.components.filter((x) => x.type !== 'ground').length;
}

/** A coarse topology signature for dedup: the sorted component-type multiset + net count. Two screened
 *  candidates with the same signature are treated as the same topology (values may differ). Not a true
 *  graph isomorphism — a pragmatic "don't spend a finalist slot on a near-duplicate" guard. */
function topologyKey(c: CircuitJson): string {
    return `${c.components.map((x) => x.type).sort().join(',')}|${c.nets.length}`;
}

/** Worst-case op-aware ROBUSTNESS margin of a spec-met candidate: the MINIMUM normalized slack across its
 *  criteria (a design is only as robust as its tightest spec). Higher = more headroom before any spec fails
 *  under component tolerance. Used ONLY to order spec-met candidates, because specCloseness is BACKWARDS for
 *  them — it scores |actual−target|, so an inequality spec satisfied with a WIDE margin (the safer design)
 *  looks "far from spec" and would lose, sending winner-only Monte-Carlo to the most MARGINAL passer. Empty /
 *  uncomputable criteria contribute 0 (neutral). Pure — reuses the same denom as specCloseness. */
function robustnessSlack(assertions: AssertionResult[]): number {
    let min = Number.POSITIVE_INFINITY;
    for (const a of assertions) {
        if (a.distance === null) { min = Math.min(min, 0); continue; }
        const denom = Math.abs(a.target) > 1e-12 ? Math.abs(a.target) : a.tol && a.tol > 1e-12 ? a.tol : 1;
        let slack: number;
        switch (a.op) {
            case 'gt':
            case 'gte':
                slack = a.distance / denom; // actual − target ≥ 0 for a passer; bigger = further above the floor
                break;
            case 'lt':
            case 'lte':
                slack = -a.distance / denom; // actual − target ≤ 0 for a passer; bigger = further below the ceiling
                break;
            case 'approx': {
                const tol = a.tol && a.tol > 1e-12 ? a.tol : Math.max(Math.abs(a.target) * 0.05, 1e-9);
                slack = (tol - Math.abs(a.distance)) / denom; // distance from the NEAREST band edge; bigger = more centered
                break;
            }
            default:
                slack = 0;
        }
        min = Math.min(min, slack);
    }
    return Number.isFinite(min) ? min : 0; // no criteria → neutral
}

/** Ranking comparator: better candidate sorts FIRST. simulating beats non-simulating (a clean-but-off-spec
 *  candidate is worth a finalist slot over one that won't simulate); then spec-met; then — among spec-met
 *  candidates — MORE ROBUST first (specCloseness is backwards for passers, see robustnessSlack); else closer
 *  to spec (closeness is correct for the not-both-met case: lower |distance| = closer to passing); then fewer
 *  parts (cost). NOTE: robustness is deliberately ranked ABOVE part count for passers — we'd rather ship a
 *  slightly larger design with real tolerance headroom than a marginal one. Returns <0 if a is better. */
function compareCandidates(a: ScreenResult, b: ScreenResult): number {
    if (a.simHealthy !== b.simHealthy) return a.simHealthy ? -1 : 1;
    if (a.specsMet !== b.specsMet) return a.specsMet ? -1 : 1;
    if (a.specsMet && b.specsMet) {
        const bySlack = robustnessSlack(b.assertions) - robustnessSlack(a.assertions);
        if (bySlack !== 0) return bySlack; // higher slack (more robust) sorts first
    } else if (a.closeness !== b.closeness) {
        return a.closeness - b.closeness;
    }
    return partCount(a.circuit) - partCount(b.circuit);
}

/**
 * Pick the best K screened candidates for the full fix-loop. Dedups identical topologies first (keeping the
 * better-scoring of each), then ranks by compareCandidates and takes the top K (≥1). Pure — no I/O; the
 * Stage-2 orchestrator runs the full runDesignLoop on exactly these, then Monte-Carlo on the single winner.
 */
export function selectFinalists(screened: ScreenResult[], k: number): ScreenResult[] {
    const best = new Map<string, ScreenResult>();
    for (const cand of screened) {
        const key = topologyKey(cand.circuit);
        const prev = best.get(key);
        if (!prev || compareCandidates(cand, prev) < 0) best.set(key, cand);
    }
    return [...best.values()].sort(compareCandidates).slice(0, Math.max(1, k));
}
