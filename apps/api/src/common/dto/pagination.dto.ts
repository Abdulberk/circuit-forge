/**
 * Shared pagination — bounds every list endpoint so a large org/project can't pull thousands of rows (and tens
 * of MB) in one request, and gives clients a stable { items, total, limit, offset, hasMore } envelope to page
 * with. limit is capped server-side (a client can't ask for everything), and an absent/blank query still
 * applies the default cap — so even a naive caller is bounded.
 */
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export class PaginationQueryDto {
    @ApiPropertyOptional({ description: `Max items to return (1..${MAX_PAGE_LIMIT})`, default: DEFAULT_PAGE_LIMIT })
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(MAX_PAGE_LIMIT)
    @IsOptional()
    limit: number = DEFAULT_PAGE_LIMIT;

    @ApiPropertyOptional({ description: 'Number of items to skip', default: 0 })
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @IsOptional()
    offset: number = 0;
}

export interface Paginated<T> {
    items: T[];
    total: number;
    limit: number;
    offset: number;
    /** True when more rows exist beyond this page (offset + returned < total). */
    hasMore: boolean;
}

/** Build the response envelope. `total` is the full count for the scope (not just this page). */
export function paginated<T>(items: T[], total: number, limit: number, offset: number): Paginated<T> {
    return { items, total, limit, offset, hasMore: offset + items.length < total };
}
