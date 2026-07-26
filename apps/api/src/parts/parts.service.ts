/**
 * PartsService — delegates to the configured PartProvider, adds reference/search caching, and maps
 * provider/TME errors to HTTP responses (mirrors GenerationService.mapError).
 */
import {
    Injectable,
    Inject,
    BadGatewayException,
    BadRequestException,
    HttpException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TtlCache } from './cache/ttl-cache';
import { SearchPartsDto } from './dto';
import { ComponentMapper, type MappedComponent } from './mappers/component-mapper';
import {
    PART_PROVIDER,
    type CatalogPart,
    type CategoryNode,
    type ManufacturerRef,
    type PartProvider,
    type SearchResult,
} from './provider/part-provider.interface';
import { TmeApiError, TmeNetworkError } from './tme/tme-errors';

const SYMBOL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

@Injectable()
export class PartsService {
    constructor(
        @Inject(PART_PROVIDER) private readonly provider: PartProvider,
        private readonly cache: TtlCache,
        private readonly config: ConfigService,
        private readonly mapper: ComponentMapper,
    ) {}

    async search(dto: SearchPartsDto): Promise<SearchResult> {
        const page = dto.page && dto.page > 0 ? dto.page : 1;
        try {
            const key = `search:${dto.q}:${dto.manufacturerId ?? ''}:${dto.categoryId ?? ''}:${page}`;
            return await this.cache.getOrLoad(key, this.ttl('TME_SEARCH_TTL_MS', 60_000), () =>
                this.provider.search({
                    q: dto.q,
                    manufacturerId: dto.manufacturerId,
                    categoryId: dto.categoryId,
                    page: dto.page,
                }),
            );
        } catch (err) {
            // The upstream WAF rejects some phrases (e.g. "<script>", SQLi) with a non-JSON 403.
            // For a search, that just means "no such parts" — return empty rather than erroring out.
            if (err instanceof TmeApiError && err.code === 'E_HTTP_403') {
                return { items: [], page, pageSize: 0 };
            }
            throw this.mapError(err);
        }
    }

    async getManufacturers(): Promise<ManufacturerRef[]> {
        try {
            return await this.cache.getOrLoad('manufacturers', this.ttl('TME_REF_TTL_MS', 86_400_000), () =>
                this.provider.getManufacturers(),
            );
        } catch (err) {
            throw this.mapError(err);
        }
    }

    async getCategories(): Promise<CategoryNode[]> {
        try {
            return await this.cache.getOrLoad('categories', this.ttl('TME_REF_TTL_MS', 86_400_000), () =>
                this.provider.getCategories(),
            );
        } catch (err) {
            throw this.mapError(err);
        }
    }

    async getProduct(symbol: string): Promise<CatalogPart> {
        this.assertSymbol(symbol);
        try {
            // Cache product detail: an AI design session (and sourcing enrichment) looks up the same
            // symbol repeatedly — dedupe those so we don't hammer (and get rate-limited by) TME.
            return await this.cache.getOrLoad(`product:${symbol}`, this.ttl('TME_PRODUCT_TTL_MS', 300_000), () =>
                this.provider.getProduct(symbol),
            );
        } catch (err) {
            throw this.mapError(err);
        }
    }

    async getComponent(symbol: string): Promise<MappedComponent> {
        // Reuse the cached getProduct fetch (incl. its symbol validation + error mapping), then classify.
        const part = await this.getProduct(symbol);
        return this.mapper.toComponent(part);
    }

    private assertSymbol(symbol: string): void {
        if (!SYMBOL_RE.test(symbol)) {
            throw new BadRequestException('Invalid part symbol.');
        }
    }

    private ttl(key: string, fallback: number): number {
        const raw = this.config.get<string>(key);
        const n = raw ? Number(raw) : NaN;
        return Number.isFinite(n) ? n : fallback;
    }

    private mapError(err: unknown): Error {
        // Provider already-mapped HTTP errors (e.g. NotFound for an unknown symbol) pass through.
        if (err instanceof HttpException) return err;

        if (err instanceof TmeApiError) {
            // Genuine auth/account problem (our credentials) — service-side, not the caller's fault.
            if (err.httpStatus === 401 || err.code === 'E_AUTHORIZATION_FAILED') {
                return new ServiceUnavailableException('Component catalog authorization failed.');
            }
            // The catalog rejected the request parameters.
            if (err.httpStatus === 400 || err.code === 'E_INPUT_PARAMS_VALIDATION_ERROR') {
                return new BadRequestException(`Component catalog rejected the request: ${err.message}`);
            }
            // Anything else from upstream (WAF 403, 5xx, unexpected) — bad gateway, not "service down".
            return new BadGatewayException('Component catalog upstream error.');
        }
        if (err instanceof TmeNetworkError) {
            return new BadGatewayException('Component catalog is currently unreachable.');
        }
        return new BadGatewayException('Component catalog request failed.');
    }
}
