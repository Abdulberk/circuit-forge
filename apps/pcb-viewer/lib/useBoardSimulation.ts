'use client';

/**
 * Loading a board's real simulation on demand.
 *
 * The two files are produced by `scripts/gen-gallery.mjs` from the SAME pcb-core layout and the SAME
 * ngspice the product runs — not authored for the viewer. So what animates here is what the simulator
 * measured, and a board that cannot be simulated arrives carrying the reason rather than an empty file.
 *
 * Cancellation is not decoration: switching boards mid-fetch must not let a late response paint the wrong
 * board, and an unmount must not set state on a dead component. One AbortController per request, aborted
 * by the effect's own cleanup, covers both.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { buildPlayback, type BoardLayout, type BoardSim, type Playback, type SimulationCoverage } from './simulation';

export type BoardSimulation =
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'ready'; playback: Playback; layout: BoardLayout; coverage?: SimulationCoverage }
    | { kind: 'unavailable'; reason: string; coverage?: SimulationCoverage };

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return (await res.json()) as T;
}

export function useBoardSimulation(boardId: string, baseUrl: (id: string, ext: string) => string) {
    const [state, setState] = useState<BoardSimulation>({ kind: 'idle' });
    const abort = useRef<AbortController | null>(null);

    // A board change invalidates any simulation on screen: the old playback belongs to the old copper.
    useEffect(() => {
        abort.current?.abort();
        abort.current = null;
        setState({ kind: 'idle' });
    }, [boardId]);

    // Unmount must cancel too, or a resolving fetch calls setState on a component that is gone.
    useEffect(() => () => abort.current?.abort(), []);

    const run = useCallback(async () => {
        abort.current?.abort();
        const ctl = new AbortController();
        abort.current = ctl;
        setState({ kind: 'running' });
        try {
            const [layout, sim] = await Promise.all([
                fetchJson<BoardLayout>(baseUrl(boardId, 'layout.json'), ctl.signal),
                fetchJson<BoardSim>(baseUrl(boardId, 'sim.json'), ctl.signal),
            ]);
            if (ctl.signal.aborted) return;

            const coverage = sim.coverage;
            if (!sim.available) {
                setState({ kind: 'unavailable', reason: sim.reason, coverage });
                return;
            }
            const playback = buildPlayback(layout, sim);
            if (!playback) {
                // The run produced data, but none of it lands on copper — a distinct fact from "no run", and
                // the coverage report usually says why (the IC that owns those nets was never in the deck).
                setState({
                    kind: 'unavailable',
                    reason: 'the simulation ran, but none of its signals belong to a net that carries copper on this board',
                    coverage,
                });
                return;
            }
            setState({ kind: 'ready', playback, layout, coverage });
        } catch (e) {
            if (ctl.signal.aborted || (e as Error)?.name === 'AbortError') return;
            setState({ kind: 'unavailable', reason: `simulation data could not be loaded: ${(e as Error).message}` });
        }
    }, [boardId, baseUrl]);

    const stop = useCallback(() => {
        abort.current?.abort();
        abort.current = null;
        setState({ kind: 'idle' });
    }, []);

    return { state, run, stop };
}
