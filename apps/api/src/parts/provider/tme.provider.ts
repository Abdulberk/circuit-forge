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
    type ManufacturerRef,
    type PartProvider,
    type SearchParams,
    type SearchResult,
} from './part-provider.interface';

@Injectable()
export class TmeProvider implements PartProvider {
    readonly name = 'tme';
    private readonly logger = new Logger(TmeProvider.name);

    constructor(private readonly client: TmeClient) {}

    async search(params: SearchParams): Promise<SearchResult> {
        const { country, language } = this.client.defaults;
        const page = params.page && params.page > 0 ? params.page : 1;
        const data = await this.client.get<{ products?: { elements?: TmeSearchElement[]; amount?: number } }>(
            '/products/search',
            {
                country,
                language,
                phrase: params.q,
                scope: ['products'],
                manufacturer_id: params.manufacturerId,
                category_id: params.categoryId,
                page: params.page, // TME supports server-side paging (~20/page); undefined => page 1
            },
        );
        const elements = data.products?.elements ?? [];
        const items = elements.map(mapSearchElementToPart);
        return { items, page, pageSize: items.length, total: data.products?.amount };
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
        // Return the top-level categories (the root is the synthetic catalog root).
        return (root.children ?? []).slice(0, 1000).map((c) => mapCategoryNode(c, 0));
    }

    async getProduct(symbol: string): Promise<CatalogPart> {
        const { country, language, currency } = this.client.defaults;
        const symbols = [symbol];

        // `base` (search) is the primary lookup — let its failure surface (502). The parameters/data/
        // files calls are best-effort enrichment: a transient failure there must not fail the whole
        // request, so they degrade to empty.
        const [base, paramRes, dataRes, filesRes] = await Promise.all([
            this.client.get<{ products?: { elements?: TmeSearchElement[] } }>('/products/search', {
                country,
                language,
                phrase: symbol,
                scope: ['products'],
            }),
            this.client
                .get<{ elements?: TmeParametersElement[] }>('/products/parameters', { country, language, symbols })
                .catch(() => ({ elements: [] as TmeParametersElement[] })),
            this.client
                .get<{ elements?: TmeDataElement[] }>('/products/data', {
                    country,
                    currency,
                    scope: ['prices', 'stock'],
                    symbols,
                })
                .catch(() => ({ elements: [] as TmeDataElement[] })),
            this.client
                .get<{ elements?: TmeFilesElement[] }>('/products/files', { country, language, symbols })
                .catch(() => ({ elements: [] as TmeFilesElement[] })),
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
        };
    }
}
