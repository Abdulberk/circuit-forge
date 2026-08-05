/**
 * LIVE: the multi-candidate design path, with a real LLM and a real ngspice.
 *
 * WHY THIS EXISTS AND WHY IT WAS NEVER RUN. `runMultiCandidateDesign` ships DARK — `DESIGN_CANDIDATES_N`
 * defaults to 1, which degenerates to the single-candidate loop the product has always used. Everything
 * above N=1 is tested with `llm-core` mocked, which proves the ORCHESTRATION (screen → select → seeded
 * finalist loop → winner-only Monte-Carlo) and proves nothing about what a real model returns when asked for
 * four different answers to the same question. That gap was flagged and then sat, because no provider was
 * reachable.
 *
 * It is gated on `DESIGN_LIVE=1` plus a real key and a working ngspice, so it never runs in CI and never
 * spends anybody's credits by accident. Run it with, from the repo root:
 *
 *   DESIGN_LIVE=1 pnpm --filter worker-sim exec jest multi-candidate-live --runInBand
 *
 * WHAT IT ASSERTS, and only that. The fan-out LEAVES A MARK in the result: a multi-candidate run carries
 * the runners-up as `alternatives`, and a single-candidate run has none. So the two are run back to back and
 * compared — which is the one thing that distinguishes "N=4 worked" from "N=4 silently degenerated to the
 * path it degenerates to by design", and no mocked test can tell them apart.
 *
 * It does NOT assert that the circuit is correct, or that the four candidates differ, or what screening
 * scored them: the result carries the winner and the runners-up, not the four, and a model is not
 * deterministic. Pinning a value it cannot promise would make this fail for the wrong reason on a Tuesday.
 * The verdict is reported rather than required for the same reason.
 */
import { existsSync } from 'fs';

// NOTHING FROM THE WORKER IS IMPORTED AT FILE SCOPE, and that is not tidiness. `describe.skip` still
// evaluates a module's imports, and importing the design path pulls in the worker's config — which validates
// its environment on load — and the global resource pools. In CI, where none of that environment exists, the
// jest child process died before a single test was reported: "Jest worker encountered 4 child process
// exceptions, exceeding retry limit". A suite that is skipped must load nothing, so the imports live inside
// the test that needs them.

/** The same resolution the API's live specs use: an explicit path, then the usual install locations. */
const ngspice = (): string => {
    const asked = process.env.NGSPICE_PATH;
    if (asked && existsSync(asked)) return asked;
    return (
        [
            'C:/ProgramData/chocolatey/lib/ngspice/tools/Spice64/bin/ngspice_con.exe',
            '/usr/bin/ngspice',
            '/usr/local/bin/ngspice',
        ].find((p) => existsSync(p)) ?? ''
    );
};

const LIVE = process.env.DESIGN_LIVE === '1' && !!process.env.LLM_API_KEY && !!ngspice();

const llmConfig = {
    apiKey: process.env.LLM_API_KEY as string,
    protocol: process.env.LLM_PROTOCOL as 'anthropic' | 'openai' | undefined,
    baseUrl: process.env.LLM_BASE_URL,
    model: process.env.LLM_MODEL,
    timeoutMs: 180_000,
};

const PROMPT = 'A 5V to 3.3V resistive divider driving a high-impedance input.';
const CONSTRAINTS = 'Use standard E24 resistor values. Keep quiescent current under 1 mA.';

(LIVE ? describe : describe.skip)('multi-candidate design, LIVE (real LLM + real ngspice)', () => {
    beforeAll(() => {
        process.env.NGSPICE_PATH = ngspice();
        process.env.SIM_SANDBOX = 'none'; // spawn ngspice directly: this runs on a dev host, not in the image
    });

    it('fans out to four and leaves the runners-up behind, which a single-candidate run does not', async () => {
        const { runMultiCandidateDesign } = await import('../multi-candidate');
        const { noopGround } = await import('../grounding');
        const { makeLocalSim } = await import('../local-sim');

        const result = await runMultiCandidateDesign(
            { prompt: PROMPT, constraints: CONSTRAINTS, maxRounds: 2 },
            {
                llmConfig,
                runSim: makeLocalSim('live-mc'),
                ground: noopGround,
                userId: 'live-test',
                pollTimeoutMs: 180_000,
                mcEnabled: false, // Monte-Carlo is the winner-only stage and costs minutes; the flow is the subject
                isIntentfulError: () => false,
            },
            { n: 4, k: 2, llmBudget: 12 },
        );

        // The shape the product consumes. `ok` is the design loop's verdict and a live model may legitimately
        // fail to meet the spec in two rounds — a fact about the model, not about this code, so it is
        // reported rather than required.
        expect(result).toEqual(expect.objectContaining({ circuit: expect.any(Object), rounds: expect.any(Number) }));
        expect(result.circuit.components?.length ?? 0).toBeGreaterThan(0);

        // THE FAN-OUT ACTUALLY HAPPENED. Runners-up are what a multi-candidate run leaves behind, and the
        // single-candidate path leaves none — so the same request at N=1 is the control. Without it, a run
        // that quietly fell back to one candidate looks exactly like a run of four.
        const alternatives = (result as { alternatives?: unknown[] }).alternatives ?? [];
        expect(alternatives.length).toBeGreaterThan(0);

        const single = await runMultiCandidateDesign(
            { prompt: PROMPT, constraints: CONSTRAINTS, maxRounds: 2 },
            {
                llmConfig,
                runSim: makeLocalSim('live-mc-control'),
                ground: noopGround,
                userId: 'live-test',
                pollTimeoutMs: 180_000,
                mcEnabled: false,
                isIntentfulError: () => false,
            },
            { n: 1, k: 1, llmBudget: 4 },
        );
        expect((single as { alternatives?: unknown[] }).alternatives ?? []).toHaveLength(0);

        // eslint-disable-next-line no-console
        console.log(
            JSON.stringify(
                {
                    ok: result.ok,
                    parts: result.circuit.components?.map((c) => `${c.designator}=${c.value ?? c.type}`),
                    rounds: result.rounds,
                    alternatives: (result as { alternatives?: unknown[] }).alternatives?.length ?? 0,
                },
                null,
                1,
            ),
        );
    }, 900_000);
});
