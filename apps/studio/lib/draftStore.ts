/**
 * Where unsaved work survives the browser.
 *
 * WHAT IS ACTUALLY AT RISK. An edit is instant and a save is not: the document lives in React state and
 * reaches the server on a 1.2 s idle debounce. Everything in between is memory only. A crashed tab, a
 * closed laptop, a dropped connection while the save is in flight, or simply a save the server refused —
 * and the last minutes of work exist nowhere. The save path already handles its own failures (a rejected
 * document goes back in `pending` to be retried), but `pending` is a variable in a page that no longer
 * exists once the tab does.
 *
 * TWO RULES SHAPE EVERYTHING HERE.
 *
 *   1. A local copy must NEVER become a second authority. The server holds the draft, and a tab that
 *      quietly restored its own older copy over it would delete a colleague's work while looking like it
 *      recovered yours. So this store only ever OFFERS what it holds; adopting it is a decision the user
 *      makes, with both timestamps in front of them. Nothing here writes to the document automatically.
 *
 *   2. Failing to persist must be LOUD. `localStorage` throws when the origin is out of quota, and in
 *      private-browsing modes it can throw on the first write. A store that swallowed that would leave the
 *      user believing their work was safe — strictly worse than knowing it is not, because it changes what
 *      they do next. Every write returns whether it happened.
 *
 * WHY `localStorage` AND NOT IndexedDB. It is SYNCHRONOUS, which is the property that matters at the one
 * moment that counts: `pagehide` is the last callback a page gets, and an async write started there is not
 * guaranteed to finish. IndexedDB holds more, but "more" is not the constraint — an editor document is
 * components and nets, a few hundred kilobytes at the top end, against a ~5 MB budget. Durability at
 * shutdown beats capacity we do not need.
 */
import type { CircuitJson } from '@circuit-forge/eda-core';

/** One project's unsaved work, with everything needed to judge whether it is worth restoring. */
export interface StoredDraft {
    projectId: string;
    circuit: CircuitJson;
    /**
     * The server `updatedAt` this work was edited ON TOP OF — the same concurrency token the save carries.
     * Kept because it is what distinguishes "unsaved work from my last session" (token matches what the
     * server now holds) from "work built on a version someone has since replaced" (it does not). Those two
     * deserve different words, and without the token they are indistinguishable.
     */
    baseToken: string | null;
    /** Which saved version this draft descends from — dropped on restore would lose the ancestry. */
    baseVersionId: string | null;
    /** When this copy was written locally, ISO. */
    at: string;
}

/** Whether the work is actually on disk. Never a bare `void`: see rule 2 above. */
export type PutResult = { ok: true } | { ok: false; reason: 'quota' | 'unavailable'; message: string };

export interface DraftStore {
    put(draft: StoredDraft): PutResult;
    get(projectId: string): StoredDraft | null;
    clear(projectId: string): void;
    /** Every project holding unsaved work — for a "you have unsaved drafts" surface, and for cleanup. */
    list(): StoredDraft[];
}

const PREFIX = 'circuit-forge.draft.';
const key = (projectId: string): string => `${PREFIX}${projectId}`;

/**
 * Read one entry back, refusing anything that is not a complete draft.
 *
 * A half-written or hand-edited entry reads as NO draft rather than as a draft that explodes later. The
 * shape check is deliberately about the fields this module promises — a circuit with `components` and
 * `nets` arrays — and not the full schema: this is a recovery buffer, and a draft is by nature
 * half-finished. Validating it as a complete circuit would refuse exactly the work most worth recovering.
 */
function parse(raw: string | null): StoredDraft | null {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw) as Partial<StoredDraft>;
        const c = v.circuit as { components?: unknown; nets?: unknown } | undefined;
        if (typeof v.projectId !== 'string' || typeof v.at !== 'string') return null;
        if (!c || !Array.isArray(c.components) || !Array.isArray(c.nets)) return null;
        return {
            projectId: v.projectId,
            circuit: v.circuit as CircuitJson,
            baseToken: typeof v.baseToken === 'string' ? v.baseToken : null,
            baseVersionId: typeof v.baseVersionId === 'string' ? v.baseVersionId : null,
            at: v.at,
        };
    } catch {
        return null;
    }
}

export function browserDraftStore(): DraftStore {
    const available = typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

    return {
        put(draft) {
            if (!available)
                return {
                    ok: false,
                    reason: 'unavailable',
                    message:
                        'This browser has no local storage available, so unsaved work cannot be kept on this device.',
                };
            try {
                window.localStorage.setItem(key(draft.projectId), JSON.stringify(draft));
                return { ok: true };
            } catch {
                // Out of quota, or a private mode that refuses writes. Before giving up, drop OTHER projects'
                // drafts and try once more: the work being edited right now is worth more than a stale copy
                // of a project the user closed, and silently keeping the old one instead is the wrong trade.
                try {
                    for (const k of Object.keys(window.localStorage)) {
                        if (k.startsWith(PREFIX) && k !== key(draft.projectId)) window.localStorage.removeItem(k);
                    }
                    window.localStorage.setItem(key(draft.projectId), JSON.stringify(draft));
                    return { ok: true };
                } catch {
                    return {
                        ok: false,
                        reason: 'quota',
                        message:
                            'There is no room left in this browser’s local storage, so unsaved work is not being kept on this device. It is still being saved to the server.',
                    };
                }
            }
        },

        get(projectId) {
            if (!available) return null;
            return parse(window.localStorage.getItem(key(projectId)));
        },

        clear(projectId) {
            if (!available) return;
            window.localStorage.removeItem(key(projectId));
        },

        list() {
            if (!available) return [];
            const out: StoredDraft[] = [];
            for (const k of Object.keys(window.localStorage)) {
                if (!k.startsWith(PREFIX)) continue;
                const d = parse(window.localStorage.getItem(k));
                if (d) out.push(d);
            }
            return out.sort((a, b) => b.at.localeCompare(a.at));
        },
    };
}

/** For tests and server rendering: the same contract with no browser behind it. */
export function memoryDraftStore(initial: StoredDraft[] = []): DraftStore {
    const held = new Map(initial.map((d) => [d.projectId, d]));
    return {
        put(draft) {
            held.set(draft.projectId, draft);
            return { ok: true };
        },
        get: (projectId) => held.get(projectId) ?? null,
        clear: (projectId) => {
            held.delete(projectId);
        },
        list: () => [...held.values()].sort((a, b) => b.at.localeCompare(a.at)),
    };
}

/** A store that always refuses — for exercising the path where the browser will not keep anything. */
export function refusingDraftStore(reason: 'quota' | 'unavailable' = 'quota'): DraftStore {
    return {
        put: () => ({ ok: false, reason, message: 'refused' }),
        get: () => null,
        clear: () => {},
        list: () => [],
    };
}
