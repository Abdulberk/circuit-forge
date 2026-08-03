/**
 * Are two stored values the same value?
 *
 * WHY THIS EXISTS AT ALL, rather than `JSON.stringify(a) === JSON.stringify(b)`. Stringify makes KEY ORDER
 * significant, and key order is not preserved anywhere in this system:
 *
 *   • Postgres stores both `circuitJson` and `uiJson` as `jsonb`, which does not keep the order it was given
 *     — it sorts keys by length and then bytewise. A drawing sent as `{schemaVersion, positions, sheetId}`
 *     comes back as `{sheetId, positions, schemaVersion}`, holding exactly the same drawing. Measured
 *     against the live API, not assumed.
 *   • The editor derives its next document with spreads, so which slot a key lands in is an implementation
 *     detail of whichever call site built it.
 *
 * A stringify comparison therefore reports "different" for two identical documents, and every caller of it
 * is a place where that becomes a wrong answer with no error: a gesture that changed nothing commits itself
 * and bumps the concurrency token; a local copy identical to the server's is offered back as unsaved work
 * the user then has to make a decision about. Both read as the editor being confused about its own state.
 *
 * ORDER INSIDE AN ARRAY IS SIGNIFICANT and is compared as such — a wire's points are a path, and the same
 * points in the other order are a different path. Only object keys are order-free.
 *
 * `undefined` is treated as ABSENT on both sides, because that is what a round trip does to it:
 * `{rotation: undefined}` is stored and returned as `{}`. Without that rule the first comparison after any
 * reload would report a change nobody made.
 *
 * The values here are JSON by construction — they are persisted in JSON columns and validated by zod
 * schemas — so these are all the kinds that can occur. There is deliberately no cycle guard: a cycle cannot
 * survive being stored, and adding one would slow down the case that actually happens to defend against a
 * case that cannot.
 */
export function sameJson(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;

    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((item, i) => sameJson(item, b[i]));
    }

    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const present = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined);
    const ka = present(left);
    if (ka.length !== present(right).length) return false;
    return ka.every((k) => Object.hasOwn(right, k) && sameJson(left[k], right[k]));
}
