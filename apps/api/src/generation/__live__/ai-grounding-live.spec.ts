/**
 * LIVE end-to-end proof of the full Flux-style flow: a REAL prompt -> the REAL AI (LLM_API_KEY) ->
 * native tool-use against the REAL TME catalog -> a grounded circuit -> server-attached sourcing.
 *
 * OPT-IN: runs only when AI_LIVE=1 AND real LLM + TME credentials are available (repo-root .env).
 * Skipped by default (makes real, paid LLM calls + hits the network).
 *
 *   AI_LIVE=1 pnpm --filter api test -- --runInBand ai-grounding-live
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ConfigService } from '@nestjs/config';
import { GenerationService } from '../generation.service';
import { CatalogGroundingService } from '../catalog-grounding.service';
import { CircuitSimulatorService } from '../circuit-simulator.service';
import { PartsService } from '../../parts/parts.service';
import { TtlCache } from '../../parts/cache/ttl-cache';
import { ComponentMapper } from '../../parts/mappers/component-mapper';
import { TmeClient } from '../../parts/tme/tme-client';
import { TmeTokenCache } from '../../parts/tme/tme-token-cache';
import { TmeProvider } from '../../parts/provider/tme.provider';

const LIVE = process.env.AI_LIVE === '1';

/** Load real LLM + TME creds from the repo-root .env (overriding the fake test stubs). */
function loadRealEnv(): boolean {
    const have = () => !!(process.env.LLM_API_KEY && process.env.TME_TOKEN && process.env.TME_TOKEN !== 'test-tme-token');
    if (have()) return true;
    for (const p of [resolve(process.cwd(), '../../.env'), resolve(__dirname, '../../../../../.env')]) {
        try {
            const txt = readFileSync(p, 'utf8');
            for (const key of ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_USER_AGENT', 'TME_TOKEN', 'TME_SECRET']) {
                const m = txt.match(new RegExp(`^${key}=(.+)$`, 'm'));
                if (m && m[1]) process.env[key] = m[1].trim();
            }
            if (have()) return true;
        } catch {
            /* try next */
        }
    }
    return false;
}

(LIVE ? describe : describe.skip)('AI grounding LIVE e2e (real LLM + real TME)', () => {
    let gen: GenerationService;

    beforeAll(() => {
        if (!loadRealEnv()) throw new Error('AI_LIVE=1 but LLM_API_KEY / TME creds not found in env or .env');
        const config = new ConfigService();
        const parts = new PartsService(
            new TmeProvider(new TmeClient(config, new TmeTokenCache(config))),
            new TtlCache(),
            config,
            new ComponentMapper(),
        );
        gen = new GenerationService(config, new CatalogGroundingService(config, parts, new CircuitSimulatorService(config)));
    });

    jest.setTimeout(180_000);

    it('generates an RC low-pass filter grounded in real catalog parts with server-attached sourcing', async () => {
        const result = await gen.generate({
            prompt: 'An RC low-pass filter with a 1 kHz cutoff, driven by a 5V source. Use standard parts.',
        } as never);

        // 1) A valid circuit came back.
        expect(result.circuit).toBeTruthy();
        expect(result.circuit.components.length).toBeGreaterThan(0);
        expect(result.circuit.nets.length).toBeGreaterThan(0);

        // 2) Grounding happened: at least one component carries a REAL manufacturer part number AND
        //    server-attached authoritative sourcing from the live catalog.
        const grounded = result.circuit.components.filter((c) => c.mpn && c.sourcing);
        const summary = result.circuit.components.map((c) => ({
            designator: c.designator, type: c.type, value: c.value, mpn: c.mpn,
            manufacturer: c.manufacturer, sourcing: c.sourcing,
        }));
        // eslint-disable-next-line no-console
        console.log('LIVE grounded circuit:', JSON.stringify(summary, null, 2));

        expect(grounded.length).toBeGreaterThan(0);
        for (const c of grounded) {
            expect(c.sourcing!.supplier).toBe('tme');
            expect(c.sourcing!.supplierId).toBeTruthy();
        }
        // Observational only (NOT asserted): in-stock preference is best-effort, and live catalog stock
        // legitimately fluctuates — surface the availability so it's visible without making CI flaky.
        const inStock = grounded.filter((c) => (c.sourcing!.stock ?? 0) > 0);
        // eslint-disable-next-line no-console
        console.log(`LIVE grounding: ${grounded.length} sourced, ${inStock.length} in stock.`);
    });
});
