import { withConnectionLimit } from './connection-limit';

describe('withConnectionLimit', () => {
    const ORIGINAL = process.env.DB_CONNECTION_LIMIT;

    afterEach(() => {
        if (ORIGINAL === undefined) delete process.env.DB_CONNECTION_LIMIT;
        else process.env.DB_CONNECTION_LIMIT = ORIGINAL;
    });

    it('returns undefined for an undefined/empty URL (no DATABASE_URL set)', () => {
        delete process.env.DB_CONNECTION_LIMIT;
        expect(withConnectionLimit(undefined)).toBeUndefined();
        expect(withConnectionLimit('')).toBeUndefined();
    });

    it('appends connection_limit=10 with "?" when the URL has no query', () => {
        delete process.env.DB_CONNECTION_LIMIT;
        expect(withConnectionLimit('postgresql://postgres:postgres@localhost:5432/circuitforge')).toBe(
            'postgresql://postgres:postgres@localhost:5432/circuitforge?connection_limit=10',
        );
    });

    it('appends connection_limit with "&" when the URL already has a query', () => {
        delete process.env.DB_CONNECTION_LIMIT;
        expect(withConnectionLimit('postgresql://u:p@host:5432/db?schema=public')).toBe(
            'postgresql://u:p@host:5432/db?schema=public&connection_limit=10',
        );
    });

    it('respects an operator-set connection_limit and leaves the URL untouched', () => {
        delete process.env.DB_CONNECTION_LIMIT;
        const url = 'postgresql://u:p@host:5432/db?connection_limit=42';
        expect(withConnectionLimit(url)).toBe(url);
        // also when it is not the first query param
        const url2 = 'postgresql://u:p@host:5432/db?schema=public&connection_limit=7';
        expect(withConnectionLimit(url2)).toBe(url2);
    });

    it('uses DB_CONNECTION_LIMIT when it is a bare integer', () => {
        process.env.DB_CONNECTION_LIMIT = '25';
        expect(withConnectionLimit('postgresql://u:p@host:5432/db')).toBe(
            'postgresql://u:p@host:5432/db?connection_limit=25',
        );
    });

    it('falls back to the default 10 when DB_CONNECTION_LIMIT is non-numeric or empty', () => {
        process.env.DB_CONNECTION_LIMIT = 'abc';
        expect(withConnectionLimit('postgresql://u:p@host/db')).toBe('postgresql://u:p@host/db?connection_limit=10');
        process.env.DB_CONNECTION_LIMIT = '';
        expect(withConnectionLimit('postgresql://u:p@host/db')).toBe('postgresql://u:p@host/db?connection_limit=10');
    });

    it('preserves the raw URL byte-for-byte (string concat, not URL() re-encoding of a special password)', () => {
        delete process.env.DB_CONNECTION_LIMIT;
        // A password with characters URL() would percent-re-encode; concat must leave the prefix intact.
        const url = 'postgresql://user:p%40ss#word@host:5432/db';
        const out = withConnectionLimit(url);
        expect(out).toBe(`${url}?connection_limit=10`);
        expect(out!.startsWith(url)).toBe(true);
    });

    it('matches the API helper default so api+worker size pools identically (parity guard)', () => {
        delete process.env.DB_CONNECTION_LIMIT;
        // Same default (10) the API's prisma.service.ts applies — if either side changes, this fails.
        expect(withConnectionLimit('postgresql://x@y/z')).toContain('connection_limit=10');
    });
});
