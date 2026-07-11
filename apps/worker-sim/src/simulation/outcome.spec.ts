import { classifyJobOutcome, isFinalAttempt, deriveFailureStatus, buildFailureMetrics, buildSuccessMetrics, type OutcomeInput } from './outcome';

describe('isFinalAttempt', () => {
    it('treats a single-attempt job (attempts=1) as final on the first run', () => {
        expect(isFinalAttempt(0, 1)).toBe(true);
    });

    it('is NOT final on the first or middle attempt of a multi-attempt job', () => {
        expect(isFinalAttempt(0, 3)).toBe(false); // 1st of 3
        expect(isFinalAttempt(1, 3)).toBe(false); // 2nd of 3
    });

    it('is final on the last attempt of a multi-attempt job', () => {
        expect(isFinalAttempt(2, 3)).toBe(true); // 3rd of 3
    });

    it('defaults attempts=undefined to a single (final) attempt — legacy no-retry behaviour', () => {
        expect(isFinalAttempt(0, undefined)).toBe(true);
    });

    it('is defensively final if attemptsMade somehow exceeds attempts', () => {
        expect(isFinalAttempt(5, 3)).toBe(true);
    });

    it('matches BullMQ retry pivot: retries while attemptsMade+1 < attempts, final otherwise', () => {
        const attempts = 3;
        // BullMQ retries when attemptsMade + 1 < attempts; isFinalAttempt is the negation.
        for (let made = 0; made < 6; made++) {
            expect(isFinalAttempt(made, attempts)).toBe(!(made + 1 < attempts));
        }
    });
});

describe('classifyJobOutcome', () => {
    const ok: OutcomeInput = { success: true, result: { series: [] } };

    it('SUCCESS: a successful run with a result → success (regardless of attempt position)', () => {
        expect(classifyJobOutcome(ok, true)).toEqual({ type: 'success' });
        expect(classifyJobOutcome(ok, false)).toEqual({ type: 'success' });
    });

    it('SUCCESS guard: success:true but no result is NOT a success → terminal fault', () => {
        expect(classifyJobOutcome({ success: true, result: undefined }, false)).toEqual({ type: 'fault' });
    });

    it('SIM FAULT: a genuine sim fault (infra=false) is terminal and NEVER retried, even mid-run', () => {
        const fault: OutcomeInput = { success: false, infra: false };
        expect(classifyJobOutcome(fault, false)).toEqual({ type: 'fault' }); // retries remain, still terminal
        expect(classifyJobOutcome(fault, true)).toEqual({ type: 'fault' }); // final attempt
    });

    it('SIM FAULT: a non-success with infra undefined is treated as a (terminal) sim fault', () => {
        expect(classifyJobOutcome({ success: false }, false)).toEqual({ type: 'fault' });
    });

    it('INFRA + retries remain → retry (do not persist a terminal status yet)', () => {
        expect(classifyJobOutcome({ success: false, infra: true }, false)).toEqual({ type: 'retry' });
    });

    it('INFRA + final attempt → terminal-infra (persist FAILED+infra, then fail the job)', () => {
        expect(classifyJobOutcome({ success: false, infra: true }, true)).toEqual({ type: 'terminal-infra' });
    });

    it('lifecycle: an infra failure retries across attempts then terminates on the last', () => {
        const infra: OutcomeInput = { success: false, infra: true };
        const attempts = 3;
        const actions = [0, 1, 2].map((made) => classifyJobOutcome(infra, isFinalAttempt(made, attempts)).type);
        expect(actions).toEqual(['retry', 'retry', 'terminal-infra']);
    });

    it('lifecycle: a sim fault terminates immediately and is never retried', () => {
        const fault: OutcomeInput = { success: false, infra: false };
        const attempts = 3;
        const actions = [0, 1, 2].map((made) => classifyJobOutcome(fault, isFinalAttempt(made, attempts)).type);
        expect(actions).toEqual(['fault', 'fault', 'fault']);
    });
});

describe('deriveFailureStatus — TIMED_OUT from the TYPED flag, not an error-string match (debt #4)', () => {
    it('a genuine wall-clock timeout (timedOut:true) → TIMED_OUT', () => {
        expect(deriveFailureStatus({ timedOut: true })).toBe('TIMED_OUT');
        expect(deriveFailureStatus({ timedOut: true, error: 'Simulation timed out' })).toBe('TIMED_OUT');
    });

    it('any other genuine sim fault (no timedOut) → FAILED', () => {
        expect(deriveFailureStatus({})).toBe('FAILED');
        expect(deriveFailureStatus({ error: 'singular matrix' })).toBe('FAILED');
        expect(deriveFailureStatus({ timedOut: false })).toBe('FAILED');
    });

    it('an INFRA failure is FAILED even if it timed out (re-tagged via metrics.failureClass, not the enum)', () => {
        expect(deriveFailureStatus({ infra: true, timedOut: true })).toBe('FAILED');
    });

    it('THE FRAGILITY FIX: a real fault whose error text happens to contain "timed out" is NOT misread as TIMED_OUT', () => {
        // The old `error.includes('timed out')` would wrongly return TIMED_OUT here; the typed flag does not.
        expect(deriveFailureStatus({ timedOut: false, error: 'model note: the driver timed out earlier; matrix singular' })).toBe('FAILED');
    });

    it('robust to a reworded timeout message: still TIMED_OUT via the flag even if the string changes', () => {
        expect(deriveFailureStatus({ timedOut: true, error: 'wall-clock budget exceeded' })).toBe('TIMED_OUT');
    });
});

describe('buildFailureMetrics — the failure subset of the metrics contract', () => {
    it('tags failureClass=sim for a circuit fault and carries runtimeMs + error', () => {
        expect(buildFailureMetrics({ runtimeMs: 42, error: 'boom', infra: false }))
            .toEqual({ runtimeMs: 42, error: 'boom', failureClass: 'sim' });
    });

    it('tags failureClass=infra when ngspice never ran', () => {
        expect(buildFailureMetrics({ runtimeMs: 1, infra: true }).failureClass).toBe('infra');
    });

    it('includes the convergence report only when present', () => {
        const conv = { recovered: false, kind: 'timestep', diagnosis: 'x', attempts: 3 } as never;
        expect(buildFailureMetrics({ infra: false, convergence: conv }).convergence).toBe(conv);
        expect('convergence' in buildFailureMetrics({ infra: false })).toBe(false);
    });
});

describe('buildSuccessMetrics — the success subset (storedResultBytes is the storage-quota unit)', () => {
    it('carries runtimeMs, storedResultBytes, and the optional fields when present', () => {
        expect(buildSuccessMetrics({ runtimeMs: 10, outputSizeBytes: 5000, storedResultBytes: 800, pointsCount: 1000 }))
            .toEqual({ runtimeMs: 10, outputSizeBytes: 5000, storedResultBytes: 800, pointsCount: 1000 });
    });

    it('omits pointsCount / outputSizeBytes / convergence when not provided (JSON-drops-undefined parity)', () => {
        const m = buildSuccessMetrics({ runtimeMs: 10, storedResultBytes: 800 });
        expect(m).toEqual({ runtimeMs: 10, storedResultBytes: 800 });
        expect('pointsCount' in m).toBe(false);
        expect('convergence' in m).toBe(false);
    });
});
