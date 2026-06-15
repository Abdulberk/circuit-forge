/**
 * Pure job-outcome decision logic for the simulation processor.
 *
 * Kept free of Prisma / BullMQ / Redis so the retry-vs-terminal decision matrix is unit-testable in
 * isolation. The processor consumes these to decide whether to retry an infra failure, terminate a
 * genuine sim fault, or persist a success — and crucially, WHEN it is safe to write a terminal FAILED
 * row (only on the last attempt, so an API poll mid-retry never grabs a transient FAILED and reports
 * a premature "inconclusive").
 */

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
