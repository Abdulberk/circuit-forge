'use client';

import { useRef, useState } from 'react';

import { useSession } from '../app/providers';
import { ApiError, isAbort } from '../lib/api';

import { Brand } from './shell/Brand';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { Field, Input } from './ui/Input';
import { ThemeToggle } from './ui/ThemeToggle';

type Mode = 'sign-in' | 'register';

/**
 * Sign in against the real API.
 *
 * The failure text comes from the error's KIND rather than its message. `unauthenticated` here means the
 * credentials were refused, which is a different sentence from `network`, and showing the server's raw
 * message for both would tell a user with no connection that their password is wrong.
 */
export function SignIn({ onSignedIn }: { onSignedIn?: () => void } = {}) {
    const { client, refreshSignedIn } = useSession();
    const [mode, setMode] = useState<Mode>('sign-in');
    const [name, setName] = useState('');
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
            if (mode === 'register') await client.register(name, email, password, controller.signal);
            else await client.signIn(email, password, controller.signal);
            refreshSignedIn();
            onSignedIn?.();
        } catch (err) {
            if (isAbort(err)) return; // superseded, not failed
            setError(
                err instanceof ApiError
                    ? err.kind === 'unauthenticated'
                        ? 'That email and password do not match an account.'
                        : err.kind === 'conflict'
                          ? 'An account with that email already exists. Sign in instead.'
                          : err.kind === 'invalid' && err.details?.length
                            ? err.details.join(' ')
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

    const registering = mode === 'register';

    return (
        <div className="relative grid min-h-screen place-items-center bg-bg px-4">
            <div className="absolute top-4 right-4">
                <ThemeToggle />
            </div>
            <div className="w-full max-w-sm">
                <div className="mb-8 flex justify-center">
                    <Brand href="/login" />
                </div>
                <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
                    <h1 className="text-lg font-semibold text-fg">{registering ? 'Create your account' : 'Sign in'}</h1>
                    <p className="mt-1 text-sm text-muted">
                        {registering
                            ? 'Your account comes with a workspace for your projects.'
                            : 'Welcome back. Pick up where you left off.'}
                    </p>

                    {/* `void`, not the async function itself: React ignores the returned promise, so a
                        rejection would surface as an unhandled rejection with no stack that points here. */}
                    <form
                        className="mt-6 grid gap-4"
                        onSubmit={(e) => {
                            void submit(e);
                        }}
                    >
                        {registering && (
                            <Field label="Name" htmlFor="name">
                                <Input
                                    id="name"
                                    value={name}
                                    autoComplete="name"
                                    required
                                    onChange={(e) => setName(e.target.value)}
                                />
                            </Field>
                        )}
                        <Field label="Email" htmlFor="email">
                            <Input
                                id="email"
                                type="email"
                                value={email}
                                autoComplete="username"
                                required
                                onChange={(e) => setEmail(e.target.value)}
                            />
                        </Field>
                        <Field
                            label="Password"
                            htmlFor="password"
                            hint={registering ? 'At least 8 characters.' : undefined}
                        >
                            <Input
                                id="password"
                                type="password"
                                value={password}
                                autoComplete={registering ? 'new-password' : 'current-password'}
                                minLength={registering ? 8 : undefined}
                                required
                                onChange={(e) => setPassword(e.target.value)}
                            />
                        </Field>
                        {error && <Alert tone="bad">{error}</Alert>}
                        <Button type="submit" variant="primary" disabled={busy} className="w-full">
                            {busy
                                ? registering
                                    ? 'Creating account…'
                                    : 'Signing in…'
                                : registering
                                  ? 'Create account'
                                  : 'Sign in'}
                        </Button>
                    </form>
                </div>
                <p className="mt-4 text-center text-sm text-muted">
                    {registering ? 'Already have an account?' : 'New to Circuit Forge?'}{' '}
                    <button
                        type="button"
                        className="cursor-pointer font-medium text-accent hover:underline"
                        onClick={() => {
                            setMode(registering ? 'sign-in' : 'register');
                            setError(null);
                        }}
                    >
                        {registering ? 'Sign in' : 'Create an account'}
                    </button>
                </p>
            </div>
        </div>
    );
}
