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
    const { save, recovery } = doc;

    // Ahead of everything else, because it is about work that exists NOWHERE ELSE. A conflict is two saved
    // documents disagreeing; this is one unsaved document that survived a tab closing, and it is gone the
    // moment the user edits over it.
    if (recovery) {
        return (
            <div className="notice bad" role="alert">
                <h4>Unsaved work found on this device</h4>
                {recovery.continuesServerDraft ? (
                    <>
                        Changes from {new Date(recovery.at).toLocaleString()} never reached the server — the tab
                        probably closed before they were saved. They continue exactly the draft that is open now.
                    </>
                ) : (
                    <>
                        Changes from {new Date(recovery.at).toLocaleString()} never reached the server, and the draft
                        has been saved by someone since. Restoring them replaces what is on screen with your older work
                        — anything saved after it would have to be redone.
                    </>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button onClick={doc.recoverLocal}>Restore my unsaved work</button>
                    <button onClick={doc.discardLocal}>Discard it, keep what is open</button>
                </div>
            </div>
        );
    }

    if (save.status === 'conflict') {
        return (
            <div className="notice bad" role="alert">
                <h4>Someone else saved first</h4>
                Your changes are still here and have NOT been sent. The copy on the server was updated
                {save.theirUpdatedAt ? ` at ${time(save.theirUpdatedAt)}` : ''} by another tab or another person.
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    {/* `overwriteWithMine`, NOT a retry. Re-sending with the token the server just refused
                        can never succeed — it is stale by definition and the conditional update matches zero
                        rows every time. Forcing the save means dropping the precondition, which is a
                        deliberate overwrite of someone else's work and is labelled as one. */}
                    <button onClick={doc.overwriteWithMine}>Save mine, overwrite theirs</button>
                    <button onClick={doc.takeTheirs}>Discard mine, load theirs</button>
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

    return (
        <span style={{ color: save.status === 'dirty' ? 'var(--warn)' : 'var(--text-faint)' }}>
            {/* WHAT THE LAST EDIT COST IS NOT SHOWN HERE ANY MORE. It used to be, wedged above the save
                label under a `warn` class that globals.css does not define — so it drew as unstyled status
                text in a corner of the footer, and it put "your edit merged two nets" inside the indicator
                whose whole job is whether the server has your work. Two different questions under one
                heading. It now sits beside the drawing, where the edit happened, with the refusal banner and
                the rule check. ONE surface: two of them is the drift this codebase keeps paying for. */}
            {label}
            {/* Only ever shown when it is FALSE. A permanent "backed up ✓" is the badge people stop reading,
                and the only reason this exists is that "unsaved changes" means something different when
                nothing is holding them: on this browser they would not survive the tab. */}
            {!doc.localBackup.ok && (
                <span className="warn" title={doc.localBackup.message}>
                    {' '}
                    · not kept on this device
                </span>
            )}
        </span>
    );
}
