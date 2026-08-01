'use client';

/**
 * Whether the user's work is safe, said plainly and continuously.
 *
 * An autosaving editor asks the user to trust something they cannot see. The states that matter are not
 * "saving" — that one is noise — but the two at the ends: everything is on the server, or it is NOT and
 * something is wrong. A conflict in particular must be unmissable and must never resolve itself: the local
 * document is still on screen and still the user's, and the only two honest options are theirs or yours.
 */
import type { DocumentState } from '../lib/useDocument';

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString() : null);

export function SaveStatus({ doc }: { doc: DocumentState }) {
    const { save } = doc;

    if (save.status === 'conflict') {
        return (
            <div className="notice bad" role="alert">
                <h4>Someone else saved first</h4>
                Your changes are still here and have NOT been sent. The copy on the server was updated
                {save.theirUpdatedAt ? ` at ${time(save.theirUpdatedAt)}` : ''} by another tab or another person.
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button onClick={doc.flush}>Save mine anyway</button>
                    <button onClick={doc.discardLocalAndReload}>Discard mine, load theirs</button>
                </div>
            </div>
        );
    }

    if (save.status === 'error') {
        return (
            <div className="notice bad" role="alert">
                <h4>Not saved</h4>
                {save.error.message}
                {save.error.retryable && (
                    <div style={{ marginTop: 8 }}>
                        <button onClick={doc.flush}>Try again</button>
                    </div>
                )}
            </div>
        );
    }

    // The quiet states live in the status bar rather than in a box, because an editor that shows a panel for
    // "saved" trains people to ignore panels.
    const label =
        save.status === 'saving'
            ? 'saving…'
            : save.status === 'dirty'
              ? 'unsaved changes'
              : save.savedAt
                ? `saved ${time(save.savedAt)}`
                : 'no changes yet';

    return <span style={{ color: save.status === 'dirty' ? 'var(--warn)' : 'var(--text-faint)' }}>{label}</span>;
}
