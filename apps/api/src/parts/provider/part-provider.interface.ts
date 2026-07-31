/**
 * Supplier-agnostic component-catalog provider contract + domain types.
 *
 * TmeProvider implements this today; a DigiKeyProvider/LcscProvider can be added later behind the
 * same interface. Bound to the PART_PROVIDER DI token in PartsModule.
 */

export const PART_PROVIDER = Symbol('PART_PROVIDER');

export interface CatalogParameter {
    name: string;
    value: string;
}

export interface PriceBreak {
    amount: number; // minimum quantity for this price tier
    price: number; // unit price at this tier, in `currency`
    currency: string;
    special?: boolean;
}

/**
 * The enrichment lookups a detail request makes beyond the base product record. Each is BEST-EFFORT — a
 * transient failure degrades the part rather than failing the request — which is right, and which is
 * exactly why the failure has to be recorded. See CatalogPart.unavailable.
 */
export type EnrichmentSource = 'parameters' | 'pricing' | 'documents';

/** Normalized, supplier-agnostic representation of a catalog part. */
export interface CatalogPart {
    mpn: string;
    manufacturer: string;
    description: string;
    category?: string; // human-readable (localized) category name
    categoryId?: string; // stable, locale-independent category id — the reliable classification signal
    footprint?: string;
    photo?: string;
    datasheetUrl?: string;
    parameters: CatalogParameter[]; // empty in search results; populated in detail
    priceBreaks: PriceBreak[]; // empty in search results; populated in detail
    stock?: number;
    unitCost?: number; // price for quantity 1 (or the smallest tier)
    currency?: string;
    supplier: string; // e.g. "tme"
    supplierId: string; // the supplier's own part id (TME symbol)
    /**
     * Enrichment lookups that DID NOT ANSWER on this fetch. Absent when everything answered.
     *
     * Without it a transient upstream failure is indistinguishable from a fact about the part: a supplier
     * blip on the pricing call returns a part with no price and no stock, which reads exactly like a part
     * the supplier genuinely does not price. The consequences here are concrete — tolerance and footprint
     * both come from 'parameters', so a silent failure there drops a part's tolerance out of the
     * Monte-Carlo spread (reporting a robustness tier computed on less variation than the design really
     * has) and drops its footprint, which is what decides its power rating.
     *
     * "We could not ask" and "the answer is nothing" must never look the same.
     */
    unavailable?: EnrichmentSource[];
}

export interface ManufacturerRef {
    id: string;
    name: string;
    productsCount: number;
}

export interface CategoryNode {
    id: string;
    parentId: string | null;
    name: string;
    productsCount: number;
    children: CategoryNode[];
}

export interface SearchParams {
    q?: string;
    manufacturerId?: string;
    categoryId?: string;
    page?: number;
}

export interface SearchResult {
    items: CatalogPart[];
    page: number;
    /** How many items THIS page returned. Not the page capacity — a short final page is normal, so a
     *  caller must not treat a small value as "the page got smaller" and stop paging. */
    returned: number;
    total?: number;
}

export interface PartProvider {
    readonly name: string;
    search(params: SearchParams): Promise<SearchResult>;
    getManufacturers(): Promise<ManufacturerRef[]>;
    getCategories(): Promise<CategoryNode[]>;
    getProduct(symbol: string): Promise<CatalogPart>;
}
