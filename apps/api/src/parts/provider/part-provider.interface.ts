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

/** Normalized, supplier-agnostic representation of a catalog part. */
export interface CatalogPart {
    mpn: string;
    manufacturer: string;
    description: string;
    category?: string;
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
    pageSize: number;
    total?: number;
}

export interface PartProvider {
    readonly name: string;
    search(params: SearchParams): Promise<SearchResult>;
    getManufacturers(): Promise<ManufacturerRef[]>;
    getCategories(): Promise<CategoryNode[]>;
    getProduct(symbol: string): Promise<CatalogPart>;
}
