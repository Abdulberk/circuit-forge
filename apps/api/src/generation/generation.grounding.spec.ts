/**
 * Grounding integration test: exercises the FULL PR2 path end-to-end with the Anthropic SDK and
 * PartsService mocked — proving the llm-core tool-use loop runs, the model's tool calls are executed
 * against PartsService, the returned circuit carries a real MPN, and the server attaches sourcing.
 */
import type { ConfigService } from '@nestjs/config';
import type { PartsService } from '../parts/parts.service';

// --- Mock the Anthropic SDK that llm-core (dist) imports. mockCreate is scripted per call. ---
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
    __esModule: true,
    default: class MockAnthropic {
        messages = { create: mockCreate };
        constructor(_opts: unknown) {}
    },
}));

// Imported AFTER the mock is registered.
import { GenerationService } from './generation.service';

const VALID_CIRCUIT = {
    version: '1.0',
    components: [
        { id: 'v1', type: 'voltage_source', designator: 'V1', value: 'SIN(0 5 1k)', pins: [
            { pinId: '+', netId: 'in' }, { pinId: '-', netId: 'gnd' }] },
        { id: 'r1', type: 'resistor', designator: 'R1', value: '10k',
            pins: [{ pinId: '1', netId: 'in' }, { pinId: '2', netId: 'out' }],
            mpn: 'RC0603FR-0710KL', manufacturer: 'YAGEO' }, // model grounded this from search_parts
        { id: 'c1', type: 'capacitor', designator: 'C1', value: '100n', pins: [
            { pinId: '1', netId: 'out' }, { pinId: '2', netId: 'gnd' }] },
        { id: 'gnd', type: 'ground', designator: 'GND1', pins: [{ pinId: '1', netId: 'gnd' }] },
    ],
    nets: [
        { id: 'in', name: 'IN' }, { id: 'out', name: 'OUT' }, { id: 'gnd', name: 'GND', isGround: true },
    ],
};

function makeParts() {
    return {
        search: jest.fn(async (_dto: { q: string }) => ({
            items: [{
                supplierId: 'SYM-RES-1', mpn: 'RC0603FR-0710KL', manufacturer: 'YAGEO',
                description: '10k 0603 1% resistor', category: 'SMD resistors',
                parameters: [], priceBreaks: [], supplier: 'tme',
            }],
            page: 1, pageSize: 1,
        })),
        getComponent: jest.fn(async (_symbol: string) => ({
            simulatable: true,
            component: { type: 'resistor', value: '10K' },
            catalog: {
                mpn: 'RC0603FR-0710KL', manufacturer: 'YAGEO', description: '10k 0603',
                footprint: '0603', stock: 50000, unitCost: 0.002, currency: 'EUR',
                datasheetUrl: 'https://d/x.pdf', parameters: [], priceBreaks: [],
                supplier: 'tme', supplierId: 'SYM-RES-1',
            },
        })),
        getProduct: jest.fn(async (_symbol: string) => ({
            mpn: 'RC0603FR-0710KL', manufacturer: 'YAGEO', description: '10k 0603',
            footprint: '0603', stock: 50000, unitCost: 0.002, currency: 'EUR',
            datasheetUrl: 'https://d/x.pdf', parameters: [], priceBreaks: [],
            supplier: 'tme', supplierId: 'SYM-RES-1',
        })),
    };
}

function makeConfig(): ConfigService {
    const values: Record<string, string | undefined> = {
        LLM_API_KEY: 'test-key',
        TME_TOKEN: 'test-token',
        TME_SECRET: 'test-secret', // grounding requires BOTH creds (matches requireTmeConfig)
    };
    return { get: (k: string) => values[k] } as unknown as ConfigService;
}

/** An Anthropic-shaped response with a single tool_use block. */
function toolUseResponse(id: string, name: string, input: Record<string, unknown>) {
    return { content: [{ type: 'tool_use', id, name, input }] };
}
/** An Anthropic-shaped response carrying the final JSON as text. */
function jsonResponse(payload: unknown) {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
const FINAL_JSON = {
    circuit: VALID_CIRCUIT,
    analysisConfig: { type: 'tran', stopTime: '5m', stepTime: '20u' },
    explanation: 'RC low-pass with a real Yageo resistor.',
};

describe('GenerationService grounding (tool-use + sourcing enrichment)', () => {
    beforeEach(() => mockCreate.mockReset());

    it('runs the tool loop, grounds components in real MPNs, and enriches sourcing', async () => {
        // Turn 1: model asks to search the catalog. Turn 2: model returns the final circuit.
        mockCreate
            .mockResolvedValueOnce({
                content: [{ type: 'tool_use', id: 'tu1', name: 'search_parts', input: { query: '10k 0603 resistor' } }],
            })
            .mockResolvedValueOnce({
                content: [{ type: 'text', text: JSON.stringify({
                    circuit: VALID_CIRCUIT,
                    analysisConfig: { type: 'tran', stopTime: '5m', stepTime: '20u' },
                    explanation: 'RC low-pass with a real Yageo resistor.',
                }) }],
            });

        const parts = makeParts();
        const service = new GenerationService(makeConfig(), parts as unknown as PartsService);

        const result = await service.generate({ prompt: 'RC low-pass filter, 1kHz cutoff' } as any);

        // The agentic loop ran (2 model calls) and the first offered tools.
        expect(mockCreate).toHaveBeenCalledTimes(2);
        expect(mockCreate.mock.calls[0][0].tools).toBeDefined();
        // The model's search_parts call was executed against PartsService.
        expect(parts.search).toHaveBeenCalled();

        // The returned circuit is grounded: R1 carries the real MPN/manufacturer the model chose...
        const r1 = result.circuit.components.find((c) => c.id === 'r1')!;
        expect(r1.mpn).toBe('RC0603FR-0710KL');
        expect(r1.manufacturer).toBe('YAGEO');
        // ...and the server attached authoritative sourcing (price/stock/datasheet) + backfilled footprint.
        expect(parts.getProduct).toHaveBeenCalled();
        expect(r1.sourcing).toMatchObject({ supplier: 'tme', supplierId: 'SYM-RES-1', unitCost: 0.002, currency: 'EUR', stock: 50000 });
        expect(r1.footprint).toBe('0603');
        // A component without an MPN is left untouched.
        expect(result.circuit.components.find((c) => c.id === 'c1')!.sourcing).toBeUndefined();
    });

    it('falls back to ungrounded generation when the catalog is not configured (no TME_TOKEN)', async () => {
        mockCreate.mockResolvedValueOnce({
            content: [{ type: 'text', text: JSON.stringify({
                circuit: VALID_CIRCUIT, analysisConfig: { type: 'op' },
            }) }],
        });
        const parts = makeParts();
        const cfg = { get: (k: string) => (k === 'LLM_API_KEY' ? 'test-key' : undefined) } as unknown as ConfigService;
        const service = new GenerationService(cfg, parts as unknown as PartsService);

        const result = await service.generate({ prompt: 'RC filter' } as any);

        // Single-shot, no tools offered, catalog never touched.
        expect(mockCreate).toHaveBeenCalledTimes(1);
        expect(mockCreate.mock.calls[0][0].tools).toBeUndefined();
        expect(parts.search).not.toHaveBeenCalled();
        expect(result.circuit.components.length).toBeGreaterThan(0);
    });

    it('does NOT attach sourcing when no exact MPN match exists (never a different part)', async () => {
        // Model returns the circuit directly; enrichment searches the model's mpn but the catalog has
        // only a DIFFERENT part -> exact match fails -> no sourcing attached (and getProduct not called).
        mockCreate.mockResolvedValueOnce(jsonResponse(FINAL_JSON));
        const parts = {
            search: jest.fn(async () => ({
                items: [{ supplierId: 'SYM-OTHER', mpn: 'SOME-OTHER-PART', manufacturer: 'X', description: 'unrelated' }],
                page: 1, pageSize: 1,
            })),
            getComponent: jest.fn(),
            getProduct: jest.fn(),
        };
        const service = new GenerationService(makeConfig(), parts as unknown as PartsService);

        const result = await service.generate({ prompt: 'RC filter' } as any);

        const r1 = result.circuit.components.find((c) => c.id === 'r1')!;
        expect(r1.mpn).toBe('RC0603FR-0710KL'); // model's choice preserved
        expect(r1.sourcing).toBeUndefined(); // but NO wrong-part sourcing attached
        expect(parts.getProduct).not.toHaveBeenCalled();
    });

    it('caps the tool loop at MAX_TOOL_ITERS and forces a tool-less final answer', async () => {
        // Model keeps calling tools on every offered turn; after the cap the loop must run one tool-less
        // call (tools omitted) that returns the final JSON — proving termination + no runaway.
        for (let i = 0; i < 5; i++) mockCreate.mockResolvedValueOnce(toolUseResponse(`tu${i}`, 'search_parts', { query: 'resistor' }));
        mockCreate.mockResolvedValueOnce(jsonResponse(FINAL_JSON));

        const parts = makeParts();
        const service = new GenerationService(makeConfig(), parts as unknown as PartsService);

        const result = await service.generate({ prompt: 'RC filter' } as any);

        expect(mockCreate).toHaveBeenCalledTimes(6); // 5 tool-enabled + 1 forced tool-less
        expect(mockCreate.mock.calls[5][0].tools).toBeUndefined(); // final call ran WITHOUT tools
        expect(result.circuit.components.length).toBeGreaterThan(0);
    });

    it('continues after a tool execution error (error surfaced as tool_result, not fatal)', async () => {
        mockCreate
            .mockResolvedValueOnce(toolUseResponse('tu1', 'search_parts', { query: '10k resistor' }))
            .mockResolvedValueOnce(jsonResponse(FINAL_JSON));
        const parts = {
            search: jest.fn(async () => { throw new Error('catalog upstream 502'); }),
            getComponent: jest.fn(),
            getProduct: jest.fn(),
        };
        const service = new GenerationService(makeConfig(), parts as unknown as PartsService);

        const result = await service.generate({ prompt: 'RC filter' } as any);

        // The thrown error was fed back to the model as a tool_result, and generation still completed.
        const secondCallMessages = JSON.stringify(mockCreate.mock.calls[1][0].messages);
        expect(secondCallMessages).toContain('catalog upstream 502');
        expect(result.circuit.components.length).toBeGreaterThan(0);
    });
});
