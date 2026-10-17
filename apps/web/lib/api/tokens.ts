/**
 * Where the session lives.
 *
 * Behind an interface on purpose. This app stores tokens in `localStorage`, which is the ordinary choice for
 * a bearer-token client and the wrong one for a product that has to survive XSS — there, the refresh token
 * belongs in an httpOnly cookie the page cannot read. Keeping the store pluggable means that change is one
 * implementation swapped at the composition root, not an edit to every call site, and it keeps the decision
 * VISIBLE: a reader can see which store is installed instead of discovering `localStorage.getItem` scattered
 * through the codebase.
 */
export interface Tokens {
    accessToken: string;
    refreshToken: string;
}

export interface TokenStore {
    read(): Tokens | null;
    write(tokens: Tokens): void;
    clear(): void;
    /**
     * Called when the session changes in ANOTHER tab. The API rotates refresh tokens on every use — the old
     * one is invalidated — so two tabs refreshing independently will log each other out. Observing the change
     * lets a tab adopt the new pair instead of racing it. Returns its own unsubscribe.
     */
    subscribe(onExternalChange: (tokens: Tokens | null) => void): () => void;
}

const KEY = 'circuit-forge.session';

const parse = (raw: string | null): Tokens | null => {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw) as Partial<Tokens>;
        // A half-written or hand-edited entry reads as no session rather than as a session that fails later
        // with an unexplainable 401.
        return typeof v.accessToken === 'string' && typeof v.refreshToken === 'string'
            ? { accessToken: v.accessToken, refreshToken: v.refreshToken }
            : null;
    } catch {
        return null;
    }
};

/**
 * The browser store.
 *
 * An in-memory mirror sits in front of `localStorage` so a read costs nothing on the hot path, and so the
 * client still works during server rendering and in tests, where `localStorage` does not exist. The mirror is
 * kept in step with other tabs through the `storage` event, which fires only for changes made ELSEWHERE —
 * exactly the case that needs handling.
 */
export function browserTokenStore(): TokenStore {
    const available = typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
    let mirror: Tokens | null = available ? parse(window.localStorage.getItem(KEY)) : null;

    return {
        read: () => mirror,
        write(tokens) {
            mirror = tokens;
            if (available) window.localStorage.setItem(KEY, JSON.stringify(tokens));
        },
        clear() {
            mirror = null;
            if (available) window.localStorage.removeItem(KEY);
        },
        subscribe(onExternalChange) {
            if (!available) return () => {};
            const onStorage = (e: StorageEvent) => {
                if (e.key !== null && e.key !== KEY) return; // `null` means the whole store was cleared
                mirror = parse(window.localStorage.getItem(KEY));
                onExternalChange(mirror);
            };
            window.addEventListener('storage', onStorage);
            return () => window.removeEventListener('storage', onStorage);
        },
    };
}

/** For tests and for server rendering: a store with no browser behind it. */
export function memoryTokenStore(initial: Tokens | null = null): TokenStore {
    let held = initial;
    return {
        read: () => held,
        write: (t) => {
            held = t;
        },
        clear: () => {
            held = null;
        },
        subscribe: () => () => {},
    };
}
