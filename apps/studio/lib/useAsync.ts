'use client';

/**
 * Run an API call for as long as the component wants it, and not one moment longer.
 *
 * Two failures this exists to prevent, both invisible in a click-through and both certain in a real editor:
 *
 *   THE ABORTED CALL REPORTED AS AN ERROR. A component that unmounts cancels its request. React 19's strict
 *   mode mounts every effect twice in development, so this happens on the FIRST render of every screen. Left
 *   unhandled the UI opens with an error banner it caused itself, and developers learn to ignore the banner.
 *
 *   THE LATE RESPONSE THAT OVERWRITES THE CURRENT ONE. Switch project A → B and the two requests race; if A
 *   answers second, the panel shows A's design under B's name, with nothing wrong anywhere. The abort makes
 *   that impossible rather than unlikely: A's controller is aborted the instant B starts, so A's `setState`
 *   never runs.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, isAbort } from './api';

export interface AsyncState<T> {
    data: T | null;
    error: ApiError | null;
    loading: boolean;
    /** Re-run the call. Supersedes anything in flight. */
    reload: () => void;
}

/**
 * @param run       the call, which MUST forward the signal it is given
 * @param deps      when to re-run — the same contract as `useEffect`
 * @param enabled   false leaves the hook idle without calling; for a request that needs a selection first
 */
export function useAsync<T>(
    run: (signal: AbortSignal) => Promise<T>,
    deps: React.DependencyList,
    enabled = true,
): AsyncState<T> {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<ApiError | null>(null);
    const [loading, setLoading] = useState(enabled);
    const [nonce, setNonce] = useState(0);

    // The callback is re-created only when the caller's deps change, which is what makes the effect below
    // run exactly when it should. `run` itself is deliberately not a dependency: it is an inline closure at
    // every call site, so depending on it would re-run the request on every render, forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const call = useCallback(run, deps);

    // What the last effect run was FOR. `call` changes exactly when the caller's deps change, so it is the
    // identity of the question being asked — distinct from `reload()`, which re-asks the same one.
    const askedFor = useRef(call);

    useEffect(() => {
        // THE STALE ANSWER. Aborting stops a late write; it does nothing about the value already in state.
        // `data` was never cleared, so switching to an organisation with no projects left the previous
        // project's document on screen: `enabled` went false, the effect returned early, and the pane went on
        // rendering that design — its tree, its "Draft · saved <timestamp>", its component counts — under the
        // new organisation's name, with no spinner and no error. It looked like a settled, correct screen.
        // Not a flash: it persisted until something else happened to load.
        //
        // Cleared on a KEY change only. Doing it on `reload()` as well would blank the pane on every manual
        // refresh, which is the opposite complaint.
        if (askedFor.current !== call || !enabled) {
            askedFor.current = call;
            setData(null);
            setError(null);
        }

        if (!enabled) {
            setLoading(false);
            return;
        }
        const controller = new AbortController();
        setLoading(true);
        setError(null);

        call(controller.signal)
            .then((value) => {
                if (controller.signal.aborted) return;
                setData(value);
            })
            .catch((err: unknown) => {
                if (controller.signal.aborted || isAbort(err)) return;
                setError(err instanceof ApiError ? err : new ApiError('unexpected', String(err)));
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });

        return () => controller.abort();
    }, [call, enabled, nonce]);

    const reload = useCallback(() => setNonce((n) => n + 1), []);
    return { data, error, loading, reload };
}
