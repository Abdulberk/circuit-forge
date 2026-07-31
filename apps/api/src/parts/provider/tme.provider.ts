/**
 * TmeProvider — implements PartProvider against the TME v2 REST API.
 * All TME shape knowledge lives here + tme-mapper.ts; other providers (DigiKey/LCSC) plug in later.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import {
    datasheetFromFiles,
    footprintFromParameters,
    mapCategoryNode,
    mapManufacturer,
    mapParameters,
    mapPriceBreaks,
    mapSearchElementToPart,
    type TmeCategoryNode,
    type TmeDataElement,
    type TmeFilesElement,
    type TmeManufacturer,
    type TmeParametersElement,
    type TmeSearchElement,
} from '../mappers/tme-mapper';
import { TmeClient } from '../tme/tme-client';

import {
    type CatalogPart,
    type CategoryNode,
    type EnrichmentSource,
    type ManufacturerRef,
    type PartProvider,
    type SearchParams,
    type SearchResult,
} from './part-provider.interface';

/** Response-size guard on the category tree — see getCategories. */
const MAX_TOP_LEVEL_CATEGORIES = 1000;

@Injectable()
export class TmeProvider implements PartProvider {
    readonly name = 'tme';
    private readonly logger = new Logger(TmeProvider.name);

    constructor(private readonly client: TmeClient) {}

    async search(params: SearchParams): Promise<SearchResult> {
        const { country, language } = this.client.defaults;
        // Normalize once and send the SAME number upstream. The two used to diverge — the response
        // reported the clamped page while the raw one went to TME — which is safe today only because the
        // DTO refuses anything below 1. A service is not safe because its caller happens to be careful.
        const page = params.page && params.page > 0 ? Math.floor(params.page) : 1;
        const data = await this.client.get<{ products?: { elements?: TmeSearchElement[]; amount?: number } }>(
            '/products/search',
            {
                country,
                language,
                phrase: params.q,
                scope: ['products'],
                manufacturer_id: params.manufacturerId,
                category_id: params.categoryId,
                page, // TME supports server-side paging (~20/page)
            },
        );
        const elements = data.products?.elements ?? [];
        const items = elements.map(mapSearchElementToPart);
        // `returned` is the count on THIS page, which is what the field always actually held — the old name
        // `pageSize` promised the page CAPACITY, so a short final page read as a shrinking page size and a
        // caller paging on it would stop early.
        return { items, page, returned: items.length, total: data.products?.amount };
    }

    async getManufacturers(): Promise<ManufacturerRef[]> {
        const { country, language, maxManufacturers } = this.client.defaults;
        const data = await this.client.get<{
            manufacturers?: { elements?: TmeManufacturer[] };
            elements?: TmeManufacturer[];
        }>('/products/manufacturers', { country, language });
        // Sort by product count FIRST, then cap — so the cap keeps the largest manufacturers, not an
        // arbitrary slice of TME's response order.
        const sorted = (data.manufacturers?.elements ?? data.elements ?? [])
            .map(mapManufacturer)
            .sort((a, b) => b.productsCount - a.productsCount);
        if (sorted.length > maxManufacturers) {
            this.logger.warn(
                `TME returned ${sorted.length} manufacturers; truncating to TME_MAX_MANUFACTURERS=${maxManufacturers}`,
            );
            return sorted.slice(0, maxManufacturers);
        }
        return sorted;
    }

    async getCategories(): Promise<CategoryNode[]> {
        const { country, language } = this.client.defaults;
        const data = await this.client.get<{ elements?: TmeCategoryNode }>('/products/categories/tree', {
            country,
            language,
            tree: 0,
        });
        const root = data.elements;
        if (!root) {
            this.logger.warn('TME /products/categories/tree returned no root element');
            return [];
        }
        // Return the top-level categories (the root is the synthetic catalog root). The cap is a response
        // -size guard, not a business rule: TME publishes a few dozen top-level categories, so hitting it
        // means the shape changed under us and is worth saying out loud rather than silently truncating.
        const top = root.children ?? [];
        if (top.length > MAX_TOP_LEVEL_CATEGORIES) {
            this.logger.warn(
                `TME returned ${top.length} top-level categories (expected a few dozen) — truncating to ${MAX_TOP_LEVEL_CATEGORIES}; the category tree shape may have changed`,
            );
        }
        return top.slice(0, MAX_TOP_LEVEL_CATEGORIES).map((c) => mapCategoryNode(c, 0));
    }

    async getProduct(symbol: string): Promise<CatalogPart> {
        const { country, language, currency } = this.client.defaults;
        const symbols = [symbol];

        // `base` (search) is the primary lookup — let its failure surface (502). The parameters/data/
        // files calls are best-effort enrichment: a transient failure there must not fail the whole
        // request, so they degrade to empty — but the degradation is RECORDED, never swallowed. A part
        // returned with no price because the pricing call timed out must not read like a part the supplier
        // does not price; see CatalogPart.unavailable for what that silence would cost downstream.
        const unavailable: EnrichmentSource[] = [];
        const bestEffort = <T>(promise: Promise<T>, source: EnrichmentSource, empty: T): Promise<T> =>
            promise.catch((err: unknown) => {
                unavailable.push(source);
                this.logger.warn(
                    `TME ${source} lookup failed for ${symbol} — part returned without it: ${String(err).slice(0, 160)}`,
                );
                return empty;
            });

        const [base, paramRes, dataRes, filesRes] = await Promise.all([
            this.client.get<{ products?: { elements?: TmeSearchElement[] } }>('/products/search', {
                country,
                language,
                phrase: symbol,
                scope: ['products'],
            }),
            bestEffort(
                this.client.get<{ elements?: TmeParametersElement[] }>('/products/parameters', {
                    country,
                    language,
                    symbols,
                }),
                'parameters',
                { elements: [] as TmeParametersElement[] },
            ),
            bestEffort(
                this.client.get<{ elements?: TmeDataElement[] }>('/products/data', {
                    country,
                    currency,
                    scope: ['prices', 'stock'],
                    symbols,
                }),
                'pricing',
                { elements: [] as TmeDataElement[] },
            ),
            bestEffort(
                this.client.get<{ elements?: TmeFilesElement[] }>('/products/files', { country, language, symbols }),
                'documents',
                { elements: [] as TmeFilesElement[] },
            ),
        ]);

        // Exact-symbol match only: never fall back to a fuzzy search hit, and never trust the
        // parameters "echo" — TME returns a parameters element even for a non-existent symbol.
        const baseEl = base.products?.elements?.find((e) => e.symbol === symbol);
        const paramEl = paramRes.elements?.find((e) => e.symbol === symbol);
        const dataEl = dataRes.elements?.find((e) => e.symbol === symbol);
        const filesEl = filesRes.elements?.find((e) => e.symbol === symbol);

        const hasParameters = (paramEl?.parameters?.elements?.length ?? 0) > 0;
        const hasData =
            !!dataEl && ((dataEl.prices?.elements?.length ?? 0) > 0 || typeof dataEl.stock_quantity === 'number');
        if (!baseEl && !hasParameters && !hasData) {
            throw new NotFoundException(`Part not found: ${symbol}`);
        }

        const parameters = mapParameters(paramEl);
        const { priceBreaks, unitCost, currency: priceCurrency, stock } = mapPriceBreaks(dataEl, currency);
        const light = baseEl ? mapSearchElementToPart(baseEl) : null;

        return {
            mpn: light?.mpn ?? symbol,
            manufacturer: light?.manufacturer ?? '',
            description: light?.description ?? '',
            category: light?.category,
            categoryId: light?.categoryId,
            footprint: footprintFromParameters(parameters),
            photo: light?.photo,
            datasheetUrl: datasheetFromFiles(filesEl),
            parameters,
            priceBreaks,
            stock,
            unitCost,
            currency: priceCurrency,
            supplier: this.name,
            supplierId: symbol,
            ...(unavailable.length > 0 ? { unavailable } : {}),
        };
    }
}
