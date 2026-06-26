/**
 * runDesignLoop — the cooperative-abort seam (the genuine behavior change introduced when the loop was
 * extracted for the queue worker). The full generate→sim→fix loop is exercised end-to-end by the API's
 * design-spec-satisfaction suite (mocked SDK + sim); here we only lock the NEW abort hook, which fires at the
 * first checkpoint BEFORE any LLM/sim call — so it needs no Anthropic SDK mock.
 */
import { runDesignLoop, DesignAbortedError, specCloseness, type DesignDeps } from './design-core';
import type { AssertionResult } from '@circuit-forge/eda-core';

const A = (over: Partial<AssertionResult>): AssertionResult => ({
    label: 'x', probe: 'out', metric: 'final', op: 'approx', target: 5, tol: 0.5, actual: 5, pass: true, distance: 0, detail: '', ...over,
});

describe('specCloseness (candidate screen scoring)', () => {
    it('is 0 when every criterion is dead-on, and rises with the normalized miss', () => {
        expect(specCloseness([A({ distance: 0 })])).toBe(0);
        // distance 0.5 on target 5 → 0.1; distance 1 on target 10 → 0.1 → sum 0.2
        expect(specCloseness([A({ target: 5, distance: 0.5 }), A({ target: 10, distance: 1 })])).toBeCloseTo(0.2);
    });

    it('penalizes an unmeasured criterion (distance null) a full unit', () => {
        expect(specCloseness([A({ distance: null })])).toBe(1);
        expect(specCloseness([A({ distance: 0 }), A({ distance: null })])).toBe(1);
    });

    it('falls back to tol then 1 when the target is ~0 (avoids divide-by-zero)', () => {
        expect(specCloseness([A({ target: 0, tol: 0.2, distance: 0.2 })])).toBeCloseTo(1); // 0.2/0.2
        expect(specCloseness([A({ target: 0, tol: 0, distance: 3 })])).toBe(3); // denom→1
    });

    it('returns Infinity for no criteria (cannot rank)', () => {
        expect(specCloseness([])).toBe(Number.POSITIVE_INFINITY);
    });

    it('lower score = closer to spec (the ranking invariant)', () => {
        const near = specCloseness([A({ target: 5, distance: 0.1 })]);
        const far = specCloseness([A({ target: 5, distance: 2 })]);
        expect(near).toBeLessThan(far);
    });
});

function fakeDeps(over: Partial<DesignDeps>): DesignDeps {
    const runSim = {
        createQuickSim: jest.fn(),
        getStatus: jest.fn(),
        getResult: jest.fn(),
        createMonteCarloJob: jest.fn(),
    };
    return {
        llmConfig: { apiKey: 'test-key' } as unknown as DesignDeps['llmConfig'],
        runSim: runSim as unknown as DesignDeps['runSim'],
        ground: { grounding: () => undefined, enrichSourcing: jest.fn(async () => undefined) },
        userId: 'u1',
        pollTimeoutMs: 1000,
        mcEnabled: false,
        ...over,
    };
}

describe('runDesignLoop — cooperative abort', () => {
    it('throws DesignAbortedError at the first checkpoint when already aborted — BEFORE any LLM or sim call', async () => {
        const deps = fakeDeps({ isAborted: () => Promise.resolve(true) });
        await expect(runDesignLoop({ prompt: 'an RC low-pass', maxRounds: 2 }, deps)).rejects.toBeInstanceOf(DesignAbortedError);
        // The abort fires before generateCircuit, so no simulation is ever enqueued (no spend).
        expect((deps.runSim.createQuickSim as jest.Mock)).not.toHaveBeenCalled();
        expect((deps.ground.enrichSourcing as jest.Mock)).not.toHaveBeenCalled();
    });

    it('DesignAbortedError is a distinct, catchable error type', () => {
        const e = new DesignAbortedError();
        expect(e).toBeInstanceOf(Error);
        expect(e.name).toBe('DesignAbortedError');
    });
});
