/**
 * Every id the seed hard-codes must be addressable by the routes that serve it.
 *
 * The demo organization was seeded with `id: 'demo-org-id'` — readable, and rejected by all fourteen
 * `/orgs/:orgId/...` routes, every one of which validates with `ParseUUIDPipe`. The demo account could
 * authenticate, list its organizations, and then receive `400 Validation failed (uuid is expected)` for
 * anything inside them. Its four seeded projects were unreachable through the API that exists to serve
 * them, and because the error named a UUID rather than the seed, it read as a client bug.
 *
 * This is a lint, not an integration test: it reads the seed SOURCE, so it costs nothing and cannot be
 * skipped for want of a database. Anything that looks like a hard-coded id assigned to a persisted `id`
 * field has to be a UUID the pipe would accept.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { ParseUUIDPipe } from '@nestjs/common';

const SEED = readFileSync(join(__dirname, '..', 'prisma', 'seed.ts'), 'utf8');

/** The exact validator the routes use, so this cannot drift from what production accepts. */
const pipe = new ParseUUIDPipe();
const accepted = async (value: string): Promise<boolean> =>
    pipe
        .transform(value, { type: 'param' })
        .then(() => true)
        .catch(() => false);

describe('the seed produces ids the API can address', () => {
    it('looks rows up by ids the routes would accept', async () => {
        // Scoped to `where: { id: ... }` deliberately. A first attempt matched every `id:` in the file and
        // reported 120 failures — all of them CircuitJson component and net ids ('r1', 'vin', 'gnd'), which
        // are design identifiers, have nothing to do with the database, and are correctly not UUIDs.
        //
        // `where: { id: X }` is the precise site of the bug class: a seed pins a primary key so that
        // re-seeding upserts instead of duplicating, and that pinned value is exactly what the routes will
        // later be asked to parse. Narrow and true beats broad and noisy — a gate that cries wolf 120 times
        // gets deleted.
        // Two forms, because fixing this bug moved the value out of the literal: `where: { id: '...' }` and
        // the `const SOMETHING_ID = '...'` such a lookup now refers to. Checking only the first would have
        // passed VACUOUSLY the moment the offending id became a constant — the gate would have gone green by
        // the same edit that could have reintroduced the defect.
        const pinned = [
            ...[...SEED.matchAll(/where:\s*\{\s*id:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!),
            ...[...SEED.matchAll(/\bconst\s+[A-Z][A-Z0-9_]*_ID\s*=\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!),
        ];
        expect(pinned.length).toBeGreaterThan(0); // neither pattern matching means this asserts nothing

        const rejected: string[] = [];
        for (const value of pinned) {
            if (!(await accepted(value))) rejected.push(value);
        }
        expect(rejected).toEqual([]);
    });

    it('pins the demo org to a constant rather than generating one, so re-seeding is idempotent', () => {
        // A generated id would make every `pnpm db:seed` add another Demo Organization.
        expect(SEED).toMatch(/const DEMO_ORG_ID = '[0-9a-f-]{36}'/);
    });

    it('proves the pipe really does reject the old value — otherwise this file guards nothing', async () => {
        await expect(accepted('demo-org-id')).resolves.toBe(false);
        await expect(accepted('00000000-0000-4000-8000-000000000001')).resolves.toBe(true);
    });
});
