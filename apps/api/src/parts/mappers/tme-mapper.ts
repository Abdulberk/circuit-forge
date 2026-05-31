/**
 * Pure mappers: raw TME v2 response shapes -> supplier-agnostic domain types.
 * All TME-specific shape knowledge lives here and in TmeProvider.
 */
import type {
    CatalogParameter,
    CategoryNode,
    ManufacturerRef,
    PriceBreak,
} from '../provider/part-provider.interface';

const SUPPLIER = 'tme';

// --- raw TME shapes (only the fields we read) ---
export interface TmeSearchElement {
    symbol: string;
    manufacturer_symbols?: string[];
    manufacturer?: { id: number; name: string };
    description?: string;
    category?: { id: number; name: string };
    assets?: { primary_photo?: { prime?: string; thumbnail?: string; high_resolution?: string } };
}

export interface TmeParametersElement {
    symbol: string;
    parameters?: { elements?: Array<{ id: number; name: string; values?: Array<{ id: number; value: string }> }> };
}

export interface TmeDataElement {
    symbol: string;
    stock_quantity?: number;
    prices?: { elements?: Array<{ amount: number; price: number; special?: boolean }>; currency?: string };
}

export interface TmeFilesElement {
    symbol: string;
    documents?: { elements?: Array<{ url: string; type?: string; file_name?: string; language?: string }> };
}

export interface TmeManufacturer {
    id: number;
    name: string;
    products_count?: number;
}

export interface TmeCategoryNode {
    id: number;
    parent_id: number;
    name?: string;
    products_count?: number;
    children?: TmeCategoryNode[];
}

/** TME asset/document URLs are protocol-relative (`//host/...`). Make them absolute https. */
export function absoluteUrl(url?: string): string | undefined {
    if (!url) return undefined;
    return url.startsWith('//') ? `https:${url}` : url;
}

/** Light part from a search element (no parameters/prices). */
export function mapSearchElementToPart(el: TmeSearchElement) {
    return {
        mpn: el.manufacturer_symbols?.[0] ?? el.symbol,
        manufacturer: el.manufacturer?.name ?? '',
        description: el.description ?? '',
        category: el.category?.name,
        photo: absoluteUrl(el.assets?.primary_photo?.thumbnail ?? el.assets?.primary_photo?.prime),
        parameters: [] as CatalogParameter[],
        priceBreaks: [] as PriceBreak[],
        supplier: SUPPLIER,
        supplierId: el.symbol,
    };
}

export function mapParameters(el?: TmeParametersElement): CatalogParameter[] {
    const elements = el?.parameters?.elements ?? [];
    return elements.map((p) => ({
        name: p.name,
        value: (p.values ?? []).map((v) => v.value).filter(Boolean).join(', '),
    }));
}

/**
 * Footprint from the package parameter. TME names it "Case - inch" (e.g. "0603") / "Case - mm",
 * sometimes "Package"/"Housing"; prefer the inch code (the conventional footprint name).
 */
export function footprintFromParameters(params: CatalogParameter[]): string | undefined {
    const candidates = params.filter((p) => /\b(case|package|housing)\b/i.test(p.name));
    const inch = candidates.find((p) => /inch/i.test(p.name));
    const chosen = inch ?? candidates[0];
    return chosen?.value || undefined;
}

export function mapPriceBreaks(el?: TmeDataElement): { priceBreaks: PriceBreak[]; unitCost?: number; currency?: string; stock?: number } {
    const currency = el?.prices?.currency;
    const priceBreaks: PriceBreak[] = (el?.prices?.elements ?? []).map((p) => ({
        amount: p.amount,
        price: p.price,
        currency: currency ?? '',
        special: p.special,
    }));
    const single = priceBreaks.find((b) => b.amount === 1) ?? priceBreaks[0];
    return { priceBreaks, unitCost: single?.price, currency, stock: el?.stock_quantity };
}

/** Pick the best datasheet document: prefer a PDF (English if available), else the first document. */
export function datasheetFromFiles(el?: TmeFilesElement): string | undefined {
    const docs = el?.documents?.elements ?? [];
    if (docs.length === 0) return undefined;
    const isPdf = (d: { file_name?: string }) => !!d.file_name?.toLowerCase().endsWith('.pdf');
    const en = docs.find((d) => isPdf(d) && (d.language ?? '').toLowerCase() === 'en');
    const anyPdf = docs.find(isPdf);
    const chosen = en ?? anyPdf ?? docs[0];
    return chosen ? absoluteUrl(chosen.url) : undefined;
}

export function mapManufacturer(m: TmeManufacturer): ManufacturerRef {
    return { id: String(m.id), name: m.name, productsCount: m.products_count ?? 0 };
}

export function mapCategoryNode(node: TmeCategoryNode): CategoryNode {
    return {
        id: String(node.id),
        parentId: node.parent_id === node.id ? null : String(node.parent_id),
        name: node.name ?? '',
        productsCount: node.products_count ?? 0,
        children: (node.children ?? []).map(mapCategoryNode),
    };
}
