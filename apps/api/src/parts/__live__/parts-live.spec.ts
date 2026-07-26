/**
 * LIVE end-to-end tests against the REAL TME v2 API, exercising the full PR1 classification pipeline
 * (search -> getProduct -> ComponentMapper.toComponent) on real parts + edge cases.
 *
 * OPT-IN: runs only when TME_LIVE=1 AND real credentials are available (repo-root .env or env vars).
 * Skipped by default so normal `pnpm test` / CI never hit the network.
 *
 *   TME_LIVE=1 pnpm --filter api test -- --runInBand parts-live
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ComponentMapper } from '../mappers/component-mapper';
import type { CatalogPart } from '../provider/part-provider.interface';
import { TmeProvider } from '../provider/tme.provider';
import { TmeClient } from '../tme/tme-client';
import { TmeTokenCache } from '../tme/tme-token-cache';

const LIVE = process.env.TME_LIVE === '1';

/** Load real TME creds into process.env (overriding the fake test stubs) from the repo-root .env. */
function loadRealCreds(): boolean {
    if (process.env.TME_TOKEN && process.env.TME_TOKEN !== 'test-tme-token') return true;
    for (const p of [resolve(process.cwd(), '../../.env'), resolve(__dirname, '../../../../../.env')]) {
        try {
            const txt = readFileSync(p, 'utf8');
            const tok = txt.match(/^TME_TOKEN=(.+)$/m)?.[1]?.trim();
            const sec = txt.match(/^TME_SECRET=(.+)$/m)?.[1]?.trim();
            if (tok && sec) {
                process.env.TME_TOKEN = tok;
                process.env.TME_SECRET = sec;
                return true;
            }
        } catch {
            /* try next path */
        }
    }
    return false;
}

(LIVE ? describe : describe.skip)('parts LIVE e2e (real TME v2)', () => {
    let provider: TmeProvider;
    const mapper = new ComponentMapper();

    /** Search a term, take the first hit, fetch its full product, and classify it. */
    async function classifyFirst(q: string): Promise<{ part: CatalogPart; mapped: ReturnType<ComponentMapper['toComponent']> } | null> {
        const res = await provider.search({ q });
        const first = res.items[0];
        if (!first) return null;
        const part = await provider.getProduct(first.supplierId);
        return { part, mapped: mapper.toComponent(part) };
    }

    beforeAll(() => {
        if (!loadRealCreds()) throw new Error('TME_LIVE=1 but no real TME_TOKEN/TME_SECRET found in env or .env');
        const config = new ConfigService();
        provider = new TmeProvider(new TmeClient(config, new TmeTokenCache(config)));
    });

    jest.setTimeout(90_000);

    // --- Classification: simulatable primitives ----------------------------------------------------
    it('classifies a real resistor as simulatable with a normalized value + footprint + sourcing', async () => {
        const r = await classifyFirst('resistor 10k 0603');
        expect(r).toBeTruthy();
        expect(r!.part.categoryId).toBeTruthy(); // stable id is carried
        expect(r!.mapped.component?.type).toBe('resistor');
        expect(r!.mapped.simulatable).toBe(true);
        expect(r!.mapped.component?.value).toBeTruthy();
        expect(r!.mapped.component?.sourcing?.supplier).toBe('tme');
    });

    it('classifies a real capacitor as simulatable', async () => {
        const c = await classifyFirst('capacitor 100nF 0603 X7R');
        expect(c!.mapped.component?.type).toBe('capacitor');
        expect(c!.mapped.simulatable).toBe(true);
    });

    it('CAPTURES the real resistor tolerance from the catalog datasheet (source=catalog, not a guess)', async () => {
        // Proves the tolerance the verified-signoff robustness tier needs comes from the sourced real part
        // as a FACT — no LLM guess, no hardcoded default. A 1% part carries a "Tolerance ±1%" parameter.
        const r = await classifyFirst('resistor 10k 0603 1%');
        expect(r!.mapped.component?.type).toBe('resistor');
        expect(r!.mapped.component?.tolerance).toBeGreaterThan(0);
        expect(r!.mapped.component?.tolerance).toBeLessThanOrEqual(0.05);
        expect(r!.mapped.component?.toleranceSource).toBe('catalog');
    });

    it('classifies a real universal diode as simulatable (value-less, model-based)', async () => {
        const d = await classifyFirst('1N4148');
        expect(d!.mapped.component?.type).toBe('diode');
        expect(d!.mapped.simulatable).toBe(true);
        expect(d!.mapped.component?.value).toBeUndefined();
    });

    // --- Classification: active devices are now simulatable (model resolved by polarity) ------------
    it('classifies a real NPN transistor (BC547) as a SIMULATABLE bjt with a generic model attached', async () => {
        // Since active-device simulation shipped, a real transistor category maps to `bjt` and the mapper
        // resolves a generic SPICE model by polarity (QGENNPN/QGENPNP) — so a part the AI grounds a design
        // in is directly simulatable, not a catalog-only stand-in.
        const q = await classifyFirst('BC547');
        expect(q!.mapped.component?.type).toBe('bjt');
        expect(q!.mapped.simulatable).toBe(true);
        expect(q!.mapped.component?.model).toBeTruthy(); // a generic NPN/PNP model name
        expect(q!.mapped.component?.mpn).toBeTruthy(); // still carries catalog metadata for the BOM
    });

    // --- Classification: catalog-only 'generic' (parts with no SPICE model yet) ---------------------

    it('classifies a real op-amp / timer IC (NE555) as catalog-only generic', async () => {
        const ic = await classifyFirst('NE555');
        expect(ic!.mapped.component?.type).toBe('generic');
        expect(ic!.mapped.simulatable).toBe(false);
    });

    it('does NOT misclassify a real Zener diode as a plain diode (structured map wins)', async () => {
        const z = await classifyFirst('BZX55C5V1');
        // Zener category -> generic; must never be emitted as a plain DDEFAULT rectifier.
        expect(z!.mapped.component?.type).toBe('generic');
        expect(z!.mapped.simulatable).toBe(false);
    });

    it('classifies a real connector as catalog-only generic', async () => {
        const conn = await classifyFirst('pin header 2.54 male');
        expect(conn!.mapped.component?.type).toBe('generic');
        expect(conn!.mapped.simulatable).toBe(false);
    });

    // --- Edge cases --------------------------------------------------------------------------------
    it('throws NotFound for a non-existent symbol (ignores the TME parameters echo)', async () => {
        await expect(provider.getProduct('NO_SUCH_SYMBOL_ZZZ_999999')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns an empty result set for a no-match search phrase', async () => {
        const res = await provider.search({ q: 'zzqqxx_nonexistent_phrase_99887766' });
        expect(res.items).toHaveLength(0);
    });

    it('paginates: page 1 returns items and a total', async () => {
        const p1 = await provider.search({ q: 'resistor', page: 1 });
        expect(p1.items.length).toBeGreaterThan(0);
        expect(p1.page).toBe(1);
    });

    // --- Facets ------------------------------------------------------------------------------------
    it('returns manufacturers sorted by product count DESC and within the cap', async () => {
        const mans = await provider.getManufacturers();
        expect(mans.length).toBeGreaterThan(100);
        expect(mans.length).toBeLessThanOrEqual(5000);
        for (let i = 1; i < Math.min(mans.length, 50); i++) {
            const prev = mans[i - 1]!;
            const cur = mans[i]!;
            expect(prev.productsCount).toBeGreaterThanOrEqual(cur.productsCount);
        }
    });

    it('returns a non-trivial category tree', async () => {
        const cats = await provider.getCategories();
        expect(cats.length).toBeGreaterThan(5);
        expect(cats.some((c) => c.children.length > 0)).toBe(true);
    });
});
