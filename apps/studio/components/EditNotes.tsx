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
    // WHAT was dismissed, not THAT something was. A plain `dismissed: true` swallows every later edit's notes
    // as well — the same silence this component exists to end, only now the user believes they turned it off
    // once rather than for good. Holding the text means the next edit, whose text differs, shows.
    //
    // No effect resets it, because the comparison already does: the next edit's notes are a different key.
    // An effect here would be a second mechanism for one thing and an extra render for nothing — it was
    // written, and a mutation test that removed it stayed green, which is how it was found doing neither.
    const key = notes.join(' ');
    const [dismissed, setDismissed] = useState<string | null>(null);

    if (notes.length === 0 || dismissed === key) return null;

    return (
        <div className="notice info" role="status" data-testid="edit-notes">
            <ul>
                {notes.map((note, i) => (
                    <li key={`${i}:${note}`}>{note}</li>
                ))}
            </ul>
            <button type="button" data-testid="edit-notes-dismiss" onClick={() => setDismissed(key)}>
                Dismiss
            </button>
        </div>
    );
}
