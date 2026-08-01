'use client';

/**
 * The open document, and the only thing that writes it back.
 *
 * Four things have to be true at once, and each has a specific way of going wrong:
 *
 *   AN EDIT IS INSTANT, A SAVE IS NOT. Typing must not wait for a round trip, so the local document leads and
 *   the save follows on a debounce. The trap is the LAST edit: a naive debounce that is cancelled by unmount
 *   drops whatever was typed in the final second, and the user watches their change disappear on navigation.
 *
 *   THE SAVE MUST BE REFUSABLE. Every save after the first carries `expectedUpdatedAt`, so a second tab
 *   cannot overwrite work it never saw — the API answers 409 instead. That guarantee already exists server
 *   side and has never been used; omitting the token is silently opting into last-writer-wins.
 *
 *   SAVES MUST NOT OVERLAP. The token is the row's `updatedAt`, so two saves in flight would both carry the
 *   same one and the second would be refused by the first's own success. One save at a time, and anything
 *   typed meanwhile is coalesced into the next one.
 *
 *   A CONFLICT IS A STATE, NOT AN ERROR. Reaching it must not throw away the user's document. It is held
 *   intact and offered back, because the alternative — reload and lose it — converts a prevented silent loss
 *   into a loud one.
 */

import type { CircuitJson } from '@circuit-forge/eda-core';
import type { EditResult } from '@circuit-forge/editor-core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, isAbort, type Api, type OpenedProject } from './api';

/** How long a pause in typing counts as "done", before a save is attempted. */
const AUTOSAVE_IDLE_MS = 1_200;

export type SaveState =
    | { status: 'clean'; savedAt: string | null }
    /** Edited locally and not yet sent. */
    | { status: 'dirty' }
    | { status: 'saving' }
    /**
     * Someone else saved first. The local document is UNTOUCHED and still on screen; `theirs` is what the
     * server holds. Nothing is resolved automatically — a merge we invented could silently pick wrong.
     */
    | { status: 'conflict'; theirUpdatedAt: string | null }
    | { status: 'error'; error: ApiError };

export interface DocumentState {
    /** What is on screen. Local edits are applied here immediately, before any save. */
    circuit: CircuitJson | null;
    /** Where it came from — a draft, a saved version, or nothing yet. */
    source: OpenedProject['source'] | null;
    save: SaveState;
    /** The last refusal from an edit, for the field that caused it. Cleared by the next successful edit. */
    refusal: { reason: string; message: string } | null;
    /**
     * Apply an edit. Takes the edit FUNCTION rather than a patch, so validation lives in the kernel and this
     * hook never has to know what a designator is.
     */
    apply: (edit: (circuit: CircuitJson) => EditResult) => void;
    /** Force a save now — for a blur, a keyboard shortcut, or a tab that is closing. */
    flush: () => void;
    /** Give up the local document and take the server's. The only way out of a conflict that loses work. */
    discardLocalAndReload: () => void;
}

export function useDocument(api: Api, projectId: string | null, opened: OpenedProject | null): DocumentState {
    const [circuit, setCircuit] = useState<CircuitJson | null>(null);
    const [source, setSource] = useState<OpenedProject['source'] | null>(null);
    const [save, setSave] = useState<SaveState>({ status: 'clean', savedAt: null });
    const [refusal, setRefusal] = useState<DocumentState['refusal']>(null);
    const [reloadNonce, setReloadNonce] = useState(0);

    /**
     * The concurrency token: the `updatedAt` this client last saw. A ref rather than state because a save
     * that has just completed must hand its new token to the NEXT save without waiting for a render — a
     * render-delayed token would make the following save carry a stale one and be refused by our own write.
     */
    const token = useRef<string | null>(null);
    /** The document a save is currently sending, so a completed save knows whether more was typed meanwhile. */
    const inFlight = useRef<CircuitJson | null>(null);
    const pending = useRef<CircuitJson | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** Set on unmount so a late save completion cannot call setState on a dead component. */
    const alive = useRef(true);

    // ---- Adopt whatever the loader opened -------------------------------------------------------------

    useEffect(() => {
        if (!opened) return;
        setCircuit(opened.source === 'empty' ? null : opened.circuitJson);
        setSource(opened.source);
        // Only a working copy carries a token. Opening a saved VERSION means there is no draft row yet, so
        // the first save must create one — and creating it with a token would be refused, correctly, because
        // there is nothing there to match.
        token.current = opened.source === 'working-copy' ? opened.updatedAt : null;
        setSave({ status: 'clean', savedAt: opened.source === 'working-copy' ? opened.updatedAt : null });
        setRefusal(null);
        pending.current = null;
        inFlight.current = null;
    }, [opened, reloadNonce]);

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    // ---- Saving ---------------------------------------------------------------------------------------

    const send = useCallback(
        async (doc: CircuitJson): Promise<void> => {
            if (!projectId) return;
            inFlight.current = doc;
            setSave({ status: 'saving' });
            try {
                const saved = await api.saveWorkingCopy(projectId, {
                    circuitJson: doc,
                    // Editor state is not modelled yet; `{}` is the truthful value for "there is none",
                    // and it is sent explicitly because the API requires it and a default here would one day
                    // erase a real one.
                    uiJson: {},
                    ...(token.current === null ? {} : { expectedUpdatedAt: token.current }),
                });
                token.current = saved.updatedAt;
                if (!alive.current) return;

                // Anything typed while this was in flight is now the document to send next; without this the
                // last keystrokes of a fast typist would sit unsaved until they typed again.
                const queued = pending.current;
                pending.current = null;
                inFlight.current = null;
                if (queued && queued !== doc) {
                    void send(queued);
                } else {
                    setSave({ status: 'clean', savedAt: saved.updatedAt });
                }
            } catch (err) {
                inFlight.current = null;
                if (!alive.current || isAbort(err)) return;
                const error = err instanceof ApiError ? err : new ApiError('unexpected', String(err));
                // A conflict is its own state and must NOT clear the local document — the user's edits are
                // the thing at risk, and this is the moment they matter most.
                setSave(
                    error.kind === 'conflict'
                        ? {
                              status: 'conflict',
                              theirUpdatedAt:
                                  typeof (error.body as { currentUpdatedAt?: unknown })?.currentUpdatedAt === 'string'
                                      ? (error.body as { currentUpdatedAt: string }).currentUpdatedAt
                                      : null,
                          }
                        : { status: 'error', error },
                );
            }
        },
        [api, projectId],
    );

    const flush = useCallback(() => {
        if (timer.current) {
            clearTimeout(timer.current);
            timer.current = null;
        }
        const doc = pending.current;
        if (!doc) return;
        // One save at a time: the token is the row's `updatedAt`, so a second concurrent save would carry the
        // same one and be refused by the first save's own success — a self-inflicted conflict.
        if (inFlight.current) return;
        pending.current = null;
        void send(doc);
    }, [send]);

    const schedule = useCallback(
        (doc: CircuitJson) => {
            pending.current = doc;
            setSave((s) => (s.status === 'conflict' ? s : { status: 'dirty' }));
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => {
                timer.current = null;
                flush();
            }, AUTOSAVE_IDLE_MS);
        },
        [flush],
    );

    /**
     * A save in flight frees up: send whatever was typed meanwhile.
     *
     * `send` already chains directly, but a save that FAILED leaves `pending` set with no chain — this is the
     * path that picks it up once the user edits again or presses save.
     */
    useEffect(() => {
        if (save.status === 'clean' && pending.current && !inFlight.current) flush();
    }, [save.status, flush]);

    // The last edit must survive leaving the page. A debounce cancelled by unmount silently drops whatever
    // was typed in the final second, which the user experiences as the editor forgetting.
    useEffect(() => {
        return () => {
            if (timer.current) clearTimeout(timer.current);
            const doc = pending.current;
            if (doc && projectId && !inFlight.current) void send(doc);
        };
    }, [send, projectId]);

    // ---- Editing --------------------------------------------------------------------------------------

    const apply = useCallback(
        (edit: (c: CircuitJson) => EditResult) => {
            setCircuit((current) => {
                if (!current) return current;
                const result = edit(current);
                if (!result.ok) {
                    setRefusal({ reason: result.reason, message: result.message });
                    return current;
                }
                setRefusal(null);
                // An edit that changed nothing is not a save and not an undo step — re-typing the same value
                // must not mint a new revision that then conflicts with another tab for no reason.
                if (!result.changed) return current;
                schedule(result.circuit);
                return result.circuit;
            });
        },
        [schedule],
    );

    const discardLocalAndReload = useCallback(() => {
        pending.current = null;
        inFlight.current = null;
        if (timer.current) clearTimeout(timer.current);
        setReloadNonce((n) => n + 1);
    }, []);

    return { circuit, source, save, refusal, apply, flush, discardLocalAndReload };
}
