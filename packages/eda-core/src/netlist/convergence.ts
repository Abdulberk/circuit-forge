/**
 * Convergence Doctor — turn ngspice's cryptic non-convergence failures into a diagnosis + an
 * automatic remedy ladder.
 *
 * Every integrated simulator's #1 abandonment reason is "it just says 'Timestep too small' and dies".
 * ngspice fails to converge on perhaps ~5% of real circuits with no actionable message. This module
 * (a) CLASSIFIES the failure into a plain-language explanation, and (b) provides an ordered ladder of
 * SOLVER REMEDIES (standard ngspice convergence aids, expressed through the SolverOptions levers the
 * generator already emits as a `.options` card) for the caller to retry with. Pure + deterministic.
 *
 * Lives in eda-core so BOTH the inline API simulator (dev) and the WORKER (prod) run the identical
 * ladder — the worker applies each step with applySolverOptions() (solver-options.ts) on the netlist
 * string it holds, re-running ngspice locally (no queue round-trip per remedy).
 */
import type { AnalysisConfig } from '../types/analysis';

/** The solver-tuning levers the generator emits as a `.options` card. Derived from the public
 *  AnalysisConfig so it stays in sync without a separate named export. */
export type SolverOptions = NonNullable<AnalysisConfig['options']>;

export type ConvergenceKind =
    | 'timestep_collapse' // transient adaptive timestep shrank to nothing (stiff / hard edge / floating node)
    | 'iteration_limit' // hit the per-step Newton iteration cap
    | 'singular_matrix' // conductance matrix singular — usually a floating node / no DC path to ground
    | 'no_convergence' // generic "couldn't find a solution"
    | 'no_output' // exited without producing data — often a degenerate / non-converging run
    | 'none'; // not a convergence-class failure (or didn't fail)

export interface ConvergenceDiagnosis {
    kind: ConvergenceKind;
    /** True when this looks like a numerical-convergence problem solver remedies can plausibly help. */
    isConvergence: boolean;
    /** Plain-language explanation suitable for a user or the AI loop. */
    explanation: string;
}

export interface RemedyStep {
    label: string;
    rationale: string;
    options: SolverOptions;
}

/** Convergence Doctor report — present when a run hit a convergence-class failure and remedies were
 *  tried. Produced by the inline simulator AND the worker; surfaced on the verify-design evidence. */
export interface ConvergenceReport {
    /** True if a solver remedy turned the failing run into a successful one. */
    recovered: boolean;
    kind: ConvergenceKind;
    /** Plain-language explanation of the original convergence failure. */
    diagnosis: string;
    /** The remedy label that worked (recovered) — and why it helped. */
    remedyApplied?: string;
    rationale?: string;
    /** How many remedies were actually attempted (excludes ones skipped for capacity). */
    attempts: number;
    /** Labels of every remedy actually run (set when none recovered the run). */
    triedRemedies?: string[];
    /** Set when the ladder was cut short (e.g. inline-sim capacity saturated) — not a true exhaustion. */
    note?: string;
}

/** Patterns → kind. Ordered most-specific first; matched against the (already distilled) error text. */
const PATTERNS: { re: RegExp; kind: Exclude<ConvergenceKind, 'none'> }[] = [
    { re: /timestep too small|timestep collapse|time step too small/i, kind: 'timestep_collapse' },
    { re: /singular matrix|matrix is singular/i, kind: 'singular_matrix' },
    { re: /too many iterations|iteration limit/i, kind: 'iteration_limit' },
    // NOTE: only genuine convergence phrasings here. NOT a bare "unable to find" — ngspice says
    // "unable to find definition of model X" for a MISSING MODEL (a netlist error remedies can't fix);
    // we only want "unable to converge" / "unable to find dc operating point".
    {
        re: /no convergence|failed to converge|convergence (problem|failure)|unable to converge|unable to find (a |the )?dc/i,
        kind: 'no_convergence',
    },
    { re: /no output|produced no output|degenerate/i, kind: 'no_output' },
];

const EXPLANATION: Record<Exclude<ConvergenceKind, 'none'>, string> = {
    timestep_collapse:
        "The transient solver's adaptive timestep collapsed toward zero — the circuit is stiff, has a very hard switching edge, or a near-floating node. Trying more iterations, gear integration, and a little extra gmin.",
    iteration_limit:
        'ngspice hit its per-step Newton iteration limit before settling — common on stiff or strongly nonlinear circuits. Raising the iteration limit and relaxing tolerances.',
    singular_matrix:
        'The conductance matrix is singular — almost always a floating node or a section with no DC path to ground. Adding gmin (a tiny conductance to ground) often resolves it; also check that every node has a DC return path.',
    no_convergence:
        'ngspice could not find a solution at the default accuracy. Relaxing tolerances and adding gmin usually lets it converge (slightly less precise, but a real answer).',
    no_output:
        'The run produced no usable data — typically a non-converging or degenerate operating point. Adding gmin and relaxing tolerances often produces a solvable circuit.',
};

/**
 * Classify an ngspice failure message (the distilled runError) for a given analysis type.
 * Returns kind 'none' / isConvergence false when it is not a convergence-class failure (a bad netlist,
 * a timeout, an output-too-large, etc. — solver remedies won't help those).
 */
export function diagnoseConvergence(errorText: string | undefined, _analysisType?: string): ConvergenceDiagnosis {
    const text = errorText ?? '';
    for (const { re, kind } of PATTERNS) {
        if (re.test(text)) {
            return { kind, isConvergence: true, explanation: EXPLANATION[kind] };
        }
    }
    return { kind: 'none', isConvergence: false, explanation: '' };
}

/**
 * An ordered ladder of solver remedies to retry with, escalating in aggressiveness. Each step's
 * options are MERGED over the caller's existing analysis options. The first that yields a converged
 * run wins. Tuned per analysis family: transient leans on iteration-limit + integration method;
 * op/dc lean on gmin + tolerance relaxation. All levers are ones the generator already emits.
 */
export function convergenceRemedyLadder(analysisType?: string): RemedyStep[] {
    const isTransient = analysisType === 'tran';
    const ladder: RemedyStep[] = [];

    if (isTransient) {
        ladder.push({
            label: 'raise transient iteration limit + gmin',
            rationale:
                'Gives the per-step solver more Newton iterations and a small conductance floor — the usual fix for a collapsing timestep.',
            options: { itl4: 500, gmin: '1e-10' },
        });
        ladder.push({
            label: 'gear integration + relaxed tolerances',
            rationale:
                'The Gear method damps numerical ringing on stiff circuits; relaxed reltol/vntol let it accept a slightly less precise but real solution.',
            options: { method: 'gear', itl4: 1000, reltol: '1e-2', vntol: '1e-4' },
        });
    } else {
        ladder.push({
            label: 'add gmin',
            rationale:
                'A tiny conductance to ground removes a singular/near-singular matrix from a floating or high-impedance node.',
            options: { gmin: '1e-9' },
        });
        ladder.push({
            label: 'relaxed tolerances + gmin',
            rationale:
                'Relaxing reltol/abstol/vntol lets the operating-point solver accept a slightly less precise but real solution.',
            options: { gmin: '1e-9', reltol: '1e-2', abstol: '1e-9', vntol: '1e-4' },
        });
    }

    // Final, most-aggressive step shared by both: everything relaxed at once.
    ladder.push({
        label: 'aggressive relaxation (last resort)',
        rationale:
            'Combines a higher gmin, relaxed tolerances, and a raised iteration limit — the broadest convergence aid before giving up.',
        options: {
            gmin: '1e-8',
            reltol: '5e-2',
            abstol: '1e-8',
            vntol: '1e-3',
            itl4: 1000,
            ...(isTransient ? { method: 'gear' as const } : {}),
        },
    });

    return ladder;
}
