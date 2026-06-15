import { classifyJobOutcome, isFinalAttempt, type OutcomeInput } from './outcome';

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
