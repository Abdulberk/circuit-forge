/**
 * runDesignLoop — the cooperative-abort seam (the genuine behavior change introduced when the loop was
 * extracted for the queue worker). The full generate→sim→fix loop is exercised end-to-end by the API's
 * design-spec-satisfaction suite (mocked SDK + sim); here we only lock the NEW abort hook, which fires at the
 * first checkpoint BEFORE any LLM/sim call — so it needs no Anthropic SDK mock.
 */
import { runDesignLoop, DesignAbortedError, type DesignDeps } from './design-core';

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
