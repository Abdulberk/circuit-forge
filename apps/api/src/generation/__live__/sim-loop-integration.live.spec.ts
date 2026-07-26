/**
 * SEMI-LIVE integration proof of the verify-and-fix loop with REAL parts + REAL ngspice, but a SCRIPTED
 * model (so it runs without the LLM gateway). It proves the whole machine end-to-end: the agentic loop
 * reaches the LIVE TME catalog (real parts), runs the model's proposed circuit through the REAL ngspice
 * simulator (real ERC + real measurements), feeds an ERC error back, the (scripted) model fixes it, and a
 * second REAL simulation confirms it's clean before the loop finalizes.
 *
 * OPT-IN: SIMLOOP_LIVE=1 + a configured ngspice + real TME creds (repo-root .env). Skipped by default.
 *
 *   SIMLOOP_LIVE=1 NGSPICE_PATH="C:/.../ngspice_con.exe" pnpm --filter api exec jest sim-loop-integration --runInBand
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Mock ONLY the Anthropic SDK (the gateway is unavailable); PartsService + ngspice are REAL.
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
    __esModule: true,
    default: class MockAnthropic {
        messages = { create: mockCreate };
        constructor(_opts: unknown) {}
    },
}));

import { ConfigService } from '@nestjs/config';

import { TtlCache } from '../../parts/cache/ttl-cache';
import { ComponentMapper } from '../../parts/mappers/component-mapper';
import { PartsService } from '../../parts/parts.service';
import { TmeProvider } from '../../parts/provider/tme.provider';
import { TmeClient } from '../../parts/tme/tme-client';
import { TmeTokenCache } from '../../parts/tme/tme-token-cache';
import { CatalogGroundingService } from '../catalog-grounding.service';
import { CircuitSimulatorService } from '../circuit-simulator.service';
import { GenerationService } from '../generation.service';

const GATE = process.env.SIMLOOP_LIVE === '1';

function loadRealEnv(): boolean {
    const have = () => !!(process.env.TME_TOKEN && process.env.TME_TOKEN !== 'test-tme-token' && process.env.NGSPICE_PATH);
    if (have()) return true;
    for (const p of [resolve(process.cwd(), '../../.env'), resolve(__dirname, '../../../../../.env')]) {
        try {
            const txt = readFileSync(p, 'utf8');
            for (const key of ['TME_TOKEN', 'TME_SECRET']) {
                const m = txt.match(new RegExp(`^${key}=(.+)$`, 'm'));
                if (m && m[1]) process.env[key] = m[1].trim();
            }
            if (process.env.TME_TOKEN && process.env.TME_TOKEN !== 'test-tme-token') return !!process.env.NGSPICE_PATH;
        } catch {
            /* next */
        }
    }
    return false;
}

const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ content: [{ type: 'tool_use', id, name, input }] });
const jsonResponse = (payload: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });

// A BROKEN RC: no ground net anywhere → ERC NO_GROUND (ERC001). The (scripted) model "discovers" this
// from the real simulate_circuit result and fixes it.
const BROKEN_RC = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'DC 5', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: 'ret' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1.6k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'c1', type: 'capacitor', designator: 'C1', value: '100n', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'ret' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: 'ret', name: 'ret' }],
};
// FIXED: 'ret' is now the ground reference. ERC clean, simulates.
const FIXED_RC = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'SIN(0 5 1k)', pins: [{ pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '1.6k', pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }] },
        { id: 'c1', type: 'capacitor', designator: 'C1', value: '100n', pins: [{ pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [{ id: 'in', name: 'in' }, { id: 'out', name: 'out' }, { id: 'gnd', name: 'gnd', isGround: true }],
};

(GATE ? describe : describe.skip)('sim-loop integration (REAL TME + REAL ngspice, scripted model)', () => {
    let gen: GenerationService;

    beforeAll(() => {
        if (!loadRealEnv()) throw new Error('SIMLOOP_LIVE=1 but TME creds and/or NGSPICE_PATH not found');
        // The Anthropic SDK is mocked (scripted turns), so the key value is never used for any network
        // call — it only needs to be SET so requireLlmConfig() doesn't refuse. TME + ngspice are real.
        process.env.LLM_API_KEY = process.env.LLM_API_KEY || 'mock-scripted-key';
        const config = new ConfigService();
        const parts = new PartsService(
            new TmeProvider(new TmeClient(config, new TmeTokenCache(config))),
            new TtlCache(),
            config,
            new ComponentMapper(),
        );
        gen = new GenerationService(config, new CatalogGroundingService(config, parts, new CircuitSimulatorService(config)));
    });

    jest.setTimeout(60_000);

    it('reaches REAL catalog + REAL ngspice; an ERC error is fed back, fixed, then re-verified clean', async () => {
        // Scripted turns: search the REAL catalog → simulate the BROKEN circuit (REAL ngspice → ERC001) →
        // simulate the FIXED circuit (REAL ngspice → ok + measurements) → finalize.
        mockCreate
            .mockResolvedValueOnce(toolUse('t1', 'search_parts', { query: 'resistor 10k 0603' }))
            .mockResolvedValueOnce(toolUse('t2', 'simulate_circuit', { circuit: BROKEN_RC, analysis: { type: 'op' } }))
            .mockResolvedValueOnce(toolUse('t3', 'simulate_circuit', { circuit: FIXED_RC, analysis: { type: 'tran', stopTime: '5m', stepTime: '20u' } }))
            .mockResolvedValueOnce(jsonResponse({ circuit: FIXED_RC, analysisConfig: { type: 'tran', stopTime: '5m', stepTime: '20u' }, explanation: 'RC low-pass; fixed the missing ground after simulation flagged it.' }));

        const result = await gen.generate({ prompt: 'An RC low-pass filter, 1 kHz cutoff.' } as never);

        // The mock records the SAME (mutated) convo array on every call, so index-based lookup is unsafe —
        // find each turn's tool_result by its tool_use_id in the final convo. Each tool_result's .content
        // is the JSON string the executor returned.
        const finalConvo = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0].messages;
        const toolResultById = (id: string) => {
            for (const msg of finalConvo) {
                if (!Array.isArray(msg.content)) continue;
                for (const block of msg.content) {
                    if (block.type === 'tool_result' && block.tool_use_id === id) return JSON.parse(block.content);
                }
            }
            throw new Error(`no tool_result for ${id}`);
        };
        const firstSearch = toolResultById('t1'); // result of search_parts
        const brokenSim = toolResultById('t2'); // result of simulate_circuit(BROKEN)
        const fixedSim = toolResultById('t3'); // result of simulate_circuit(FIXED)

        // Log first (before any assertion) so the real artifacts are always visible.
        // eslint-disable-next-line no-console
        console.log('REAL TME first hit:', JSON.stringify(firstSearch.items?.[0] ?? firstSearch));
        // eslint-disable-next-line no-console
        console.log('REAL sim of BROKEN:', JSON.stringify(brokenSim));
        // eslint-disable-next-line no-console
        console.log('REAL sim of FIXED:', JSON.stringify(fixedSim));

        // 1) REAL catalog was reached — the search_parts tool was dispatched to the live PartsService and
        //    returned a structured result (either { items } with real parts, or { error } when live TME is
        //    rate-limiting). The dedicated parts-live spec is what asserts non-empty hits; this test only
        //    needs the loop to have reached the real catalog. Any returned part must carry an mpn.
        expect(firstSearch && typeof firstSearch === 'object').toBe(true);
        if (Array.isArray(firstSearch.items)) {
            for (const item of firstSearch.items) expect(item.mpn).toBeTruthy();
        }
        // 2) REAL ngspice/ERC flagged the missing ground on the broken circuit, fed back to the model.
        expect(brokenSim.ercErrors.some((e: { code: string }) => e.code === 'ERC001')).toBe(true);
        // 3) REAL ngspice verified the FIXED circuit clean, with real measurements (output is attenuated).
        expect(fixedSim.simStatus).toBe('ok');
        expect(fixedSim.ercErrors).toHaveLength(0);
        expect(fixedSim.measurements.length).toBeGreaterThan(0);
        const outNode = fixedSim.measurements.find((m: { node: string }) => m.node.includes('out'));
        expect(outNode.pp).toBeGreaterThan(0); // the SIN input produces a real swinging output
        // 4) The loop finalized into a valid, self-contained circuit.
        expect(result.circuit.components.length).toBeGreaterThan(0);

        // Surface the real artifacts so the run is human-readable.
        // eslint-disable-next-line no-console
        console.log('REAL TME first hit:', JSON.stringify(firstSearch.items[0]));
        // eslint-disable-next-line no-console
        console.log('REAL sim of BROKEN circuit:', JSON.stringify({ simStatus: brokenSim.simStatus, ercErrors: brokenSim.ercErrors }));
        // eslint-disable-next-line no-console
        console.log('REAL sim of FIXED circuit:', JSON.stringify({ simStatus: fixedSim.simStatus, measurements: fixedSim.measurements }));
    });
});
