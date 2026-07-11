/**
 * Pure job-outcome decision logic for the simulation processor.
 *
 * Kept free of Prisma / BullMQ / Redis so the retry-vs-terminal decision matrix is unit-testable in
 * isolation. The processor consumes these to decide whether to retry an infra failure, terminate a
 * genuine sim fault, or persist a success — and crucially, WHEN it is safe to write a terminal FAILED
 * row (only on the last attempt, so an API poll mid-retry never grabs a transient FAILED and reports
 * a premature "inconclusive"). It ALSO owns the terminal-status decision and the shape of the metrics
 * blob, so the three writers (queue handleSuccess/handleFailure + the inline local-sim) can't drift.
 */
import type { ConvergenceReport } from '@circuit-forge/eda-core';

/** Minimal shape of the runner result the decision depends on (the full type lives in runner.ts). */
export interface OutcomeInput {
    success: boolean;
    result?: unknown;
    /** True ⇒ INFRASTRUCTURE failure (ngspice couldn't launch / fs blip) — recoverable by a retry.
     *  False/undefined on a non-success ⇒ a genuine, deterministic simulation fault — terminal. */
    infra?: boolean;
}

export type JobAction =
    /** ngspice ran and produced a result — persist it (handleSuccess), return normally. */
    | { type: 'success' }
    /** Genuine simulation fault (ngspice ran, rejected the circuit, or timed out): persist terminal
     *  FAILED+sim and RETURN normally — never retried, re-running a bad deck is pointless. */
    | { type: 'fault' }
    /** Infra failure with retries remaining: DO NOT persist a terminal status (leave the row RUNNING so
     *  a poll keeps waiting); THROW so BullMQ schedules the retry. */
    | { type: 'retry' }
    /** Infra failure on the FINAL attempt: persist terminal FAILED+infra (rich), THEN throw so BullMQ
     *  finalizes the job as failed. The API maps FAILED+infra → 'inconclusive', not a design failure. */
    | { type: 'terminal-infra' };

/**
 * Is the attempt currently executing the LAST one BullMQ will run?
 *
 * BullMQ (v5) increments `attemptsMade` only AFTER the processor finishes, and retries while
 * `attemptsMade + 1 < attempts` (see Job.shouldRetryJob). So inside the processor the current attempt
 * is final exactly when `attemptsMade + 1 >= attempts`. With `attempts` undefined (a job enqueued
 * before retries were configured) it defaults to 1 → always final → behaves exactly like the no-retry
 * past: terminate immediately, never retry.
 */
export function isFinalAttempt(attemptsMade: number, attempts?: number): boolean {
    return attemptsMade + 1 >= (attempts ?? 1);
}

/**
 * Map a runner result + attempt position to the action the processor must take.
 * Mirrors the original `result.success && result.result` success test exactly.
 */
export function classifyJobOutcome(result: OutcomeInput, finalAttempt: boolean): JobAction {
    if (result.success && result.result) return { type: 'success' };
    // A genuine sim fault carries infra=false/undefined → terminal, never retried.
    if (!result.infra) return { type: 'fault' };
    // Infra failure: retry while attempts remain, else terminate.
    return finalAttempt ? { type: 'terminal-infra' } : { type: 'retry' };
}

/** Terminal DB status a job resolves to (subset of Prisma's SimJobStatus we ever WRITE from a finished run). */
export type TerminalJobStatus = 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';

/**
 * Terminal status for a NON-successful runner result, from the runner's TYPED flags.
 *
 * NOT a string-match on the error message: `error.includes('timed out')` silently breaks the moment the timeout
 * message is reworded, and MISFIRES if a genuine ngspice error text happens to contain the substring. The runner
 * sets `timedOut:true` exactly when it SIGKILLs ngspice at the wall-clock SIM_TIMEOUT_MS, so that flag is the
 * authoritative signal. A wall-clock timeout → TIMED_OUT (the API maps it distinctly); every other real fault →
 * FAILED. Infra failures are FAILED at the enum level and re-tagged via metrics.failureClass, not here.
 */
export function deriveFailureStatus(result: { infra?: boolean; timedOut?: boolean; error?: string }): 'TIMED_OUT' | 'FAILED' {
    // Decided from infra + timedOut ONLY — `error` is deliberately ignored (matching the string it once matched
    // on is exactly the fragility this removes). Accepting it in the shape lets callers pass the whole result.
    return !result.infra && result.timedOut ? 'TIMED_OUT' : 'FAILED';
}

/**
 * The metrics blob persisted on SimulationJob.metrics (and mirrored into the local-sim store). Naming the shape
 * keeps the writers from drifting — it was previously an untyped `Prisma.Json` object literal in each place.
 * Every field is optional because success and failure write DISJOINT subsets; the builders assemble each subset.
 */
export interface SimJobMetrics {
    runtimeMs?: number;
    /** Present on failure — the distilled ngspice error. */
    error?: string;
    /** 'infra' = ngspice never ran / setup blip (API → 'inconclusive'); 'sim' = a genuine circuit fault. */
    failureClass?: 'infra' | 'sim';
    /** RAW ngspice output bytes (diagnostic; the SIM_MAX_OUTPUT_BYTES guard's unit). */
    outputSizeBytes?: number;
    /** Bytes ACTUALLY persisted (downsampled + serialized / the S3 object size) — the storage-quota unit. */
    storedResultBytes?: number;
    /** TRUE simulated resolution, before the WORKER_MAX_POINTS display cap. */
    pointsCount?: number;
    /** Convergence Doctor report (remedy-ladder outcome), present when the ladder ran. */
    convergence?: ConvergenceReport;
}

/** Failure metrics subset (queue handleFailure): failureClass follows infra, convergence rides along when the
 *  remedy ladder ran. Pure — no Prisma — so it is unit-testable in isolation. */
export function buildFailureMetrics(result: { runtimeMs?: number; error?: string; infra?: boolean; convergence?: ConvergenceReport }): SimJobMetrics {
    return {
        runtimeMs: result.runtimeMs,
        error: result.error,
        failureClass: result.infra ? 'infra' : 'sim',
        ...(result.convergence ? { convergence: result.convergence } : {}),
    };
}

/** Success metrics subset (queue handleSuccess). The byte/point counts are computed by the caller AFTER the
 *  WORKER_MAX_POINTS downsample + optional S3 spill, so they are passed in. Pure/testable. `storedResultBytes`
 *  is the storage-quota unit (must be the PERSISTED size, not the raw ngspice size — see UsageService). */
export function buildSuccessMetrics(m: {
    runtimeMs: number;
    outputSizeBytes?: number;
    storedResultBytes: number;
    pointsCount?: number;
    convergence?: ConvergenceReport;
}): SimJobMetrics {
    return {
        runtimeMs: m.runtimeMs,
        ...(m.outputSizeBytes !== undefined ? { outputSizeBytes: m.outputSizeBytes } : {}),
        storedResultBytes: m.storedResultBytes,
        ...(m.pointsCount !== undefined ? { pointsCount: m.pointsCount } : {}),
        ...(m.convergence ? { convergence: m.convergence } : {}),
    };
}
