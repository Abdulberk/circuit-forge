/**
 * The orphan-sweep DECISION is pure (mirrors the reaper pattern: pure decision + I/O sweep) — locked
 * here; the list/delete I/O half is proven by the live e2e (real MinIO + real Asset rows).
 */
import { decideOrphans, type SweepableObject } from './admin-storage.service';

const NOW = 1_000_000_000_000;
const obj = (key: string, ageMs: number | null, sizeBytes = 100): SweepableObject => ({
    key,
    lastModified: ageMs === null ? null : new Date(NOW - ageMs),
    sizeBytes,
});
const DAY = 24 * 60 * 60 * 1000;

describe('decideOrphans (pure)', () => {
    it('sweeps only unreferenced objects past the cutoff; keeps referenced and fresh ones', () => {
        const objects = [
            obj('orgs/o1/models/a/kept.lib', 30 * DAY), // referenced → keep
            obj('orgs/o1/models/b/old-orphan.lib', 30 * DAY), // unreferenced + old → sweep
            obj('orgs/o1/models/c/fresh-orphan.lib', 0.5 * DAY), // unreferenced but fresh (commit may be in flight) → keep
        ];
        const referenced = new Set(['orgs/o1/models/a/kept.lib']);
        const r = decideOrphans(objects, referenced, NOW - 7 * DAY);
        expect(r.orphans.map((o) => o.key)).toEqual(['orgs/o1/models/b/old-orphan.lib']);
        expect(r.referenced).toBe(1);
        expect(r.skippedFresh).toBe(1);
    });

    it('never sweeps on missing evidence: an object without LastModified is treated as fresh', () => {
        const r = decideOrphans([obj('orgs/o1/models/x/no-mtime.lib', null)], new Set(), NOW - 7 * DAY);
        expect(r.orphans).toEqual([]);
        expect(r.skippedFresh).toBe(1);
    });

    it('cutoff at "now" (olderThanDays=0) sweeps every unreferenced object with any age', () => {
        const r = decideOrphans(
            [obj('orgs/o1/models/y/just-uploaded.lib', 1000), obj('orgs/o1/models/z/kept.lib', 1000)],
            new Set(['orgs/o1/models/z/kept.lib']),
            NOW,
        );
        expect(r.orphans.map((o) => o.key)).toEqual(['orgs/o1/models/y/just-uploaded.lib']);
        expect(r.referenced).toBe(1);
    });
});
