import { paginated, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from './pagination.dto';

describe('paginated()', () => {
    it('reports hasMore=true when more rows remain beyond this page', () => {
        expect(paginated([1, 2], 5, 2, 0)).toEqual({ items: [1, 2], total: 5, limit: 2, offset: 0, hasMore: true });
    });

    it('hasMore=false on the last page (offset + returned === total)', () => {
        expect(paginated([5], 5, 2, 4)).toMatchObject({ hasMore: false });
    });

    it('hasMore=false for an empty result', () => {
        expect(paginated([], 0, 50, 0)).toEqual({ items: [], total: 0, limit: 50, offset: 0, hasMore: false });
    });

    it('a partial page (returned < limit but offset+returned === total) is the end', () => {
        // 50-limit page over 3 rows from offset 0 → 3 returned, no more.
        expect(paginated([1, 2, 3], 3, 50, 0).hasMore).toBe(false);
    });

    it('exposes sane default + cap constants', () => {
        expect(DEFAULT_PAGE_LIMIT).toBe(50);
        expect(MAX_PAGE_LIMIT).toBe(100);
    });
});
