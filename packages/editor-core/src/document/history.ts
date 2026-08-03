/**
 * The commit kernel: transactions, undo, redo, and the record of what each revision touched.
 *
 * Everything the editor will grow hangs off this, which is why it comes before geometry rather than after —
 * retrofitting undo onto an editor that already mutates in place is a rewrite, not a feature.
 *
 * SNAPSHOTS, NOT INVERSE COMMANDS — and here is the reasoning, because this is the choice that is expensive
 * to revisit. An inverse-command stack lets each edit describe how to reverse itself, which is what you need
 * when several people's changes interleave in one history. Ours do not: the product is deliberately
 * single-writer (the schema says so outright), the server refuses a stale save rather than merging it, and a
 * document adopted from someone else CLEARS the history rather than joining it. Under those rules a snapshot
 * stack IS per-author undo, and it is correct by construction instead of correct if every edit type
 * remembered to define its inverse. The documents are kilobytes; the memory argument does not apply at this
 * size, and the bound below keeps it that way.
 *
 * The one thing snapshots must not do is let you undo across a document you did not author — that would
 * restore state predating a colleague's save and silently resurrect it. `adopt` exists precisely to make
 * that impossible.
 *
 * ALL OR NOTHING. A commit takes a LIST of edits and applies them to a working copy; if any one is refused,
 * the whole commit is refused and the history is untouched. That is what makes a compound operation — move a
 * symbol and its wires, delete a part and its connections — safe to interrupt: there is no state in which
 * half of it happened.
 *
 * WHAT IT DOES NOT PROMISE. Rollback, not isolation. While a commit is being built the caller may well be
 * rendering the intermediate document (a drag has to draw). KiCad's own commit model draws the same line,
 * and pretending otherwise would be a claim no editor keeps.
 */
import type { CircuitJson, UiJson } from '@circuit-forge/eda-core';

import type { EditResult } from './edits';
import { sameJson } from './same-json';

/**
 * The whole editable state.
 *
 * The kernel has no OPINION about the drawing — it never inspects a position or reconciles a wire, it just
 * carries `ui` through every revision so that undo restores the arrangement along with the netlist. A
 * history that put the parts back but not where they were would be undo that scrambles the sheet.
 *
 * It is typed as `UiJson` rather than an anonymous bag, now that the drawing has a shape and a validator in
 * `eda-core`. The bag version needed a cast at every boundary, and a cast is exactly where the wrong shape
 * gets in without anything objecting — including on the way to a server that DOES validate and would
 * reject the save, one debounce after the user could still have been told.
 */
export interface EditorDocument {
    circuit: CircuitJson;
    ui: UiJson;
}

/**
 * What a revision changed, by object IDENTITY.
 *
 * Not by id, deliberately. Ids are not guaranteed unique — the object tree already treats duplicates as an
 * expected input and reports them — so a set keyed on id would silently merge two different parts into one
 * entry. Every edit is immutable and structure-sharing, so an object that did not change keeps its
 * reference: comparing before and after by reference gives the touched set exactly, with no bookkeeping for
 * an edit author to forget.
 *
 * This is the input an incremental checker needs — re-validate what moved, not the whole board — and
 * recording it now costs nothing while adding it later would touch every edit.
 */
export interface Touched {
    components: ReadonlySet<object>;
    nets: ReadonlySet<object>;
    /** True when something outside components and nets changed — metadata, UI state, the document itself. */
    other: boolean;
}

export interface Revision {
    readonly snapshot: EditorDocument;
    /** What a UI shows in an undo menu: "Rename R1", "Delete 5 components". Never generated from a diff. */
    readonly label: string;
    readonly touched: Touched;
}

export interface History {
    readonly present: EditorDocument;
    readonly past: readonly Revision[];
    readonly future: readonly Revision[];
}

/**
 * How many revisions to keep.
 *
 * A bound, because an unbounded stack is a leak that grows for as long as the tab is open — and an editor is
 * a long-lived tab. Fifty is deep enough that reaching the end is a deliberate act rather than an accident,
 * and at kilobytes per document it is a few megabytes at worst.
 */
export const HISTORY_LIMIT = 50;

export const canUndo = (history: History): boolean => history.past.length > 0;
export const canRedo = (history: History): boolean => history.future.length > 0;

const EMPTY_TOUCHED: Touched = { components: new Set(), nets: new Set(), other: false };

/** Start a history at a document. No past, no future — this is what was opened. */
export function beginHistory(opened: EditorDocument): History {
    return { present: opened, past: [], future: [] };
}

export type CommitResult =
    | {
          ok: true;
          history: History;
          changed: true;
          /**
           * What the edits destroyed on the way, in order.
           *
           * Carried through because a connectivity edit can remove something the user did not name: joining
           * two nets leaves one name where there were two. The kernel is the only place that knows it
           * happened, and a caller that could not hear it would leave the user to discover the loss later,
           * by its absence.
           */
          notes: string[];
      }
    /** Every edit was valid and none of them changed anything — never an undo entry, never a save. */
    | { ok: true; history: History; changed: false }
    /** One edit was refused, so NONE were applied. `index` is which one, for a caller that batched them. */
    | { ok: false; index: number; reason: string; message: string };

/**
 * Apply a list of edits as ONE revision.
 *
 * The edits run in order against the accumulating document, so later ones see earlier ones — which is what
 * makes "delete this part and every wire attached to it" expressible. The first refusal aborts and the
 * history is returned untouched; there is no partial commit to clean up.
 */
export function commit(
    history: History,
    label: string,
    edits: ReadonlyArray<(circuit: CircuitJson) => EditResult>,
): CommitResult {
    let circuit = history.present.circuit;
    let changed = false;
    const notes: string[] = [];

    for (const [index, edit] of edits.entries()) {
        const result = edit(circuit);
        if (!result.ok) {
            return { ok: false, index, reason: result.reason, message: result.message };
        }
        if (result.changed) {
            circuit = result.circuit;
            changed = true;
            if (result.note) notes.push(result.note);
        }
    }

    // A commit that changed nothing is not a revision. Re-typing the same value must not mint an undo step a
    // user then has to press through, nor a save that conflicts with another tab for no reason.
    if (!changed) return { ok: true, history, changed: false };

    const next: EditorDocument = { ...history.present, circuit };
    const revision: Revision = {
        snapshot: history.present, // the revision RECORDS what to go back to
        label,
        touched: touchedBetween(history.present, next),
    };

    return {
        ok: true,
        changed: true,
        notes,
        history: {
            present: next,
            past: [...history.past, revision].slice(-HISTORY_LIMIT),
            // A new edit after an undo discards the redo branch. Keeping it would let a user redo their way
            // into a document that never existed — the branch was taken, and the other one is gone.
            future: [],
        },
    };
}

/**
 * Replace the drawing as one revision — positions, rotations, wires, whatever it grows into.
 *
 * The "did anything change" test is BY VALUE, and that is load-bearing rather than a refinement. Comparing
 * by reference reads as sufficient and never fires: a caller derives the next drawing immutably — `{...ui,
 * positions: {...}}` — so it hands back a NEW object every time, including when the user dragged a symbol
 * and dropped it exactly where it was, or pressed rotate four times. Reference comparison called every one
 * of those a change, which mints an undo step that visibly does nothing AND a save that bumps the
 * concurrency token, so a second tab's real work gets refused because of a gesture that changed nothing.
 *
 * The comparison lives here rather than in each caller. A caller asking "did my drag change anything" has to
 * do exactly this work, and every caller doing it separately is several authorities on what "changed" means
 * — the day they disagree, one gesture is a revision in the undo menu and not in the save, or the reverse.
 */
export function commitUi(history: History, label: string, ui: UiJson): CommitResult {
    if (sameJson(ui, history.present.ui)) return { ok: true, history, changed: false };
    const next: EditorDocument = { ...history.present, ui };
    return {
        ok: true,
        changed: true,
        // A viewport change destroys nothing a user could go looking for later.
        notes: [],
        history: {
            present: next,
            past: [
                ...history.past,
                { snapshot: history.present, label, touched: touchedBetween(history.present, next) },
            ].slice(-HISTORY_LIMIT),
            future: [],
        },
    };
}

/** Step back. A no-op at the beginning, so a caller can bind it to a key without guarding. */
export function undo(history: History): History {
    const previous = history.past[history.past.length - 1];
    if (!previous) return history;

    return {
        present: previous.snapshot,
        past: history.past.slice(0, -1),
        future: [
            // The redo entry has to know how to get FORWARD, so it carries the document being left.
            { snapshot: history.present, label: previous.label, touched: previous.touched },
            ...history.future,
        ],
    };
}

/** Step forward. A no-op when there is nothing to redo. */
export function redo(history: History): History {
    const next = history.future[0];
    if (!next) return history;

    return {
        present: next.snapshot,
        past: [...history.past, { snapshot: history.present, label: next.label, touched: next.touched }].slice(
            -HISTORY_LIMIT,
        ),
        future: history.future.slice(1),
    };
}

/**
 * Take a document from somewhere this history did not author — the server, a project switch, a reload.
 *
 * The past and the future are DROPPED, and that is the point rather than a simplification. Undoing across an
 * adopted document would restore state that predates whatever the other author saved, quietly resurrecting
 * work they had replaced. A history is only meaningful over edits it witnessed.
 */
export function adopt(fromElsewhere: EditorDocument): History {
    return beginHistory(fromElsewhere);
}

/**
 * Which objects differ by reference between two documents.
 *
 * Reference comparison is exact BECAUSE the edits are immutable and structure-sharing: `map` builds a new
 * array but every element it did not touch is the same object. An edit author cannot forget to declare what
 * they changed, because nothing is declared — it is observed.
 */
export function touchedBetween(before: EditorDocument, after: EditorDocument): Touched {
    const components = new Set<object>();
    const nets = new Set<object>();

    const wasComponent = new Set<object>(before.circuit.components ?? []);
    for (const c of after.circuit.components ?? []) {
        if (!wasComponent.has(c)) components.add(c);
    }
    const wasNet = new Set<object>(before.circuit.nets ?? []);
    for (const n of after.circuit.nets ?? []) {
        if (!wasNet.has(n)) nets.add(n);
    }

    // Something changed outside the two collections: metadata, the UI state, or a removal (an object that
    // left leaves no new reference behind to notice, so length is what reveals it).
    const other =
        before.ui !== after.ui ||
        (before.circuit.components ?? []).length !== (after.circuit.components ?? []).length ||
        (before.circuit.nets ?? []).length !== (after.circuit.nets ?? []).length ||
        before.circuit.metadata !== after.circuit.metadata ||
        before.circuit.version !== after.circuit.version;

    return { components, nets, other };
}

/** Was anything touched at all? Useful for deciding whether a revision is worth validating. */
export const isEmptyTouch = (touched: Touched): boolean =>
    touched.components.size === 0 && touched.nets.size === 0 && !touched.other;

export { EMPTY_TOUCHED };
