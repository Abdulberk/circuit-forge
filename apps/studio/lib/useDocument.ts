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
 *
 *   THE DRAWING IS PART OF THE DOCUMENT. It was not, and that was a live data-loss path rather than a missing
 *   feature: this hook sent a hard-coded `uiJson: {}` on every save, adopted `ui: {}` on every open, and the
 *   kernel's `commitUi` had no caller anywhere outside its own test. So the channel existed end to end —
 *   the schema, the validator, the database column — and the editor overwrote it with nothing 1.2 seconds
 *   after any keystroke. Anyone who arranged a schematic would have watched it survive until they typed.
 *
 * WHAT IS AND IS NOT IN THAT DRAWING — the split matters, and getting it wrong is expensive both ways.
 *
 *   POSITIONS, ROTATIONS AND WIRES are document state. Arranging twenty symbols so a circuit can be read is
 *   real work, it exists nowhere in the netlist, and a colleague opening the project must see the same
 *   arrangement. So they are saved, they are undoable, and they take the same conflict path as any edit.
 *
 *   THE VIEWPORT IS NOT, and is deliberately not written here. Where a person has scrolled is a property of
 *   the person, not of the board. Saving it would make merely LOOKING at a project a write: every pan bumps
 *   `updatedAt`, which is the concurrency token, so a second tab doing nothing but scrolling would 409 the
 *   first tab's real work — a conflict storm generated entirely by reading. It would also land in the undo
 *   stack, where Ctrl+Z would spend itself un-scrolling instead of undoing an edit. `UiJson` carries a
 *   `viewport` field and the API accepts it; this editor keeps the camera on the device instead.
 */

import type { CircuitJson, UiJson } from '@circuit-forge/eda-core';
import {
    adopt as adoptDocument,
    canRedo as canRedoRevision,
    canUndo as canUndoRevision,
    commit,
    commitUi as commitUiRevision,
    redo as redoRevision,
    sameJson,
    undo as undoRevision,
    type EditorDocument,
    type EditResult,
    type History,
} from '@circuit-forge/editor-core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, isAbort, type Api, type OpenedProject } from './api';
import { browserDraftStore, type DraftStore, type PutResult } from './draftStore';

/** How long a pause in typing counts as "done", before a save is attempted. */
const AUTOSAVE_IDLE_MS = 1_200;

/**
 * How long a pause counts as "done" for the LOCAL copy — much shorter than the save, because its whole
 * job is to be there when the tab is not.
 *
 * Not zero: serialising the document on every keystroke is work proportional to the whole circuit, and a
 * large board is a few hundred kilobytes. Coalescing at 250 ms costs at most a quarter-second of typing
 * in a hard crash, and the ordinary ways a page ends — closing, navigating, backgrounding — are covered
 * exactly by the synchronous `pagehide` flush below rather than by this timer.
 */
const LOCAL_PERSIST_MS = 250;

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
    /**
     * The drawing that goes with it — where each symbol sits and how it is turned.
     *
     * `{}` when the project has never been arranged, which is the ordinary case for a design a machine
     * wrote, and is what tells the canvas to fall back to a derived layout rather than stacking everything
     * at the origin.
     */
    ui: UiJson;
    /** Where it came from — a draft, a saved version, or nothing yet. */
    source: OpenedProject['source'] | null;
    save: SaveState;
    /** The last refusal from an edit, for the field that caused it. Cleared by the next successful edit. */
    refusal: { reason: string; message: string } | null;
    /**
     * What the last edit COST, beyond what it changed.
     *
     * A connectivity edit can destroy something the user never named: joining two nets leaves one name
     * where there were two. That is not a refusal — the edit was right and it happened — but it is not
     * silence either, because a user who is not told that VOUT ceased to exist will look for it later.
     * Replaced on every commit, so it always describes the action just taken.
     */
    notes: readonly string[];
    /**
     * Apply an edit. Takes the edit FUNCTION rather than a patch, so validation lives in the kernel and this
     * hook never has to know what a designator is.
     */
    apply: (edit: (circuit: CircuitJson) => EditResult) => void;
    /** Apply several edits as ONE revision — one undo step, and impossible to half-apply. */
    applyMany: (label: string, edits: ReadonlyArray<(circuit: CircuitJson) => EditResult>) => void;
    /**
     * Replace the drawing as ONE revision — a symbol moved, a symbol turned, a wire drawn.
     *
     * Takes the whole `UiJson` rather than a patch for the same reason `apply` takes a function: there is
     * one authority for what the drawing is, and a merge invented here would be a second one. Callers
     * derive the next drawing from `ui` and hand it back.
     *
     * A drag must call this ONCE, on release. Calling it per pointer-move would mint sixty revisions for one
     * gesture, so Ctrl+Z would walk the symbol back a pixel at a time and the save debounce would never
     * settle while the mouse was down.
     */
    commitUi: (label: string, next: UiJson) => void;
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

    /**
     * Unsaved work found ON THIS DEVICE when the project opened — an OFFER, never applied automatically.
     *
     * Restoring it silently is the failure mode that matters: a tab holding an older copy would overwrite
     * a colleague's saved work while looking like it rescued yours. `continuesServerDraft` is what lets
     * the offer be worded honestly — true means this work was typed on top of exactly what the server
     * still holds ("your unsaved changes"), false means the server has moved on since ("work based on an
     * older version"), and those two deserve different words and different confidence.
     */
    recovery: { circuit: CircuitJson; ui: UiJson; at: string; continuesServerDraft: boolean } | null;
    /** Adopt the recovered document as the current one. It becomes dirty and saves like any other edit. */
    recoverLocal: () => void;
    /** Throw the local copy away and keep what the server sent. */
    discardLocal: () => void;
    /**
     * Whether unsaved work is actually being kept on this device.
     *
     * Reported rather than assumed. `localStorage` throws when the origin is out of quota and in some
     * private-browsing modes, and a user who believes their work is backed up when it is not will make
     * different decisions than one who knows. Silence here would be the lie.
     */
    localBackup: PutResult;
}

export function useDocument(
    api: Api,
    projectId: string | null,
    opened: OpenedProject | null,
    /** Re-fetch the project. Required, because "load theirs" is meaningless without asking the server. */
    reloadOpened: () => void,
    /**
     * Where unsaved work is kept on this device. Injected for the same reason the token store is: the
     * decision stays visible at the composition root, and tests can install one that refuses every write
     * so the "your work is NOT being backed up" path is exercised rather than assumed.
     */
    draftStore?: DraftStore,
): DocumentState {
    /**
     * PINNED for the life of the hook, and not a default parameter.
     *
     * `draftStore: DraftStore = browserDraftStore()` reads correctly and is wrong: a default expression is
     * evaluated on EVERY render, so the store arrives as a new object identity each time, which invalidates
     * every callback that depends on it — `sendFor`, `flush`, `schedule` — and through them the effects
     * that depend on those. The suite went from green to nine failures and five-second timeouts, which is
     * the render loop that produces. Creating it once is also the honest model: a store swapped mid-life
     * would leave half the session's work in one place and half in another.
     */
    const storeRef = useRef<DraftStore | null>(null);
    if (!storeRef.current) storeRef.current = draftStore ?? browserDraftStore();
    const store = storeRef.current;

    const [history, setHistory] = useState<History | null>(null);
    const [source, setSource] = useState<OpenedProject['source'] | null>(null);
    const [save, setSave] = useState<SaveState>({ status: 'clean', savedAt: null });
    const [refusal, setRefusal] = useState<DocumentState['refusal']>(null);
    const [notes, setNotes] = useState<readonly string[]>([]);
    const [recovery, setRecovery] = useState<DocumentState['recovery']>(null);
    const [localBackup, setLocalBackup] = useState<PutResult>({ ok: true });

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
        /**
         * Edited but not yet sent — the whole document, circuit AND drawing.
         *
         * One value rather than two queues on purpose: they are saved by the same request, so a split
         * would let a circuit change and the drawing that explains it reach the server in different
         * writes, and a crash between them would store a netlist whose layout describes a different one.
         */
        pending: EditorDocument | null;
        /** Currently being sent. Non-null means a save is open and nothing else may start. */
        inFlight: EditorDocument | null;
        timer: ReturnType<typeof setTimeout> | null;
        /** Edited but not yet written to this device — coalesced separately from the save. */
        unpersisted: EditorDocument | null;
        persistTimer: ReturnType<typeof setTimeout> | null;
        alive: boolean;
    }>({
        projectId: null,
        token: null,
        baseVersionId: null,
        pending: null,
        inFlight: null,
        timer: null,
        unpersisted: null,
        persistTimer: null,
        alive: true,
    });

    useEffect(() => {
        const state = w.current;
        state.alive = true;
        return () => {
            state.alive = false;
        };
    }, []);

    // ---- The copy that survives this tab --------------------------------------------------------------

    /**
     * Write the current document to this device, now.
     *
     * Synchronous on purpose — it is called from `pagehide`, which is the last callback a page reliably
     * gets, and an async write started there has no promise that it finishes.
     */
    const persistNow = useCallback(() => {
        const state = w.current;
        if (state.persistTimer) {
            clearTimeout(state.persistTimer);
            state.persistTimer = null;
        }
        const doc = state.unpersisted;
        if (!doc || !state.projectId) return;
        state.unpersisted = null;
        const result = store.put({
            projectId: state.projectId,
            circuit: doc.circuit,
            ui: doc.ui,
            baseToken: state.token,
            baseVersionId: state.baseVersionId,
            at: new Date().toISOString(),
        });
        // Only surface a CHANGE, and never from inside a page-teardown callback where a setState is
        // pointless. `state.alive` is the same guard the save path uses for the same reason.
        if (state.alive) setLocalBackup((prev) => (prev.ok === result.ok ? prev : result));
    }, [store]);

    // The ordinary ways a page ends — closing the tab, navigating away, the OS backgrounding a phone —
    // all deliver `pagehide` and none of them wait for a debounce. `beforeunload` is deliberately not
    // used: it does not fire on mobile, and browsers restrict what may happen inside it.
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const onHide = () => persistNow();
        window.addEventListener('pagehide', onHide);
        return () => window.removeEventListener('pagehide', onHide);
    }, [persistNow]);

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
        //
        // `opened.uiJson`, never `{}`. Hard-coding the empty drawing here is what made the round trip
        // one-way: the server could hold a perfectly good arrangement and the editor would open blank,
        // then send that blank back over it on the first autosave.
        setHistory(
            opened.source === 'empty' ? null : adoptDocument({ circuit: opened.circuitJson, ui: opened.uiJson }),
        );
        setSource(opened.source);
        setSave({ status: 'clean', savedAt: opened.source === 'working-copy' ? opened.updatedAt : null });
        setRefusal(null);
        setNotes([]);

        // Is there work on this device the server never received?
        //
        // OFFERED, never applied. Restoring automatically is the one behaviour that turns a safety net into
        // a hazard: a tab reopened after someone else saved would put its own older document back on screen
        // and then save it over theirs, and it would look like recovery working.
        // The decision uses ONLY the concurrency token, never a clock. An earlier version compared the
        // local write time against the server's `updatedAt` to decide whether a copy was stale, which reads
        // sensibly and cannot work: those two timestamps come from different machines, and a client whose
        // clock is a day behind would silently delete real unsaved work. The token is the one value both
        // sides agree on by construction.
        const local = store.get(projectId);
        const serverToken = opened.source === 'working-copy' ? opened.updatedAt : null;

        const openedCircuit = opened.source === 'empty' ? null : opened.circuitJson;
        const openedUi = opened.source === 'empty' ? null : opened.uiJson;

        if (!local) {
            setRecovery(null);
        } else if (
            openedCircuit !== null &&
            // STRUCTURAL, not `JSON.stringify`. Both of these values come back from a Postgres `jsonb`
            // column, which does not preserve the key order it was given — it sorts keys by length and then
            // bytewise, measured against the live API. The local copy is written by this browser in
            // insertion order. So a stringify comparison reports "different" for two identical documents,
            // and this branch — "the server already has exactly this, nothing to rescue" — could never fire:
            // every open would offer unsaved work that does not exist, and the user has to decide about it.
            sameJson(local.circuit, openedCircuit) &&
            // The DRAWING counts as content here too. Comparing only the netlist would throw away a local
            // copy whose sole unsaved change was an arrangement — the user's twenty drags — and report
            // nothing to rescue, because the components and nets did match.
            sameJson(local.ui ?? {}, openedUi ?? {})
        ) {
            // Nothing to rescue: the server already has exactly this. Offering it would be noise, and this
            // is decidable from the documents themselves rather than from any assumption about time.
            store.clear(projectId);
            setRecovery(null);
        } else {
            // Otherwise it IS unsaved work and gets offered — the only question is how confidently. Built
            // on exactly what the server still holds, it is simply "your unsaved changes". Built on a draft
            // the server has since replaced, adopting it discards whatever came after, and the wording
            // downstream depends on knowing which. Never dropped on a guess: erring toward offering costs
            // a dialog, erring the other way costs the work.
            setRecovery({
                circuit: local.circuit,
                ui: local.ui ?? {},
                at: local.at,
                continuesServerDraft: local.baseToken === serverToken,
            });
        }
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
            doc: EditorDocument,
            token: string | null,
            baseVersionId: string | null,
        ): Promise<void> => {
            const state = w.current;
            state.inFlight = doc;
            if (state.projectId === forProject) setSave({ status: 'saving' });

            try {
                const saved = await api.saveWorkingCopy(forProject, {
                    circuitJson: doc.circuit,
                    // The drawing, in the SAME request as the netlist it describes. Two requests would be
                    // two chances to fail, and the failure would store a circuit whose saved arrangement
                    // belongs to a different one.
                    uiJson: doc.ui,
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
                    // The server now holds this work, so the local copy has nothing left to rescue and
                    // keeping it would offer a stale document back on the next open. Cleared ONLY here,
                    // where the document is genuinely safe elsewhere — never on a failure, and never when
                    // more edits are already queued behind this save.
                    state.unpersisted = null;
                    if (state.persistTimer) {
                        clearTimeout(state.persistTimer);
                        state.persistTimer = null;
                    }
                    store.clear(forProject);
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
        [api, store],
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
        (doc: EditorDocument) => {
            const state = w.current;
            state.pending = doc;
            setSave((s) => (s.status === 'conflict' ? s : { status: 'dirty' }));
            if (state.timer) clearTimeout(state.timer);
            state.timer = setTimeout(() => {
                state.timer = null;
                flush();
            }, AUTOSAVE_IDLE_MS);

            // The local copy runs on its own, much shorter clock. It must NOT wait for the save: the whole
            // point is to hold what the server does not have yet, and a failed or refused save leaves the
            // document unsent for as long as the problem lasts.
            state.unpersisted = doc;
            if (state.persistTimer) clearTimeout(state.persistTimer);
            state.persistTimer = setTimeout(persistNow, LOCAL_PERSIST_MS);
        },
        [flush, persistNow],
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
                setNotes([]);
                // Replaced, never appended: these describe what the LAST action cost, and a growing list
                // would leave a user reading about a merge they made ten edits ago.
                setNotes(result.changed ? result.notes : []);
                // A commit that changed nothing is not a save and not an undo step — re-typing the same value
                // must not mint a revision that then conflicts with another tab for no reason.
                if (!result.changed) return current;
                schedule(result.history.present);
                return result.history;
            });
        },
        [schedule],
    );

    const apply = useCallback((edit: (c: CircuitJson) => EditResult) => applyMany('Edit', [edit]), [applyMany]);

    /**
     * Move, turn, wire — the drawing, as one revision that saves like any other edit.
     *
     * Routed through the SAME commit kernel as a circuit edit rather than a separate lane, so a drag lands
     * in the same undo stack in the same order as the delete that followed it. Two stacks would let Ctrl+Z
     * un-move something without un-deleting what was deleted after it.
     */
    const commitUi = useCallback(
        (label: string, next: UiJson) => {
            setHistory((current) => {
                if (!current) return current;
                const result = commitUiRevision(current, label, next);
                // `commitUiRevision` cannot refuse — it replaces opaque state — but it CAN report no change,
                // and a drag that ends where it started must not mint a revision or a save.
                if (!result.ok || !result.changed) return current;
                setRefusal(null);
                setNotes([]);
                schedule(result.history.present);
                return result.history;
            });
        },
        [schedule],
    );

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
            setNotes([]);
            schedule(next.present);
            return next;
        });
    }, [schedule]);

    const redoOne = useCallback(() => {
        setHistory((current) => {
            if (!current) return current;
            const next = redoRevision(current);
            if (next === current) return current;
            setRefusal(null);
            setNotes([]);
            schedule(next.present);
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
        const doc = state.pending ?? state.inFlight ?? history?.present ?? null;
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

    /**
     * Take the recovered document as the current one.
     *
     * ADOPT, not commit — the same reasoning the loader uses. Recovered work was typed in a session this
     * history never witnessed, so undoing across it would step back into a document that never existed
     * here. It is then scheduled like an ordinary edit, which is what makes it reach the server: the local
     * copy is a rescue buffer, not a place work is allowed to live.
     */
    const recoverLocal = useCallback(() => {
        const state = w.current;
        const found = recovery;
        if (!found || !state.projectId) return;
        setHistory(adoptDocument({ circuit: found.circuit, ui: found.ui }));
        setRecovery(null);
        setRefusal(null);
        setNotes([]);
        schedule({ circuit: found.circuit, ui: found.ui });
    }, [recovery, schedule]);

    const discardLocal = useCallback(() => {
        const state = w.current;
        if (state.projectId) store.clear(state.projectId);
        // Also drop anything queued for the local writer, or the copy just discarded would be written
        // straight back when the coalescing timer fires.
        state.unpersisted = null;
        if (state.persistTimer) {
            clearTimeout(state.persistTimer);
            state.persistTimer = null;
        }
        setRecovery(null);
    }, [store]);

    return {
        circuit: history?.present.circuit ?? null,
        ui: history?.present.ui ?? {},
        source,
        save,
        refusal,
        notes,
        apply,
        applyMany,
        commitUi,
        undo: undoOne,
        redo: redoOne,
        canUndo: history !== null && canUndoRevision(history),
        canRedo: history !== null && canRedoRevision(history),
        flush,
        overwriteWithMine,
        takeTheirs,
        recovery,
        recoverLocal,
        discardLocal,
        localBackup,
    };
}
