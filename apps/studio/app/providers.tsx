'use client';

/**
 * One client, one session, for the whole app.
 *
 * The client is created ONCE per browser session and held in a ref rather than rebuilt on render. That is not
 * a micro-optimisation: the client owns the in-flight refresh promise, so a second instance would refresh
 * with a token the first has already rotated away — the exact race `ApiClient` exists to prevent,
 * reintroduced by constructing it twice.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Api, ApiClient, API_BASE_URL } from '../lib/api';

interface Session {
    api: Api;
    client: ApiClient;
    /** Null until the first client render: the server cannot know whether this browser holds a session. */
    signedIn: boolean | null;
    refreshSignedIn: () => void;
}

const SessionContext = createContext<Session | null>(null);

export function Providers({ children }: { children: ReactNode }) {
    const [signedIn, setSignedIn] = useState<boolean | null>(null);

    // A ref, not `useMemo`: memo is a cache React is free to discard, and a discarded client would take the
    // in-flight refresh with it.
    const clientRef = useRef<ApiClient | null>(null);
    if (clientRef.current === null) {
        clientRef.current = new ApiClient({
            baseUrl: API_BASE_URL,
            onSessionLost: () => setSignedIn(false),
        });
    }
    const client = clientRef.current;
    const api = useMemo(() => new Api(client), [client]);

    useEffect(() => {
        // Read the store only on the client. Doing it during render would make the server produce "signed
        // out" and the browser "signed in" from the same component, which React reports as a hydration
        // mismatch and resolves by throwing the server's markup away.
        setSignedIn(client.authenticated);
        // Another tab signing in or out changes this one too — the refresh token it rotates is shared.
        return client.store.subscribe((tokens) => setSignedIn(tokens !== null));
    }, [client]);

    const value = useMemo<Session>(
        () => ({ api, client, signedIn, refreshSignedIn: () => setSignedIn(client.authenticated) }),
        [api, client, signedIn],
    );

    return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
    const ctx = useContext(SessionContext);
    // Thrown rather than defaulted: a component rendered outside the provider would otherwise get a client
    // with no session and report "not signed in", sending a developer to debug auth instead of the tree.
    if (!ctx) throw new Error('useSession must be used inside <Providers>.');
    return ctx;
}
