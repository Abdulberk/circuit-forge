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
import { useCallback, useEffect, useState } from 'react';

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

    useEffect(() => {
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
