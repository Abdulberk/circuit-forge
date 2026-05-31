/**
 * TmeProvider — implements PartProvider against the TME v2 REST API.
 * All TME shape knowledge lives here + tme-mapper.ts; other providers (DigiKey/LCSC) plug in later.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { TmeClient } from '../tme/tme-client';
import {
    type CatalogPart,
    type CategoryNode,
    type ManufacturerRef,
    type PartProvider,
    type SearchParams,
    type SearchResult,
} from './part-provider.interface';
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

@Injectable()
export class TmeProvider implements PartProvider {
    readonly name = 'tme';

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
            },
        );
        const elements = data.products?.elements ?? [];
        const items = elements.map(mapSearchElementToPart);
        return { items, page, pageSize: items.length, total: data.products?.amount };
    }

    async getManufacturers(): Promise<ManufacturerRef[]> {
        const { country, language } = this.client.defaults;
        const data = await this.client.get<{
            manufacturers?: { elements?: TmeManufacturer[] };
            elements?: TmeManufacturer[];
        }>('/products/manufacturers', { country, language });
        const list = data.manufacturers?.elements ?? data.elements ?? [];
        return list.map(mapManufacturer).sort((a, b) => b.productsCount - a.productsCount);
    }

    async getCategories(): Promise<CategoryNode[]> {
        const { country, language } = this.client.defaults;
        const data = await this.client.get<{ elements?: TmeCategoryNode }>('/products/categories/tree', {
            country,
            language,
            tree: 0,
        });
        const root = data.elements;
        if (!root) return [];
        // Return the top-level categories (the root is the synthetic catalog root).
        return (root.children ?? []).map(mapCategoryNode);
    }

    async getProduct(symbol: string): Promise<CatalogPart> {
        const { country, language, currency } = this.client.defaults;
        const symbols = [symbol];

        const [base, paramRes, dataRes, filesRes] = await Promise.all([
            this.client
                .get<{ products?: { elements?: TmeSearchElement[] } }>('/products/search', {
                    country,
                    language,
                    phrase: symbol,
                    scope: ['products'],
                })
                .catch(() => ({ products: { elements: [] as TmeSearchElement[] } })),
            this.client.get<{ elements?: TmeParametersElement[] }>('/products/parameters', {
                country,
                language,
                symbols,
            }),
            this.client.get<{ elements?: TmeDataElement[] }>('/products/data', {
                country,
                currency,
                scope: ['prices', 'stock'],
                symbols,
            }),
            this.client
                .get<{ elements?: TmeFilesElement[] }>('/products/files', { country, language, symbols })
                .catch(() => ({ elements: [] as TmeFilesElement[] })),
        ]);

        const baseEl =
            base.products?.elements?.find((e) => e.symbol === symbol) ?? base.products?.elements?.[0];
        const paramEl = paramRes.elements?.find((e) => e.symbol === symbol) ?? paramRes.elements?.[0];
        const dataEl = dataRes.elements?.find((e) => e.symbol === symbol) ?? dataRes.elements?.[0];
        const filesEl = filesRes.elements?.find((e) => e.symbol === symbol) ?? filesRes.elements?.[0];

        if (!baseEl && !paramEl && !dataEl) {
            throw new NotFoundException(`Part not found: ${symbol}`);
        }

        const parameters = mapParameters(paramEl);
        const { priceBreaks, unitCost, currency: priceCurrency, stock } = mapPriceBreaks(dataEl);
        const light = baseEl ? mapSearchElementToPart(baseEl) : null;

        return {
            mpn: light?.mpn ?? symbol,
            manufacturer: light?.manufacturer ?? '',
            description: light?.description ?? '',
            category: light?.category,
            footprint: footprintFromParameters(parameters),
            photo: light?.photo,
            datasheetUrl: datasheetFromFiles(filesEl),
            parameters,
            priceBreaks,
            stock,
            unitCost,
            currency: priceCurrency ?? currency,
            supplier: this.name,
            supplierId: symbol,
        };
    }
}
