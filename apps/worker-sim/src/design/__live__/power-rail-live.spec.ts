/**
 * LIVE: does the model actually mark a supply rail, and does the validator trust the mark?
 *
 * `Net.isPower` has been in the schema, validated by a mini-ERC with a deliberate refutation asymmetry, and
 * read by the supply-corner robustness run — and NOTHING has ever written one. Not the LLM, which was never
 * told the field exists; not the UI, which has no control for it. So a shipped capability reported "not run"
 * on every design the product has ever produced, and the sheet had no way to draw a rail as a rail.
 *
 * The prompt now names it. Whether a model DOES what a prompt asks is not a question a mocked test can
 * answer — it is a fact about the model — so this asks it, live, and reports what came back.
 *
 * Gated on DESIGN_LIVE=1 plus a real key, so it never runs in CI and never spends credits by accident:
 *
 *   DESIGN_LIVE=1 pnpm --filter worker-sim exec jest power-rail-live --runInBand
 */
import { existsSync } from 'fs';

// Nothing from the worker is imported at file scope: `describe.skip` still evaluates a module's imports, and
// the design path pulls in the worker's config, which validates its environment on load. In CI that killed
// the jest child process before a single test was reported.

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

(LIVE ? describe : describe.skip)('supply rails, LIVE (real LLM)', () => {
    beforeAll(() => {
        process.env.NGSPICE_PATH = ngspice();
        process.env.SIM_SANDBOX = 'none';
    });

    it('marks the rail, and the validator TRUSTS the mark', async () => {
        const { runMultiCandidateDesign } = await import('../multi-candidate');
        const { noopGround } = await import('../grounding');
        const { makeLocalSim } = await import('../local-sim');
        const { validatePowerRails } = await import('@circuit-forge/eda-core');

        const result = await runMultiCandidateDesign(
            {
                // A circuit with an UNAMBIGUOUS rail: one DC source, several parts drawing from it. If the
                // model will not mark this one, it will not mark any, and the prompt change is worthless.
                prompt: 'A 12V supply rail feeding two LED indicator branches, each with its own series resistor.',
                constraints: 'Use standard E24 resistor values.',
                maxRounds: 2,
            },
            {
                llmConfig,
                runSim: makeLocalSim('live-rail'),
                ground: noopGround,
                userId: 'live-test',
                pollTimeoutMs: 180_000,
                mcEnabled: false,
                isIntentfulError: () => false,
            },
            { n: 1, k: 1, llmBudget: 4 },
        );

        const rails = (result.circuit.nets ?? []).filter((n) => n.isPower);
        const verdicts = validatePowerRails(result.circuit);

        // eslint-disable-next-line no-console
        console.log(
            JSON.stringify(
                {
                    nets: (result.circuit.nets ?? []).map(
                        (n) => `${n.name}${n.isPower ? ' [rail]' : ''}${n.isGround ? ' [gnd]' : ''}`,
                    ),
                    verdicts,
                },
                null,
                1,
            ),
        );

        // THE MARK EXISTS. Before the prompt named the field, this was zero on every design ever generated.
        expect(rails.length).toBeGreaterThan(0);
        // AND IT SURVIVES THE CHECK. A mark the validator defers on is worse than no mark: it claims
        // something the topology does not support, and the robustness run then reports a rail it cannot use.
        expect(verdicts.filter((v) => v.status === 'trusted').length).toBeGreaterThan(0);
        // AND IT IS NOT THE GROUND NET. That combination is contradictory and the validator says so.
        expect(rails.some((n) => n.isGround)).toBe(false);
    }, 900_000);
});
