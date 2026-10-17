/**
 * What the last edit COST — the things it changed that the user did not name.
 *
 * The kernel has been writing these since the connectivity work and nothing has ever displayed them. Its own
 * reason for carrying them says exactly what the silence costs: joining two nets leaves one name where there
 * were two, "and a user who is not told that VOUT ceased to exist will look for it later and conclude the
 * editor lost it."
 *
 * NOT A WARNING. Every one of these describes an edit that was made, correctly, at the user's request — the
 * refusal banner beside it is for edits that did NOT happen. Painting them the same colour would teach people
 * that a successful edit looks like a failure, and after a week of that neither one gets read.
 *
 * It clears itself on the next edit, because it is about the last one. A user who wants it gone sooner can
 * dismiss it, which is the only reason there is a control here at all.
 */

import { useState } from 'react';

export interface EditNotesProps {
    /** What the kernel said the last edit cost. Empty for the great majority of edits, which cost nothing. */
    notes: readonly string[];
}

export function EditNotes({ notes }: EditNotesProps): React.JSX.Element | null {
    // WHICH EDIT was dismissed, not THAT something was, and not what it SAID.
    //
    // A plain `dismissed: true` swallows every later edit's notes — the same silence this component exists
    // to end, only now the user believes they turned it off once rather than for good. Keying on the TEXT
    // fixed that and left a smaller version of it: `duplicateComponents` emits a note that names no ids at
    // all — "Copied 2 parts; connections among them were kept, connections to the rest of the design were
    // not." — so dismissing one copy silenced every later copy of the same size, each of which dropped
    // DIFFERENT connections. Measured: the second duplicate reported nothing.
    //
    // The array itself is the identity. `useDocument` builds a new one on every commit, so two edits are
    // never the same object however alike their words, and no effect is needed to reset anything.
    const [dismissed, setDismissed] = useState<readonly string[] | null>(null);

    if (notes.length === 0 || dismissed === notes) return null;

    return (
        <div className="notice info" role="status" data-testid="edit-notes">
            <ul>
                {notes.map((note, i) => (
                    <li key={`${i}:${note}`}>{note}</li>
                ))}
            </ul>
            <button type="button" data-testid="edit-notes-dismiss" onClick={() => setDismissed(notes)}>
                Dismiss
            </button>
        </div>
    );
}
