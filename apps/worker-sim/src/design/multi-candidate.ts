/**
 * Multi-candidate design orchestrator — the performance-critical fan-out (per the vetted plan).
 *
 * Instead of one generate→fix→MC chain, generate N DIVERSE candidates (varied temperature), SCREEN each with
 * one cheap nominal sim (no fix, no MC), keep the best K, run the FULL fix-loop on only those K (seeded so
 * they don't re-generate), and run Monte-Carlo on the WINNER ONLY. The cost levers that keep this bounded:
 *   - MC on the winner only          → 1 MC batch/request, never N×300.
 *   - full fix-loop on K finalists    → fix-round tokens decoupled from N.
 *   - process-global ngspice/LLM sems → peak concurrent ngspice/LLM fixed regardless of N (see ./pools).
 *   - seeded finalists                → no second generate per finalist (DesignLoopInput.seedCircuit).
 *   - per-request LLM-call budget      → a hard ceiling on paid requests.
 *
 * N=1 (the default) degenerates to a single runDesignLoop — byte-identical to the pre-multi-candidate path,
 * so the feature ships DARK and is enabled by config.
 */
import { withCheck } from '@circuit-forge/eda-core';
import {
    runDesignLoop,
    screenCandidate,
    selectFinalists,
    runYieldAnalysis,
    classifyRobustness,
    robustnessScopeEntry,
    type DesignDeps,
    type DesignLoopInput,
    type DesignResult,
    type ScreenResult,
} from '@circuitforge/llm-core';

import { logger } from '../logger';

import { llmSem } from './pools';

export interface MultiCandidateOptions {
    /** Candidates to generate+screen (clamped 1..MAX_CANDIDATES). */
    n: number;
    /** Finalists that get the full fix-loop. */
    k: number;
    /** Hard ceiling on paid LLM requests for the whole design request. */
    llmBudget: number;
}

const MAX_CANDIDATES = 5;

/** Per-candidate topology directives appended to the prompt to drive DIVERSITY. Prompt-based (not temperature
 *  — Opus 4.8 rejects the `temperature` param with a 400), so it is model-agnostic. The first is empty
 *  (baseline = the model's natural first choice); the rest nudge distinct topology families. For a trivial
 *  circuit they may converge (dedup handles that); for richer designs they diverge. */
const TOPOLOGY_DIRECTIVES = [
    '',
    'Prefer the simplest topology with the fewest components.',
    'Prefer a discrete-component implementation (avoid op-amps / ICs) where reasonable.',
    'Prefer an op-amp / active implementation where it improves the design.',
    'Prefer a topology that is robust to component-value tolerance.',
];

/** N directive strings (clamped to the bank size). */
function candidateDirectives(n: number): string[] {
    return TOPOLOGY_DIRECTIVES.slice(0, Math.max(1, n));
}

/** A bounded, series-free summary of a non-winning finalist (keeps the persisted row small — review #6). */
function summarizeAlternative(r: DesignResult): Record<string, unknown> {
    const assertions = r.assertions ?? [];
    return {
        circuit: r.circuit, // the circuit is small; the heavy part is the waveform series, which we DROP here
        ok: r.ok,
        verified: r.verified ?? false,
        rounds: r.rounds,
        simStatus: r.simulation?.status,
        assertionsPassed: assertions.filter((a) => a.pass).length,
        assertionsTotal: assertions.length,
        ...(r.warning ? { warning: r.warning } : {}),
    };
}

/** Pick the winner among the finalized full-loop results. Finalists are already rank-ordered (best first),
 *  so the first that VERIFIED wins; else the first that's ok; else the best-ranked. */
function pickWinner(finalized: DesignResult[]): DesignResult {
    return finalized.find((r) => r.ok && r.verified) ?? finalized.find((r) => r.ok) ?? finalized[0]!;
}

export async function runMultiCandidateDesign(
    input: DesignLoopInput,
    deps: DesignDeps,
    opts: MultiCandidateOptions,
): Promise<DesignResult> {
    const n = Math.max(1, Math.min(opts.n, MAX_CANDIDATES));

    // N=1 → the exact pre-multi-candidate path (DARK).
    if (n <= 1) return runDesignLoop(input, deps);

    const budget = Math.max(n, opts.llmBudget); // never below N (must afford one generate per candidate)
    let llmCalls = 0;

    // --- Stage 1: generate + screen N diverse candidates in parallel (bounded by the global LLM semaphore) ---
    // Diversity via per-candidate PROMPT directives (not temperature — Opus 4.8 rejects that param).
    const directives = candidateDirectives(n);
    const screenedRaw = await Promise.allSettled(
        directives.map((directive) =>
            llmSem.run(async () => {
                if (llmCalls >= budget) return null;
                llmCalls++;
                const candInput: DesignLoopInput = directive
                    ? { ...input, constraints: [input.constraints, directive].filter(Boolean).join(' ') }
                    : input;
                return screenCandidate(candInput, deps);
            }),
        ),
    );
    const screened = screenedRaw
        .map((r, i) => {
            if (r.status === 'fulfilled') return r.value;
            // A candidate whose generation/screen threw (provider error, bad output) — log it so a low survival
            // rate (the fan-out not actually getting N candidates) is visible, not silently swallowed.
            logger.warn(
                {
                    candidate: i,
                    directive: directives[i],
                    reason: r.reason instanceof Error ? r.reason.message : String(r.reason),
                },
                'multi-candidate: a candidate screen failed',
            );
            return null;
        })
        .filter((v): v is ScreenResult => v !== null);

    // Every candidate failed to even generate (provider down) → fall back to one normal loop (honest single attempt).
    if (screened.length === 0) {
        logger.warn({ n }, 'multi-candidate: all screens failed — falling back to a single design loop');
        return runDesignLoop(input, deps);
    }

    // --- Stage 2: pick the best K finalists (pure rank + topology dedup) ---
    const finalists = selectFinalists(screened, opts.k);

    // --- Stage 3: full fix-loop on each finalist, SEQUENTIALLY, SEEDED (no re-generate), MC OFF ---
    const finalized: DesignResult[] = [];
    for (const f of finalists) {
        if (llmCalls >= budget) break;
        const seededInput: DesignLoopInput = {
            ...input,
            seedCircuit: f.circuit,
            seedAnalysisConfig: f.analysisConfig,
            seedCriteria: f.acceptanceCriteria,
            seedExplanation: f.explanation,
        };
        // mcEnabled:false → the per-finalist loop never runs Monte-Carlo; MC runs ONCE on the winner (Stage 4).
        const r = await runDesignLoop(seededInput, { ...deps, mcEnabled: false });
        // Each fix round after the seed is one paid request (round 1 is the seed → no generate).
        llmCalls += Math.max(0, r.rounds - 1);
        finalized.push(r);
    }

    // If somehow no finalist ran (budget already spent) — degrade to the best-screened candidate as a result.
    if (finalized.length === 0)
        return runDesignLoop(
            {
                ...input,
                seedCircuit: finalists[0]!.circuit,
                seedAnalysisConfig: finalists[0]!.analysisConfig,
                seedCriteria: finalists[0]!.acceptanceCriteria,
            },
            { ...deps, mcEnabled: false },
        );

    // --- Stage 4: Monte-Carlo yield on the WINNER ONLY ---
    const winner = pickWinner(finalized);
    let yieldReport: Record<string, unknown> | undefined;
    if (winner.ok) {
        yieldReport = await runYieldAnalysis(
            deps,
            winner.circuit,
            winner.analysisConfig,
            winner.acceptanceCriteria ?? [],
        );
    }

    logger.info(
        {
            n,
            screened: screened.length,
            finalists: finalized.length,
            llmCalls,
            winnerOk: winner.ok,
            winnerVerified: winner.verified ?? false,
        },
        'multi-candidate design complete',
    );

    // Winner keeps its full result (incl. waveform series); alternatives are series-free summaries (#6 row-bound).
    // Re-classify robustness from the winner-only MC just run (the per-finalist loops ran MC-off → 'unknown').
    const robustness = classifyRobustness(yieldReport, deps.robustnessProfile);
    return {
        ...winner,
        ...(yieldReport ? { yield: yieldReport } : {}),
        robustness,
        // The winner's manifest was written by a loop that ran with Monte-Carlo OFF, so it states that
        // robustness did not run — while the verdict directly above it now says it did. Spreading the winner
        // unchanged would ship those two side by side and let the disclosure contradict the result it
        // describes. Restate exactly the one check this stage changed, and nothing else.
        ...(winner.scope ? { scope: withCheck(winner.scope, 'robustness', robustnessScopeEntry(robustness)) } : {}),
        candidates: { generated: screened.length, finalists: finalized.length, llmCalls },
        alternatives: finalized.filter((r) => r !== winner).map(summarizeAlternative),
    };
}
