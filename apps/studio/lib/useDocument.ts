'use client';

/**
 * The open document, and the only thing that writes it back.
 *
 * WHAT THIS HAS TO GET RIGHT, and how each one went wrong the first time:
 *
 *   AN EDIT IS INSTANT, A SAVE IS NOT. Typing must not wait for a round trip, so the local document leads and
 *   the save follows on a debounce. The trap is the LAST edit: a debounce cancelled by unmount drops whatever
 *   was typed in the final second, and the user watches their change disappear on navigation.
 *
 *   THE SAVE MUST BE REFUSABLE. Every save after the first carries `expectedUpdatedAt`, so a second tab
 *   cannot overwrite work it never saw. Omitting the token is silently choosing last-writer-wins.
 *
 *   SAVES MUST NOT OVERLAP. The token is the row's `updatedAt`, so two saves in flight would both carry the
 *   same one and the second would be refused by the first's own success.
 *
 *   A CONFLICT MUST HAVE A WAY OUT THAT KEEPS THE WORK — and this is where the first version failed
 *   completely. It offered two buttons and BOTH were no-ops. "Save mine anyway" called `flush`, which reads
 *   `pending`, which the failing save had already cleared and the error path never restored; and even with a
 *   document it re-sent the same stale token, which the server refuses by definition — a 409 loop forever.
 *   "Discard mine, load theirs" never contacted the server at all: it re-adopted the cached document and
 *   re-installed the same rejected token, leaving the project permanently unsaveable. The tests passed
 *   because the fake server ignored the token and the test itself performed the reload the app never did.
 *   A conflict is the one moment the user's work is genuinely at risk, and it had exactly zero real exits.
 *
 *   EVERYTHING IS SCOPED TO A PROJECT. The refs were not, so a save that landed after a project switch wrote
 *   one project's circuit into another's draft, poisoned the new project's token, and reported "saved" for a
 *   document that was never sent. Every async completion now checks it is still talking about the project it
 *   started from.
 */

import type { CircuitJson } from '@circuit-forge/eda-core';
import {
    adopt as adoptDocument,
    canRedo as canRedoRevision,
    canUndo as canUndoRevision,
    commit,
    redo as redoRevision,
    undo as undoRevision,
    type EditResult,
    type History,
} from '@circuit-forge/editor-core';
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
     * Someone else saved first. The local document is UNTOUCHED and still on screen; `theirUpdatedAt` is what
     * the server holds. Nothing is resolved automatically — a merge we invented could silently pick wrong.
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
    /** Apply several edits as ONE revision — one undo step, and impossible to half-apply. */
    applyMany: (label: string, edits: ReadonlyArray<(circuit: CircuitJson) => EditResult>) => void;
    undo: () => void;
    redo: () => void;
    canUndo: boolean;
    canRedo: boolean;
    /** Save now — for a blur, a keyboard shortcut, or a tab that is closing. */
    flush: () => void;
    /**
     * Resolve a conflict by keeping MINE: re-send the local document with no precondition, deliberately
     * overwriting whatever is on the server. The only honest way to force a save — retrying with the token
     * that was just refused can never succeed.
     */
    overwriteWithMine: () => void;
    /** Resolve a conflict by taking THEIRS: fetch the server's document and adopt it, discarding local work. */
    takeTheirs: () => void;
}

export function useDocument(
    api: Api,
    projectId: string | null,
    opened: OpenedProject | null,
    /** Re-fetch the project. Required, because "load theirs" is meaningless without asking the server. */
    reloadOpened: () => void,
): DocumentState {
    const [history, setHistory] = useState<History | null>(null);
    const [source, setSource] = useState<OpenedProject['source'] | null>(null);
    const [save, setSave] = useState<SaveState>({ status: 'clean', savedAt: null });
    const [refusal, setRefusal] = useState<DocumentState['refusal']>(null);

    /**
     * Everything mutable, in one object keyed by the project it belongs to.
     *
     * Separate refs could not express "these all belong to project X": a save resolving after a switch would
     * find the token ref already replaced by the new project's, write its own `updatedAt` into it, and the
     * next save for the NEW project would carry a token minted for the old one. Bundling them means a
     * completion can compare one field and know whether it is still relevant.
     */
    const w = useRef<{
        projectId: string | null;
        /** The `updatedAt` this client last saw — the concurrency token. */
        token: string | null;
        /** Which saved version this draft descends from; must survive every circuit-only autosave. */
        baseVersionId: string | null;
        /** Typed but not yet sent. */
        pending: CircuitJson | null;
        /** Currently being sent. Non-null means a save is open and nothing else may start. */
        inFlight: CircuitJson | null;
        timer: ReturnType<typeof setTimeout> | null;
        alive: boolean;
    }>({
        projectId: null,
        token: null,
        baseVersionId: null,
        pending: null,
        inFlight: null,
        timer: null,
        alive: true,
    });

    useEffect(() => {
        const state = w.current;
        state.alive = true;
        return () => {
            state.alive = false;
        };
    }, []);

    // ---- Adopt whatever the loader opened -------------------------------------------------------------

    useEffect(() => {
        if (!opened || !projectId) return;
        const state = w.current;

        // Switching projects with unsent edits: send them BEFORE dropping them on the floor. The alternative
        // is that clicking another project in the picker silently discards the last second of typing.
        if (state.projectId !== null && state.projectId !== projectId && state.pending && !state.inFlight) {
            void sendFor(state.projectId, state.pending, state.token, state.baseVersionId);
        }
        if (state.timer) clearTimeout(state.timer);

        state.projectId = projectId;
        state.pending = null;
        state.inFlight = null;
        state.timer = null;
        // Only a working copy carries a token. Opening a saved VERSION means there is no draft row yet, so
        // the first save must create one — and creating it with a token would be refused, correctly, because
        // there is nothing there to match.
        state.token = opened.source === 'working-copy' ? opened.updatedAt : null;
        // Provenance the API models and this hook used to drop: a draft opened FROM a version descends from
        // it, and every circuit-only autosave must carry that forward or the ancestry is lost on the first
        // keystroke.
        state.baseVersionId =
            opened.source === 'working-copy'
                ? opened.baseVersionId
                : opened.source === 'version'
                  ? opened.version.id
                  : null;

        // ADOPT, not commit: a document from the server, a project switch or a reload is work this history
        // did not witness, and undoing across it would resurrect what the other author had replaced.
        setHistory(opened.source === 'empty' ? null : adoptDocument({ circuit: opened.circuitJson, ui: {} }));
        setSource(opened.source);
        setSave({ status: 'clean', savedAt: opened.source === 'working-copy' ? opened.updatedAt : null });
        setRefusal(null);
        // `sendFor` is stable for the life of the hook; including it would re-adopt on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opened, projectId]);

    // ---- Saving ---------------------------------------------------------------------------------------

    /**
     * Send one document for one project.
     *
     * Takes the project, the token and the provenance as ARGUMENTS rather than reading refs at completion
     * time, so a save that resolves after a switch cannot write its result into the new project's state.
     * `token === null` means "no precondition" — used for the first save of a new draft, and deliberately for
     * the force-overwrite path.
     */
    const sendFor = useCallback(
        async (
            forProject: string,
            doc: CircuitJson,
            token: string | null,
            baseVersionId: string | null,
        ): Promise<void> => {
            const state = w.current;
            state.inFlight = doc;
            if (state.projectId === forProject) setSave({ status: 'saving' });

            try {
                const saved = await api.saveWorkingCopy(forProject, {
                    circuitJson: doc,
                    // Editor state is not modelled yet; `{}` is the truthful value for "there is none".
                    uiJson: {},
                    ...(baseVersionId === null ? {} : { baseVersionId }),
                    ...(token === null ? {} : { expectedUpdatedAt: token }),
                });

                // Anything that happens from here is only about the project this save was FOR. A completion
                // for a project the user has already left updates nothing — it was a flush on the way out.
                if (!state.alive || state.projectId !== forProject) {
                    if (state.inFlight === doc) state.inFlight = null;
                    return;
                }

                state.token = saved.updatedAt;
                state.baseVersionId = saved.baseVersionId;
                state.inFlight = null;

                // Anything typed while this was in flight is now the document to send next; without this the
                // last keystrokes of a fast typist would sit unsaved until they typed again.
                const queued = state.pending;
                state.pending = null;
                if (queued && queued !== doc) {
                    void sendFor(forProject, queued, state.token, state.baseVersionId);
                } else {
                    setSave({ status: 'clean', savedAt: saved.updatedAt });
                }
            } catch (err) {
                if (state.inFlight === doc) state.inFlight = null;
                if (!state.alive || state.projectId !== forProject || isAbort(err)) return;

                // The document that failed goes BACK in the queue. Without this the retry and force-overwrite
                // paths have nothing to send — which is precisely how both conflict buttons became no-ops.
                if (!state.pending) state.pending = doc;

                const error = err instanceof ApiError ? err : new ApiError('unexpected', String(err));
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
        [api],
    );

    const flush = useCallback(() => {
        const state = w.current;
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
        const doc = state.pending;
        if (!doc || !state.projectId) return;
        // One save at a time: the token is the row's `updatedAt`, so a second concurrent save would carry the
        // same one and be refused by the first save's own success — a self-inflicted conflict.
        if (state.inFlight) return;
        state.pending = null;
        void sendFor(state.projectId, doc, state.token, state.baseVersionId);
    }, [sendFor]);

    const schedule = useCallback(
        (doc: CircuitJson) => {
            const state = w.current;
            state.pending = doc;
            setSave((s) => (s.status === 'conflict' ? s : { status: 'dirty' }));
            if (state.timer) clearTimeout(state.timer);
            state.timer = setTimeout(() => {
                state.timer = null;
                flush();
            }, AUTOSAVE_IDLE_MS);
        },
        [flush],
    );

    // The last edit must survive leaving the page. A debounce cancelled by unmount silently drops whatever
    // was typed in the final second, which the user experiences as the editor forgetting.
    useEffect(() => {
        const state = w.current;
        return () => {
            if (state.timer) clearTimeout(state.timer);
            if (state.pending && state.projectId && !state.inFlight) {
                void sendFor(state.projectId, state.pending, state.token, state.baseVersionId);
            }
        };
    }, [sendFor]);

    // ---- Editing --------------------------------------------------------------------------------------

    /**
     * Apply one or more edits as ONE revision.
     *
     * A list rather than a single edit, because that is what makes a compound operation — delete a part and
     * every wire on it — a single undo step and impossible to half-apply. The kernel refuses the whole commit
     * if any member is refused, so there is no partial state for this hook to clean up.
     */
    const applyMany = useCallback(
        (label: string, edits: ReadonlyArray<(c: CircuitJson) => EditResult>) => {
            setHistory((current) => {
                if (!current) return current;
                const result = commit(current, label, edits);
                if (!result.ok) {
                    setRefusal({ reason: result.reason, message: result.message });
                    return current;
                }
                setRefusal(null);
                // A commit that changed nothing is not a save and not an undo step — re-typing the same value
                // must not mint a revision that then conflicts with another tab for no reason.
                if (!result.changed) return current;
                schedule(result.history.present.circuit);
                return result.history;
            });
        },
        [schedule],
    );

    const apply = useCallback((edit: (c: CircuitJson) => EditResult) => applyMany('Edit', [edit]), [applyMany]);

    /**
     * Undo and redo, which SAVE.
     *
     * An undone document is the document now — leaving it local would mean the user pressed Ctrl+Z, saw the
     * change reverse, closed the tab, and got the un-undone version back. That is the same class of surprise
     * as a dropped keystroke, so undo goes through exactly the same debounce, token and conflict path as a
     * keystroke does.
     */
    const undoOne = useCallback(() => {
        setHistory((current) => {
            if (!current) return current;
            const next = undoRevision(current);
            if (next === current) return current; // nothing to undo — not a save either
            setRefusal(null);
            schedule(next.present.circuit);
            return next;
        });
    }, [schedule]);

    const redoOne = useCallback(() => {
        setHistory((current) => {
            if (!current) return current;
            const next = redoRevision(current);
            if (next === current) return current;
            setRefusal(null);
            schedule(next.present.circuit);
            return next;
        });
    }, [schedule]);

    // ---- Getting out of a conflict --------------------------------------------------------------------

    /**
     * Keep mine: re-send WITHOUT a precondition.
     *
     * Retrying with the token the server just refused cannot ever succeed — that token is stale by
     * definition, and the conditional update will match zero rows every time. Dropping the precondition is
     * what "overwrite theirs, deliberately" actually means, and the API models exactly that: a save with no
     * `expectedUpdatedAt` is last-writer-wins. It is destructive and it is the user's explicit choice.
     */
    const overwriteWithMine = useCallback(() => {
        const state = w.current;
        const doc = state.pending ?? state.inFlight ?? history?.present.circuit ?? null;
        if (!doc || !state.projectId || state.inFlight) return;
        state.pending = null;
        void sendFor(state.projectId, doc, null, state.baseVersionId);
    }, [sendFor, history]);

    /**
     * Take theirs: ask the SERVER what it holds and adopt that.
     *
     * The first version of this only bumped a local counter, which re-adopted the cached document and
     * re-installed the token the server had already rejected — so the project became permanently unsaveable
     * and the user had lost their work for nothing. Discarding local work is only honest if what replaces it
     * is genuinely the other version.
     */
    const takeTheirs = useCallback(() => {
        const state = w.current;
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        state.pending = null;
        // Not `inFlight`: a request already on the wire cannot be recalled, and its completion is guarded by
        // the project check. The refetch below is what determines the final state.
        reloadOpened();
    }, [reloadOpened]);

    return {
        circuit: history?.present.circuit ?? null,
        source,
        save,
        refusal,
        apply,
        applyMany,
        undo: undoOne,
        redo: redoOne,
        canUndo: history !== null && canUndoRevision(history),
        canRedo: history !== null && canRedoRevision(history),
        flush,
        overwriteWithMine,
        takeTheirs,
    };
}
