'use client';

import { useRef, useState } from 'react';

import { useSession } from '../app/providers';
import { ApiError, isAbort } from '../lib/api';

/**
 * Sign in against the real API.
 *
 * The failure text comes from the error's KIND rather than its message. `unauthenticated` here means the
 * credentials were refused, which is a different sentence from `network`, and showing the server's raw
 * message for both would tell a user with no connection that their password is wrong.
 */
export function SignIn() {
    const { client, refreshSignedIn } = useSession();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inFlight = useRef<AbortController | null>(null);

    const submit = async (e: React.FormEvent): Promise<void> => {
        e.preventDefault();
        // A second submit supersedes the first rather than racing it: two logins in flight would write two
        // token pairs, and the loser's write could land last.
        inFlight.current?.abort();
        const controller = new AbortController();
        inFlight.current = controller;

        setBusy(true);
        setError(null);
        try {
            await client.signIn(email, password, controller.signal);
            refreshSignedIn();
        } catch (err) {
            if (isAbort(err)) return; // superseded, not failed
            setError(
                err instanceof ApiError
                    ? err.kind === 'unauthenticated'
                        ? 'That email and password do not match an account.'
                        : err.kind === 'network'
                          ? // The client already composes the precise sentence, including the CORS
                            // possibility when the API is on another origin. Replacing it here with a
                            // shorter one threw that away — and the shorter one asserted the server was
                            // unreachable, which is exactly the wrong thing to tell someone whose server is
                            // running fine and is simply not allowing their page.
                            err.message
                          : err.message
                    : 'Sign-in failed.',
            );
        } finally {
            // Only the request that is still current may clear the flag; an aborted one clearing it would
            // re-enable the button while its replacement is still running.
            if (inFlight.current === controller) setBusy(false);
        }
    };

    return (
        <div className="signin">
            {/* `void`, not the async function itself: React ignores the returned promise, so a rejection
                would surface as an unhandled rejection with no stack that points here. `submit` catches its
                own failures, and this states that the caller is deliberately not awaiting it. */}
            <form
                onSubmit={(e) => {
                    void submit(e);
                }}
            >
                <h1>
                    Circuit<span style={{ color: 'var(--copper)' }}>Forge</span> Studio
                </h1>
                <label>
                    Email
                    <input
                        type="email"
                        value={email}
                        autoComplete="username"
                        required
                        onChange={(e) => setEmail(e.target.value)}
                    />
                </label>
                <label>
                    Password
                    <input
                        type="password"
                        value={password}
                        autoComplete="current-password"
                        required
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </label>
                <button type="submit" disabled={busy}>
                    {busy ? 'Signing in…' : 'Sign in'}
                </button>
                {error && (
                    <div className="notice bad" role="alert">
                        {error}
                    </div>
                )}
            </form>
        </div>
    );
}
